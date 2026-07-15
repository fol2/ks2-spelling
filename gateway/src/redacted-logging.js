const ALLOWED_EVENTS = new Set(['gateway_request', 'gateway_error', 'rate_limited']);
const ALLOWED_FIELDS = Object.freeze(['operation', 'status', 'store', 'retryable']);

export function createRedactedLogger({ write = (record) => console.log(JSON.stringify(record)) } = {}) {
  if (typeof write !== 'function') throw new TypeError('Logger writer must be a function.');
  function emit(level, event, metadata = {}) {
    if (!ALLOWED_EVENTS.has(event)) return;
    const record = { level, event };
    for (const key of ALLOWED_FIELDS) {
      const value = metadata[key];
      if (
        (key === 'operation' && ['verify', 'refresh', 'complete'].includes(value)) ||
        (key === 'status' && Number.isInteger(value) && value >= 100 && value <= 599) ||
        (key === 'store' && ['apple', 'google'].includes(value)) ||
        (key === 'retryable' && typeof value === 'boolean')
      ) record[key] = value;
    }
    write(Object.freeze(record));
  }
  return Object.freeze({
    info: (event, metadata) => emit('info', event, metadata),
    error: (event, metadata) => emit('error', event, metadata),
  });
}
