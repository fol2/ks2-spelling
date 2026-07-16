const sessions = new WeakMap();

export function registerB3CaptureStateSession(handle, session) {
  if (sessions.has(handle)) {
    throw new Error('B3 capture-state internal session is already registered');
  }
  sessions.set(handle, session);
}

export function takeB3CaptureStateSession(handle) {
  const session = sessions.get(handle);
  sessions.delete(handle);
  return session;
}
