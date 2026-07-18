import { runPinnedSystemGit } from './pinned-system-git.mjs';

export const B2_FROZEN_COMMIT = '39ef90a5a33efb41368272c4c6d4d002f04658b3';

export async function readFrozenB2Blob({
  root,
  path,
  execFileImpl,
  gitStatReader,
} = {}) {
  if (
    typeof root !== 'string' ||
    typeof path !== 'string' ||
    path.length === 0 ||
    path.startsWith('/') ||
    path.split('/').includes('..')
  ) {
    throw new Error('Frozen B2 committed input is unavailable');
  }
  try {
    const { stdout } = await runPinnedSystemGit(
      ['cat-file', 'blob', `${B2_FROZEN_COMMIT}:${path}`],
      {
        root,
        encoding: 'buffer',
        timeout: 5_000,
        maxBuffer: 16 * 1024 * 1024,
        execFileImpl,
        gitStatReader,
      },
    );
    return Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout);
  } catch {
    throw new Error(`Frozen B2 committed input is unavailable: ${path}`);
  }
}
