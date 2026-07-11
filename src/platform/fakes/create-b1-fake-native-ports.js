import { B1CapabilityNotEnabledError } from '../native-port-contract.js';

const CAPABILITY_NAMES = Object.freeze([
  'database',
  'commerce',
  'packStorage',
  'biometrics',
]);

function createPort(capability, operation) {
  const status = Object.freeze({
    capability,
    enabled: false,
    mode: 'prototype-only',
  });
  return Object.freeze({
    async getStatus() {
      return status;
    },
    async [operation]() {
      throw new B1CapabilityNotEnabledError(capability, operation);
    },
  });
}

export function createB1FakeNativePorts() {
  const capabilities = Object.freeze({
    mode: 'prototype-only',
    ...Object.fromEntries(CAPABILITY_NAMES.map((name) => [name, false])),
  });
  return Object.freeze({
    capabilities,
    database: createPort('database', 'execute'),
    commerce: createPort('commerce', 'purchase'),
    packStorage: createPort('packStorage', 'download'),
    biometrics: createPort('biometrics', 'authenticate'),
  });
}
