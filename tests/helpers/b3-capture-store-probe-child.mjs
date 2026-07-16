import { installB3CaptureStateRootMock } from './b3-capture-state-install-root-mock.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

installB3CaptureStateRootMock();

const { openB3CaptureStore } = await import('../../scripts/lib/b3-capture-store.mjs');

const mode = process.argv[2];
let getterCalls = 0;
let synchronousGetterCalls = null;
let freezeProof = null;
let store;
let closed = false;
try {
  if (mode === 'invalid-open') {
    await openB3CaptureStore({ platform: 'ios', unexpected: true });
    throw new Error('invalid open unexpectedly succeeded');
  }
  store = await openB3CaptureStore({
    platform: mode.endsWith('-android') ? 'android' : 'ios',
  });
  let result;
  if (mode === 'shape') {
    result = Reflect.ownKeys(store).map(String).sort();
  } else if (mode === 'invalid-start') {
    result = await store.startCapture({
      get command() {
        getterCalls += 1;
        throw new Error('command getter must not run');
      },
      unexpected: true,
    });
  } else if (mode === 'closed') {
    await store.close();
    closed = true;
    result = await store.startCapture({ command: {} });
  } else if ([
    'start', 'start-android', 'hostile-before-start', 'frozen-start',
    'partial-capture-before-start',
  ]
    .includes(mode)) {
    const command = JSON.parse(Buffer.from(process.argv[3], 'base64url').toString('utf8'));
    if (mode === 'hostile-before-start') {
      const bundles = resolve(
        '.native-build', 'b3', 'evidence', 'ios-capture-bundles',
      );
      mkdirSync(bundles, { mode: 0o700 });
      writeFileSync(resolve(bundles, 'unexpected'), 'hostile', { mode: 0o600 });
    }
    if (mode === 'partial-capture-before-start') {
      const database = new DatabaseSync(resolve(
        '.native-build', 'b3', 'evidence', 'ios-capture-state', 'recovery.sqlite',
      ));
      try {
        const start = database.prepare(`
          SELECT start_intent_sha256, capture_id FROM b3_capture_start_intents
        `).get();
        database.prepare(`
          INSERT INTO b3_captures (
            capture_id, start_intent_sha256, capture_state, row_version
          ) VALUES (?, ?, 'working', 1)
        `).run(start.capture_id, start.start_intent_sha256);
      } finally {
        database.close();
      }
    }
    result = await store.startCapture({ command });
    if (mode === 'frozen-start') {
      freezeProof = {
        handle: Object.isFrozen(store),
        result: Object.isFrozen(result),
        capture: Object.isFrozen(result.capture),
        firstCommand: Object.isFrozen(result.capture.firstCommand),
      };
    }
  } else if (mode === 'snapshot-before-await') {
    const original = JSON.parse(
      Buffer.from(process.argv[3], 'base64url').toString('utf8'),
    );
    const mutable = { ...original };
    const counted = {};
    for (const key of Object.keys(mutable)) {
      Object.defineProperty(counted, key, {
        enumerable: true,
        get() {
          getterCalls += 1;
          return mutable[key];
        },
      });
    }
    const operation = store.startCapture({ command: counted });
    synchronousGetterCalls = getterCalls;
    mutable.captureId = 'mutated-after-first-await';
    mutable.challengeSha256 = 'f'.repeat(64);
    result = await operation;
  } else {
    throw new Error('unknown capture-store probe mode');
  }
  const output = { ok: true, result, getterCalls };
  if (synchronousGetterCalls !== null) output.synchronousGetterCalls = synchronousGetterCalls;
  if (freezeProof !== null) output.freezeProof = freezeProof;
  process.stdout.write(`${JSON.stringify(output)}\n`);
} catch (error) {
  process.stdout.write(`${JSON.stringify({
    ok: false,
    error: { code: error?.code ?? null, message: error?.message ?? String(error) },
    getterCalls,
  })}\n`);
} finally {
  if (!closed) await store?.close();
}
