const supported = typeof performance !== 'undefined'
  && typeof performance.mark === 'function'
  && typeof performance.measure === 'function';

export function markB4(name) {
  if (supported) performance.mark(name);
}

export function measureB4(name, startMark) {
  if (!supported) return;
  try {
    performance.measure(name, startMark);
  } catch {
    // The start mark may not exist (e.g. state change without a user action).
  }
}
