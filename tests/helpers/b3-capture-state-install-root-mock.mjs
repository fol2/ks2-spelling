import { mock } from 'node:test';
import { resolve } from 'node:path';

export function installB3CaptureStateRootMock() {
  mock.module(
    new URL('../../scripts/lib/b3-capture-state-location.mjs', import.meta.url),
    {
      namedExports: {
        B3_CAPTURE_STATE_REPOSITORY_ROOT: resolve(process.cwd()),
      },
    },
  );
}
