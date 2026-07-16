import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  renameSync,
} from 'node:fs';
import { relative, resolve } from 'node:path';

import { installB3CaptureStateRootMock } from './b3-capture-state-install-root-mock.mjs';

const input = JSON.parse(Buffer.from(process.argv[2], 'base64url').toString('utf8'));
installB3CaptureStateRootMock();

const {
  classifyB3CaptureBundleRootState,
  materialiseB3EmptyWorkingBundle,
} = await import('../../scripts/lib/b3-capture-bundle-store.mjs');

function exactMkdir(path) {
  mkdirSync(path, { mode: 0o700 });
  chmodSync(path, 0o700);
}

function snapshot(root) {
  const rows = [];
  function visit(path) {
    const metadata = lstatSync(path);
    rows.push({
      relativePath: relative(root, path) || '.',
      dev: metadata.dev,
      ino: metadata.ino,
      mode: metadata.mode,
      nlink: metadata.nlink,
      size: metadata.size,
      type: metadata.isDirectory() ? 'directory' : 'other',
    });
    if (metadata.isDirectory()) {
      for (const name of readdirSync(path).sort()) visit(resolve(path, name));
    }
  }
  visit(root);
  return rows;
}

const evidence = resolve('.native-build', 'b3', 'evidence');
const bundles = resolve(evidence, `${input.platform}-capture-bundles`);
const working = resolve(bundles, `${input.captureId}.working`);
const rootState = classifyB3CaptureBundleRootState({ platform: input.platform });

if (input.mutation === 'replace-root') {
  renameSync(bundles, resolve(evidence, `${input.platform}-capture-bundles.retained`));
  exactMkdir(bundles);
  exactMkdir(working);
  for (const name of ['observations', 'checkpoint', 'derived']) {
    exactMkdir(resolve(working, name));
  }
} else if (input.mutation === 'replace-present-child') {
  renameSync(
    resolve(working, 'observations'),
    resolve(evidence, `${input.captureId}.retained-observations`),
  );
  exactMkdir(resolve(working, 'observations'));
} else {
  throw new Error('B3 capture bundle ABA test mutation is invalid');
}

const before = snapshot(evidence);
try {
  const result = materialiseB3EmptyWorkingBundle({
    platform: input.platform,
    captureId: input.captureId,
    rootState,
  });
  process.stdout.write(`${JSON.stringify({
    ok: true,
    result,
    before,
    after: snapshot(evidence),
  })}\n`);
} catch (error) {
  process.stdout.write(`${JSON.stringify({
    ok: false,
    error: { code: error?.code ?? null, message: error?.message ?? String(error) },
    before,
    after: snapshot(evidence),
  })}\n`);
}
