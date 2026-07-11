const CAPABILITY_NAMES = Object.freeze([
  'database',
  'commerce',
  'packStorage',
  'biometrics',
]);

const REQUIRED_OPERATIONS = Object.freeze({
  database: 'execute',
  commerce: 'purchase',
  packStorage: 'download',
  biometrics: 'authenticate',
});

function assertRecord(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object.`);
  }
  return value;
}

export class B1CapabilityNotEnabledError extends Error {
  constructor(capability, operation) {
    super(`${capability} is not enabled in B1.`);
    this.name = 'B1CapabilityNotEnabledError';
    this.code = 'B1_CAPABILITY_NOT_ENABLED';
    this.capability = capability;
    this.operation = operation;
    this.mode = 'prototype-only';
  }
}

export function assertNativePortContract(value) {
  const ports = assertRecord(value, 'Native ports');
  const capabilities = assertRecord(ports.capabilities, 'Native port capabilities');

  if (capabilities.mode !== 'prototype-only') {
    throw new TypeError('B1 native ports must declare prototype-only mode.');
  }
  for (const capability of CAPABILITY_NAMES) {
    if (capabilities[capability] !== false) {
      throw new TypeError(`B1 ${capability} capability must be disabled.`);
    }
    const port = assertRecord(ports[capability], `${capability} port`);
    if (typeof port.getStatus !== 'function') {
      throw new TypeError(`${capability}.getStatus must be a function.`);
    }
    if (typeof port[REQUIRED_OPERATIONS[capability]] !== 'function') {
      throw new TypeError(
        `${capability}.${REQUIRED_OPERATIONS[capability]} must be a function.`,
      );
    }
  }
  return ports;
}
