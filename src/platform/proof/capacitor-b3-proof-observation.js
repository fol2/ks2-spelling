import { registerPlugin } from '@capacitor/core';

import {
  canonicaliseB3ProofValue,
  validateB3ProofLaunchCommand,
  validateB3ProofObservationForPublication,
} from '../../app/b3-live-proof-protocol.js';
import { assertB3ProofObservationPort } from './b3-proof-observation-port.js';

const NativeB3ProofObservation = registerPlugin('B3ProofObservation');
const concretePorts = new WeakSet();
const MAXIMUM_BYTES = 64 * 1_024;

function requirePlugin(value) {
  if (
    !value ||
    typeof value !== 'object' ||
    typeof value.getLaunchCommand !== 'function' ||
    typeof value.publishObservation !== 'function'
  ) {
    throw new TypeError('B3 native proof observation plugin is invalid.');
  }
  return value;
}

function requireExactResponse(value, keys, label) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== keys.length ||
    Reflect.ownKeys(value).some((key) =>
      typeof key !== 'string' ||
      !keys.includes(key) ||
      !Object.getOwnPropertyDescriptor(value, key)?.enumerable ||
      !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'))
  ) {
    throw new TypeError(`${label} violates its closed schema.`);
  }
  return value;
}

function requireBoundedString(value, label) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    new TextEncoder().encode(value).byteLength > MAXIMUM_BYTES
  ) {
    throw new TypeError(`${label} is invalid.`);
  }
  return value;
}

export function createCapacitorB3ProofObservation(
  { plugin = NativeB3ProofObservation, buildAuthority } = {},
) {
  const native = requirePlugin(plugin);
  if (!buildAuthority || typeof buildAuthority !== 'object' || Array.isArray(buildAuthority)) {
    throw new TypeError('B3 native proof build authority is invalid.');
  }
  const embeddedBuildAuthority = structuredClone(buildAuthority);
  let activeCommand = null;
  const port = Object.freeze({
    async getLaunchCommand() {
      if (arguments.length !== 0) {
        throw new TypeError('getLaunchCommand does not accept input.');
      }
      const result = requireExactResponse(
        await native.getLaunchCommand(),
        ['commandJson'],
        'B3 native launch-command response',
      );
      if (result.commandJson === null) return null;
      const commandJson = requireBoundedString(
        result.commandJson,
        'B3 native launch command',
      );
      let parsed;
      try {
        parsed = JSON.parse(commandJson);
      } catch (error) {
        throw new TypeError('B3 native launch command is invalid.', { cause: error });
      }
      const command = validateB3ProofLaunchCommand(parsed);
      if (canonicaliseB3ProofValue(command) !== commandJson) {
        throw new TypeError('B3 native launch command is not canonical.');
      }
      activeCommand = Object.freeze(command);
      return activeCommand;
    },
    async publishObservation(value) {
      if (arguments.length !== 1) {
        throw new TypeError('publishObservation requires one input.');
      }
      if (activeCommand === null) {
        throw new TypeError('B3 proof observation has no active launch command.');
      }
      const observation = await validateB3ProofObservationForPublication(value, {
        command: activeCommand,
        buildAuthority: embeddedBuildAuthority,
      });
      const canonicalJson = requireBoundedString(
        canonicaliseB3ProofValue(observation),
        'B3 canonical proof observation',
      );
      const result = requireExactResponse(
        await native.publishObservation({ canonicalJson }),
        ['written'],
        'B3 native observation-write response',
      );
      if (result.written !== true) {
        throw new TypeError('B3 native observation write was not confirmed.');
      }
      activeCommand = null;
    },
  });
  assertB3ProofObservationPort(port);
  concretePorts.add(port);
  return port;
}

export function isCapacitorB3ProofObservation(value) {
  return concretePorts.has(value);
}
