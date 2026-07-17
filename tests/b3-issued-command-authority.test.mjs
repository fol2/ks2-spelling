import assert from 'node:assert/strict';
import test from 'node:test';

import { canonicaliseB3ProofValue } from '../src/app/b3-live-proof-protocol.js';
import {
  createB3GenericConsumptionClaimAuthority,
  createB3IssuedCommandStateAuthority,
  createB3OrdinaryIssuedCommandClaimAuthority,
  isB3OrdinaryIssuedCommandTransition,
  validateB3GenericConsumptionClaimAuthorityBytes,
  validateB3IssuedCommandStateAuthorityBytes,
  validateB3OrdinaryIssuedCommandClaimAuthorityBytes,
} from '../scripts/lib/b3-issued-command-authority.mjs';

const COMMAND = Object.freeze({
  schemaVersion: 1,
  captureId: '018f1d7b-97e8-4a52-8cf2-783e5089c001',
  platform: 'ios-physical',
  testedApplicationCommit: '1'.repeat(40),
  applicationFingerprint: '2'.repeat(64),
  expectedScenarioIndex: 0,
  expectedSequence: 1,
  previousObservationSha256: '0'.repeat(64),
  installationMode: 'existing',
  actionCode: 'ARM_CAPTURE',
  challengeSha256: 'f144a676e8bf11d8a36b75b4ddb08c62d10b8c69be56e29270f556b9ee42261c',
});

const RECORD_HASHES = Object.freeze({
  prepared: '9d3bfbae6203275b1c7ef777b001f8254ebab77b334843ad8ac2a5c28898beaa',
  'stop-intent': 'aa9f239b991a6ebcf319ef1e67a7c2fbf65a4c78483978dedb272f947f49951f',
  'stop-executing': 'b8cb8dd12b77142442d651301660e2085a17f1c31c50827f83eb56b7a88e8335',
  'host-stopped': 'e1b2ae459cb2101bfa4852cfff72311433496a011cc219beaf095716bf1bbeea',
  launching: '57686831aa8562d8e309645db655aa17be75d8d647504a1ad17296e456113e09',
  'reinstall-authorised': 'cdfd6736cc28ef6cca0d72b970d9fce2d21436c85d012cfc3fdea08f19d06734',
  'reinstall-launching': 'bd7cd0d63a9085f676ee0445be6d3468ffd5b8fd6445b000e30c718a8fe68e08',
  launched: 'f6006d640ff0469b80b500f9fb1f5f9c996b69fb36e6db959ff6485d520bb2c4',
  'restart-required': '37c69258bd9c528ce9b745cb3220b3336a809c1f4683eb3fd6c832f619e363ce',
  'restart-executing': '2c2d9f817a284846df00dbb4e5497474713c199633f87d5fd6753478c050f40f',
  'restart-complete': '5d3b3f0f84cc1826b4b176b02973f41a01c49e898b81a82b5ecdd13eda05061b',
});

const CLAIM_HASHES = Object.freeze({
  'prepared:launching': 'c5106db4ad4168281af1b1ead6fd18f426c794d95ae277e5a1621e39bd39c45b',
  'prepared:stop-intent': 'fbaabcb548effeacfb1f3117320e62d1420c6cb94b0a87bfed73f014a0d729a6',
  'stop-intent:stop-executing': '35806d6e2955788095479c5cacb4bbcda3767b4ffe20133d2993b76c50713496',
  'stop-executing:host-stopped': '928f348be321bbbd21a727941c541f0b3cf43ff8e39c02403395374f817ffc42',
  'stop-executing:restart-required': '37d72adc59dedeb6d16310b7a7ba15ad6d18adf914bce16cefe3c8faba37271f',
  'host-stopped:launching': 'be0c1c10c9a410c1b1590b27c08d25d6aaa1734237fb5c23acd29f1997b9b304',
  'launching:launched': '0acb91cd0eda8be3051bda358bf13afa1966fb6ed5061d22a8ba04cfa13c833a',
  'launching:reinstall-authorised': '286354ecae8b941c601467a42a097bef48715d7f2eeff915affb3871946388b6',
  'launching:restart-required': '440a176dd53b50ce37fe59d20aa3b10cad611a1f5d0d4e2ad6449f3e7c444f39',
  'reinstall-authorised:reinstall-launching': '315a4a5cbd5666df1bc5de74cdc868888b77bc5e6f06f3a2cbc78707e341e799',
  'reinstall-launching:launched': '31ffc30d2c85e92a6e82c0cb559bc852526cffb755c10d9e31824c1c87ec9b44',
  'reinstall-launching:restart-required': 'a33e0a8b1808b4009106b57af3d9fbb74906f504ce97a9c34af8a90f1fcacd1c',
  'restart-required:launched': 'a01b43b385134721be5f0f290eed150f41e720e37b74fb7b77d220175d73a9e3',
});

const RECOVERY_EDGES = Object.freeze([
  'restart-required:restart-executing',
  'restart-executing:restart-complete',
]);

function canonicalBytes(value) {
  return Buffer.from(canonicaliseB3ProofValue(value), 'utf8');
}

function assertIssuedCommandInvalid(operation) {
  assert.throws(operation, (error) => {
    assert.equal(error?.code, 'b3_issued_command_invalid');
    return true;
  });
}

test('pure issued-command authority retains every schema-v3 state record literal', () => {
  for (const [state, recordSha256] of Object.entries(RECORD_HASHES)) {
    const record = createB3IssuedCommandStateAuthority({
      platform: 'ios',
      command: COMMAND,
      state,
    });
    assert.equal(record.commandSha256,
      '1f0de6d66179333a8e7adca7cb537342b19278e61aaff41a10a154da04652880');
    assert.equal(record.recordSha256, recordSha256, state);
    assert.deepEqual(validateB3IssuedCommandStateAuthorityBytes({
      bytes: canonicalBytes(record),
      platform: 'ios',
      expectedState: state,
    }), record);
  }
});

test('pure issued-command authority retains all thirteen ordinary claim literals', () => {
  for (const [edge, claimSha256] of Object.entries(CLAIM_HASHES)) {
    const [sourceState, nextState] = edge.split(':');
    const source = createB3IssuedCommandStateAuthority({
      platform: 'ios', command: COMMAND, state: sourceState,
    });
    const claim = createB3OrdinaryIssuedCommandClaimAuthority({
      platform: 'ios', source, nextState,
    });
    assert.equal(claim.claimSha256, claimSha256, edge);
    assert.deepEqual(validateB3OrdinaryIssuedCommandClaimAuthorityBytes({
      bytes: canonicalBytes(claim), platform: 'ios', source,
    }), claim);
  }
});

test('pure authority alone classifies every ordinary edge and excludes recovery', () => {
  for (const edge of Object.keys(CLAIM_HASHES)) {
    const [sourceState, nextState] = edge.split(':');
    assert.equal(isB3OrdinaryIssuedCommandTransition(sourceState, nextState), true, edge);
  }
  for (const edge of RECOVERY_EDGES) {
    const [sourceState, nextState] = edge.split(':');
    assert.equal(isB3OrdinaryIssuedCommandTransition(sourceState, nextState), false, edge);
  }
  assert.equal(isB3OrdinaryIssuedCommandTransition('prepared', 'restart-complete'), false);
});

test('generic-consumption authority has one closed domain-separated literal', () => {
  const source = createB3IssuedCommandStateAuthority({
    platform: 'ios', command: COMMAND, state: 'prepared',
  });
  const claim = createB3GenericConsumptionClaimAuthority({ platform: 'ios', source });
  assert.deepEqual(claim, {
    schemaVersion: 1,
    platform: 'ios',
    winnerKind: 'generic-consumption',
    commandSha256: '1f0de6d66179333a8e7adca7cb537342b19278e61aaff41a10a154da04652880',
    sourceState: 'prepared',
    sourceRecordSha256: RECORD_HASHES.prepared,
    claimSha256: '09f59c0645547a4d7cf701893b9540e0b5f6862ede5992e744c9434a650947f2',
  });
  assert.deepEqual(validateB3GenericConsumptionClaimAuthorityBytes({
    bytes: canonicalBytes(claim), platform: 'ios', source,
  }), claim);
  assert.throws(() => createB3GenericConsumptionClaimAuthority({
    platform: 'ios',
    source: createB3IssuedCommandStateAuthority({
      platform: 'ios', command: COMMAND, state: 'restart-required',
    }),
  }), /generic-consumption|state|invalid/i);
});

test('pure authority normalises malformed bytes and nested launch commands', () => {
  const prepared = createB3IssuedCommandStateAuthority({
    platform: 'ios', command: COMMAND, state: 'prepared',
  });
  for (const bytes of [Buffer.from('{', 'utf8'), Buffer.alloc(0)]) {
    assertIssuedCommandInvalid(() => validateB3IssuedCommandStateAuthorityBytes({
      bytes,
      platform: 'ios',
      expectedState: 'prepared',
    }));
    assertIssuedCommandInvalid(() => validateB3OrdinaryIssuedCommandClaimAuthorityBytes({
      bytes,
      platform: 'ios',
      source: prepared,
    }));
    assertIssuedCommandInvalid(() => validateB3GenericConsumptionClaimAuthorityBytes({
      bytes,
      platform: 'ios',
      source: prepared,
    }));
  }

  const malformedCommand = { ...COMMAND, challengeSha256: 'not-a-hash' };
  assertIssuedCommandInvalid(() => createB3IssuedCommandStateAuthority({
    platform: 'ios', command: malformedCommand, state: 'prepared',
  }));
  assertIssuedCommandInvalid(() => createB3OrdinaryIssuedCommandClaimAuthority({
    platform: 'ios',
    source: { ...prepared, command: malformedCommand },
    nextState: 'launching',
  }));
  assertIssuedCommandInvalid(() => createB3GenericConsumptionClaimAuthority({
    platform: 'ios',
    source: { ...prepared, command: malformedCommand },
  }));
});
