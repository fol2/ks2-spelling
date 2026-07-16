import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export const B3_CAPTURE_STATE_REPOSITORY_ROOT = resolve(
  fileURLToPath(new URL('../..', import.meta.url)),
);
