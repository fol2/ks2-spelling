import { execFile } from 'node:child_process';
import { lstat } from 'node:fs/promises';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const PINNED_SYSTEM_GIT = '/usr/bin/git';

async function assertPinnedSystemGit(gitStatReader) {
  if (!['darwin', 'linux'].includes(process.platform)) {
    throw new Error('pinned Git failed secure validation');
  }
  let stats;
  try {
    stats = await gitStatReader(PINNED_SYSTEM_GIT, { bigint: true });
  } catch {
    throw new Error('pinned Git failed secure validation');
  }
  if (
    !stats.isFile() ||
    stats.isSymbolicLink() ||
    stats.uid !== 0n ||
    (stats.mode & 0o022n) !== 0n ||
    (stats.mode & 0o111n) === 0n
  ) {
    throw new Error('pinned Git failed secure validation');
  }
}

export async function runPinnedSystemGit(
  args,
  {
    root,
    encoding = 'utf8',
    timeout = 5_000,
    maxBuffer = 64 * 1024,
    execFileImpl = execFileAsync,
    gitStatReader = lstat,
  } = {},
) {
  if (!Array.isArray(args) || args.some((entry) => typeof entry !== 'string')) {
    throw new Error('pinned Git failed secure validation');
  }
  await assertPinnedSystemGit(gitStatReader);
  return execFileImpl(PINNED_SYSTEM_GIT, args, {
    cwd: root,
    env: {
      PATH: '/usr/bin:/bin',
      LANG: 'C',
      LC_ALL: 'C',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_TERMINAL_PROMPT: '0',
      GIT_NO_REPLACE_OBJECTS: '1',
    },
    encoding,
    timeout,
    maxBuffer,
    windowsHide: true,
  });
}
