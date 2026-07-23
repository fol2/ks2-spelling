import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export async function hashFileBundleInput(path) {
  const bytes = await readFile(path);
  return Object.freeze({
    kind: 'file-sha256',
    sha256: sha256(bytes),
    byteSize: bytes.length,
  });
}

async function directoryFiles(root, directory = root) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await directoryFiles(root, path));
    else if (entry.isFile()) files.push(path);
    else throw new Error('The application bundle contains a non-regular entry.');
  }
  return files.toSorted((left, right) => relative(root, left).localeCompare(relative(root, right)));
}

export async function hashDirectoryBundleInput(path) {
  const digest = createHash('sha256');
  const files = await directoryFiles(path);
  let byteSize = 0;
  for (const file of files) {
    const bytes = await readFile(file);
    const name = relative(path, file).replaceAll('\\', '/');
    digest.update(name).update('\0').update(String(bytes.length)).update('\0').update(bytes);
    byteSize += bytes.length;
  }
  return Object.freeze({
    kind: 'directory-sha256',
    sha256: digest.digest('hex'),
    fileCount: files.length,
    byteSize,
  });
}
