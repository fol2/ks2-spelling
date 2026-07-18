import { installB3CaptureStateRootMock } from './b3-capture-state-install-root-mock.mjs';

installB3CaptureStateRootMock();
const { openB3CaptureStore } = await import('../../scripts/lib/b3-capture-store.mjs');

let getterCalls = 0;
const operation = openB3CaptureStore({
  get platform() {
    getterCalls += 1;
    return getterCalls === 1 ? 'ios' : 'android';
  },
});
const synchronousGetterCalls = getterCalls;
let store;
try {
  store = await operation;
  process.stdout.write(`${JSON.stringify({
    ok: true,
    getterCalls,
    synchronousGetterCalls,
    keys: Reflect.ownKeys(store).map(String).sort(),
  })}\n`);
} catch (error) {
  process.stdout.write(`${JSON.stringify({
    ok: false,
    getterCalls,
    synchronousGetterCalls,
    error: { code: error?.code ?? null, message: error?.message ?? String(error) },
  })}\n`);
} finally {
  await store?.close();
}
