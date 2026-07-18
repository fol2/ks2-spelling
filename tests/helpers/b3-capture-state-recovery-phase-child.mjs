import { installB3CaptureStateRootMock } from './b3-capture-state-install-root-mock.mjs';

installB3CaptureStateRootMock();

const mode = process.argv[2];
const platform = process.argv[3] ?? 'ios';
let repository;
let foundation;
let store;
try {
  if (mode === 'phase' || mode === 'open-foundation') {
    const { openB3CaptureStateDatabase } = await import(
      '../../scripts/lib/b3-capture-state-database.mjs'
    );
    const { takeB3CaptureStateSession } = await import(
      '../../scripts/lib/b3-capture-state-internal.mjs'
    );
    foundation = await openB3CaptureStateDatabase({ platform });
    const session = takeB3CaptureStateSession(foundation);
    const buildAuthority = await session.readBuildAuthorityFresh();
    const state = session.validate(buildAuthority);
    const result = mode === 'open-foundation'
      ? { kind: state.kind }
      : {
          kind: state.kind,
          captureIds: state.captures.map((capture) => capture.capture.capture_id),
          workingCaptureId: state.workingCapture?.capture.capture_id ?? null,
          latestRecoveryCommandSha256:
            state.latestRecovery?.snapshot.commands.at(-1)?.commandSha256 ?? null,
          snapshotArraysFrozen: state.captures.every((capture) =>
            Object.isFrozen(capture.snapshotCommands) &&
            Object.isFrozen(capture.snapshotDecisions) &&
            Object.isFrozen(capture.snapshotSteps) &&
            capture.snapshotCommands.every(Object.isFrozen) &&
            capture.snapshotDecisions.every(Object.isFrozen) &&
            capture.snapshotSteps.every(Object.isFrozen)),
          snapshots: state.captures.map((capture) => ({
            captureId: capture.capture.capture_id,
            commandCount: capture.snapshotCommands.length,
            decisionCount: capture.snapshotDecisions.length,
            stepCount: capture.snapshotSteps.length,
            firstCommand: capture.snapshotCommands[0] ?? null,
            lastCommand: capture.snapshotCommands.at(-1) ?? null,
          })),
        };
    process.stdout.write(`${JSON.stringify({ ok: true, result })}\n`);
    await foundation.close();
    foundation = null;
    process.exit(0);
  }
  if (mode === 'publish-existing') {
    const { openB3CaptureStore } = await import('../../scripts/lib/b3-capture-store.mjs');
    store = await openB3CaptureStore({ platform });
    const source = JSON.parse(Buffer.from(process.argv[4], 'base64url').toString('utf8'));
    const observationBytes = Buffer.from(process.argv[5], 'base64url');
    const result = await store.publishObservation({ source, observationBytes });
    process.stdout.write(`${JSON.stringify({ ok: true, result })}\n`);
    await store.close();
    store = null;
    process.exit(0);
  }
  const { openB3CaptureStateRepository } = await import(
    '../../scripts/lib/b3-capture-state-repository.mjs'
  );
  repository = await openB3CaptureStateRepository({ platform });
  const result = mode === 'read-capture'
    ? await repository.readCapture()
    : await repository.readActiveCommand();
  process.stdout.write(`${JSON.stringify({ ok: true, result })}\n`);
} catch (error) {
  process.stdout.write(`${JSON.stringify({
    ok: false,
    error: { code: error?.code ?? null, message: error?.message ?? String(error) },
  })}\n`);
} finally {
  await repository?.close();
  await foundation?.close();
  await store?.close();
}
