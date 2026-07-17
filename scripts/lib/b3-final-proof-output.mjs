import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { link, lstat, mkdir, open, realpath, rm } from 'node:fs/promises';
import { resolve } from 'node:path';

const OUTPUTS = new Set([
  'reports/b3/cloudflare-sandbox-proof.json',
  'reports/b3/ios-sandbox-proof.json',
  'reports/b3/ios-sandbox-proof.png',
  'reports/b3/android-sandbox-proof.json',
  'reports/b3/android-sandbox-proof.png',
  'reports/b3/b3-exit-report.json',
]);
const MAXIMUM_OUTPUT_BYTES = 64 * 1024 * 1024;
const TRANSIENT_LINK_ATTEMPTS = 8;
const TRANSIENT_LINK_WAIT_MS = 10;

function outputError(message) {
  return Object.assign(new Error(message), { code: 'b3_final_proof_output_conflict' });
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function syncDirectory(directory) {
  const handle = await open(
    directory,
    fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
  );
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function validateDirectory(metadata) {
  if (!metadata.isDirectory() || metadata.isSymbolicLink() ||
      (metadata.mode & 0o022) !== 0) {
    throw outputError('B3 final proof output directory policy is invalid');
  }
}

async function createOrValidateDirectory(parent, component) {
  const path = resolve(parent, component);
  let created = false;
  try {
    await mkdir(path, { mode: 0o700 });
    created = true;
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  }
  validateDirectory(await lstat(path));
  if (created) await syncDirectory(parent);
  if (await realpath(path) !== path) {
    throw outputError('B3 final proof output directory escaped its authority');
  }
  return path;
}

async function ensureOutputDirectory(root) {
  const canonicalRoot = await realpath(resolve(root));
  validateDirectory(await lstat(canonicalRoot));
  const reports = await createOrValidateDirectory(canonicalRoot, 'reports');
  return createOrValidateDirectory(reports, 'b3');
}

async function readBoundedFinal(handle, expectedSize) {
  const bytes = Buffer.allocUnsafe(expectedSize + 1);
  let offset = 0;
  while (offset < bytes.length) {
    const { bytesRead } = await handle.read(
      bytes,
      offset,
      bytes.length - offset,
      offset,
    );
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  return bytes.subarray(0, offset);
}

async function readExistingFinal(path, expectedBytes) {
  let handle;
  try {
    handle = await open(
      path,
      fsConstants.O_RDONLY |
        (fsConstants.O_NONBLOCK ?? 0) |
        (fsConstants.O_NOFOLLOW ?? 0),
    );
  } catch (error) {
    if (['ELOOP', 'ENXIO', 'EACCES'].includes(error?.code)) {
      throw outputError('B3 final proof output link or file policy is invalid');
    }
    throw error;
  }
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.isSymbolicLink() ||
        ![1, 2].includes(before.nlink) || (before.mode & 0o022) !== 0 ||
        before.size <= 0 || before.size > MAXIMUM_OUTPUT_BYTES) {
      throw outputError('B3 final proof output file or link policy is invalid');
    }
    const bytes = await readBoundedFinal(handle, before.size);
    const after = await handle.stat();
    if (!after.isFile() || after.dev !== before.dev || after.ino !== before.ino ||
        after.size !== before.size || after.mtimeMs !== before.mtimeMs ||
        (after.mode & 0o022) !== 0 ||
        bytes.length !== before.size || !bytes.equals(expectedBytes)) {
      throw outputError('B3 final proof output bytes conflict');
    }
    return after.nlink;
  } finally {
    await handle.close();
  }
}

async function validateExistingFinal(path, expectedBytes) {
  for (let attempt = 0; attempt < TRANSIENT_LINK_ATTEMPTS; attempt += 1) {
    const links = await readExistingFinal(path, expectedBytes);
    if (links === 1) return;
    if (attempt < TRANSIENT_LINK_ATTEMPTS - 1) {
      await new Promise((resolveWait) => setTimeout(resolveWait, TRANSIENT_LINK_WAIT_MS));
    }
  }
  throw outputError('B3 final proof output has a persistent hard-link conflict');
}

export async function publishB3FinalProofOutput({ root, output, bytes: rawBytes } = {}) {
  if (!OUTPUTS.has(output) ||
      !(Buffer.isBuffer(rawBytes) || rawBytes instanceof Uint8Array) ||
      rawBytes.byteLength <= 0 || rawBytes.byteLength > MAXIMUM_OUTPUT_BYTES) {
    throw outputError('B3 final proof output identity or bytes are invalid');
  }
  // Snapshot caller-owned bytes before the first asynchronous boundary.
  const bytes = Buffer.from(rawBytes);
  const digest = sha256(bytes);
  const directory = await ensureOutputDirectory(root);
  const path = resolve(directory, output.slice('reports/b3/'.length));
  const temporary = resolve(directory, `.${randomUUID()}.b3-final-proof.tmp`);
  let created = false;
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.chmod(0o600);
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await link(temporary, path);
      created = true;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
  } finally {
    await rm(temporary, { force: true });
  }
  await syncDirectory(directory);
  await validateExistingFinal(path, bytes);
  return Object.freeze({
    path: output,
    sha256: digest,
    status: created ? 'created' : 'identical',
  });
}
