import * as originalFs from 'node:fs';
import { relative, resolve } from 'node:path';
import { mock } from 'node:test';

import { installB3CaptureStateRootMock } from './b3-capture-state-install-root-mock.mjs';

const input = JSON.parse(Buffer.from(process.argv[2], 'base64url').toString('utf8'));
installB3CaptureStateRootMock();

if (input.__testFault || input.__testMetadata) {
  const fault = input.__testFault;
  const metadata = input.__testMetadata;
  const target = fault ? resolve(process.cwd(), fault.relativePath) : null;
  let fired = false;
  function retainedMetadata(path, value) {
    if (!metadata) return value;
    const identity = metadata.identityByRelativePath?.[relative(process.cwd(), path)];
    return new Proxy(value, {
      get(original, key) {
        if (key === 'dev') return metadata.device;
        if (identity && Object.hasOwn(identity, key)) return identity[key];
        const retained = Reflect.get(original, key, original);
        return typeof retained === 'function' ? retained.bind(original) : retained;
      },
    });
  }
  mock.module('node:fs', {
    namedExports: {
      closeSync: originalFs.closeSync,
      constants: originalFs.constants,
      fstatSync(descriptor) {
        return retainedMetadata(`/descriptor/${descriptor}`, originalFs.fstatSync(descriptor));
      },
      fsyncSync: originalFs.fsyncSync,
      lstatSync(path) {
        if (!fired && fault?.kind === 'replace-member-before-pathname-check' &&
            resolve(path) === target) {
          fired = true;
          const bytes = originalFs.readFileSync(path);
          originalFs.renameSync(path, `${path}.replaced`);
          originalFs.writeFileSync(path, bytes, { mode: 0o600 });
          originalFs.chmodSync(path, 0o600);
        }
        return retainedMetadata(path, originalFs.lstatSync(path));
      },
      mkdirSync: originalFs.mkdirSync,
      openSync: originalFs.openSync,
      readSync: originalFs.readSync,
      readdirSync(path, options) {
        const entries = originalFs.readdirSync(path, options);
        if (!fired && fault?.kind === 'replace-directory-after-readdir' &&
            resolve(path) === target) {
          fired = true;
          originalFs.renameSync(path, `${path}.replaced`);
          originalFs.mkdirSync(path, { mode: 0o700 });
          originalFs.chmodSync(path, 0o700);
        }
        return entries;
      },
      realpathSync: originalFs.realpathSync,
      renameSync: originalFs.renameSync,
      unlinkSync: originalFs.unlinkSync,
    },
  });
}

const {
  classifyB3CaptureBundleRootState,
  inspectB3CaptureBundleInventory,
  validateB3CaptureBundleComposite,
} = await import(
  '../../scripts/lib/b3-capture-bundle-store.mjs'
);

try {
  const operation = input.__testOperation ?? 'inventory';
  delete input.__testOperation;
  delete input.__testFault;
  delete input.__testMetadata;
  let result;
  if (operation === 'root-state') {
    result = classifyB3CaptureBundleRootState(input);
  } else if (operation === 'composite') {
    const { databaseState, ...rootInput } = input;
    const rootState = classifyB3CaptureBundleRootState(rootInput);
    result = validateB3CaptureBundleComposite({ databaseState, rootState });
  } else {
    result = inspectB3CaptureBundleInventory(input);
  }
  process.stdout.write(`${JSON.stringify({ ok: true, result })}\n`);
} catch (error) {
  process.stdout.write(`${JSON.stringify({
    ok: false,
    code: error?.code ?? null,
    message: error?.message ?? String(error),
  })}\n`);
}
