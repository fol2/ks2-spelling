import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const APPROVED_RELEASE_CHANNELS = Object.freeze(['sandbox', 'production']);

export async function verifyReleaseChannelPair({ releaseChannel, webDirectory }) {
  if (!APPROVED_RELEASE_CHANNELS.includes(releaseChannel)) {
    throw new TypeError('Native release channel is invalid.');
  }
  if (typeof webDirectory !== 'string' || webDirectory.length === 0) {
    throw new TypeError('Web artefact directory is invalid.');
  }

  let authority;
  try {
    authority = JSON.parse(
      await readFile(resolve(webDirectory, 'release-channel.json'), 'utf8'),
    );
  } catch (error) {
    const html = await readFile(resolve(webDirectory, 'index.html'), 'utf8');
    if (/name=["']ks2-spelling-build-mode["'][^>]+content=["']B4Development["']/u.test(html)) {
      return Object.freeze({ buildMode: 'B4Development' });
    }
    throw error;
  }
  if (
    !authority ||
    typeof authority !== 'object' ||
    Array.isArray(authority) ||
    Reflect.ownKeys(authority).length !== 1 ||
    !Object.hasOwn(authority, 'releaseChannel') ||
    !APPROVED_RELEASE_CHANNELS.includes(authority.releaseChannel)
  ) {
    throw new Error('Web release channel authority is invalid.');
  }
  if (authority.releaseChannel !== releaseChannel) {
    throw new Error(
      `Release channel mismatch: web=${authority.releaseChannel}, native=${releaseChannel}.`,
    );
  }
  return Object.freeze({ releaseChannel });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await verifyReleaseChannelPair({
      releaseChannel: process.argv[2],
      webDirectory: process.argv[3],
    });
    process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
