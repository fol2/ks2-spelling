import { installB3CaptureStateRootMock } from './b3-capture-state-install-root-mock.mjs';

installB3CaptureStateRootMock();

const {
  readB3BuildAuthoritySource,
  readB3BuildAuthoritySourceSync,
} = await import('../../scripts/lib/b3-build-authority-source.mjs');

function projection(source) {
  const firstBytes = source.bytes;
  const expectedFirstByte = firstBytes[0];
  firstBytes[0] ^= 0xff;
  return {
    canonicalJson: source.bytes.toString('utf8'),
    sha256: source.sha256,
    sourceSha256: source.sourceSha256,
    value: source.value,
    buildAuthority: source.buildAuthority,
    identity: source.identity,
    frozen: {
      source: Object.isFrozen(source),
      value: Object.isFrozen(source.value),
      buildAuthority: Object.isFrozen(source.buildAuthority),
      identity: Object.isFrozen(source.identity),
      ancestors: Object.isFrozen(source.identity.ancestors),
      file: Object.isFrozen(source.identity.file),
    },
    bytesIsolated: source.bytes[0] === expectedFirstByte,
  };
}

async function rejectedCode(operation) {
  try {
    await operation();
    return null;
  } catch (error) {
    return error?.code ?? null;
  }
}

try {
  const mode = process.argv[2] ?? 'both';
  if (!['async', 'both', 'sync'].includes(mode)) throw new Error('invalid probe mode');
  const asynchronous = mode === 'sync'
    ? undefined
    : projection(await readB3BuildAuthoritySource());
  const synchronous = mode === 'async'
    ? undefined
    : projection(readB3BuildAuthoritySourceSync());
  process.stdout.write(`${JSON.stringify({
    ok: true,
    ...(asynchronous && { asynchronous }),
    ...(synchronous && { synchronous }),
    callerAuthority: {
      asynchronous: await rejectedCode(() => readB3BuildAuthoritySource('foreign')),
      synchronous: await rejectedCode(() => readB3BuildAuthoritySourceSync('foreign')),
    },
  })}\n`);
} catch (error) {
  process.stdout.write(`${JSON.stringify({
    ok: false,
    error: {
      code: error?.code ?? null,
      message: error?.message ?? String(error),
    },
  })}\n`);
}
