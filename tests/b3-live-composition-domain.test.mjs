import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createB3StoreActionResumeAuthority,
  driveB3HostScenario,
  driveB3HostUntilPhase,
} from '../scripts/lib/b3-live-capture-adapters.mjs';

test('one resume flag acknowledges exactly one retained store-action tail', () => {
  const binding = {
    actionCode: 'DECLINE_PENDING_PURCHASE',
    observationSha256: 'a'.repeat(64),
  };
  const resume = createB3StoreActionResumeAuthority(true, binding);
  assert.equal(resume(binding), true);
  assert.equal(resume(binding), false);
  assert.equal(resume({
    actionCode: 'APPROVE_PENDING_PURCHASE',
    observationSha256: 'b'.repeat(64),
  }), false);
  assert.throws(() => createB3StoreActionResumeAuthority(true), /invocation-tail/i);
});

test('host phase driver stops at validated HOLD before any relaunch command', async () => {
  const retained = [{ observation: {
    scenario: 'unacknowledged-relaunch', phase: 'ARMED',
  } }];
  let advances = 0;
  const held = await driveB3HostUntilPhase({
    scenario: 'unacknowledged-relaunch',
    phase: 'HOLD_REACHED',
    readRecords: async () => retained,
    advance: async () => {
      advances += 1;
      retained.push({ observation: {
        scenario: 'unacknowledged-relaunch',
        phase: advances === 1 ? 'HOLD_REACHED' : 'SCENARIO_COMPLETE',
      } });
    },
  });
  assert.equal(held.phase, 'HOLD_REACHED');
  assert.equal(advances, 1);
});

test('reinstall resume is bound to the retained gate and advances exactly once', async () => {
  const observationSha256 = 'a'.repeat(64);
  const readRecords = async () => [{ observation: {
    nextActionCode: 'REBIND_FRESH_INSTALL', observationSha256,
  } }];
  await assert.rejects(driveB3HostScenario({
    authority: { scenario: 'restore-after-reinstall', outcome: 'restored-active', traces: [] },
    readRecords,
    advance: async () => assert.fail('unacknowledged reinstall must not advance'),
  }), (error) => error?.instructionCode === 'REINSTALL_EXACT_BUILD');

  let advances = 0;
  await assert.rejects(driveB3HostScenario({
    authority: { scenario: 'restore-after-reinstall', outcome: 'restored-active', traces: [] },
    readRecords,
    resumeReinstall: ({ actionCode, observationSha256: retainedHash }) =>
      actionCode === 'REBIND_FRESH_INSTALL' && retainedHash === observationSha256,
    advance: async () => {
      advances += 1;
      throw new Error('stopped after exact reinstall resume');
    },
  }), /stopped after exact reinstall resume/i);
  assert.equal(advances, 1);
});

test('terminal driver advances refund completion only to app-owned terminal capture', async () => {
  const retained = [{ observation: {
    scenario: 'refund-revoke', phase: 'SCENARIO_COMPLETE',
  } }];
  let advances = 0;
  const terminal = await driveB3HostUntilPhase({
    scenario: 'refund-revoke',
    phase: 'TERMINAL_CAPTURE',
    readRecords: async () => retained,
    advance: async () => {
      advances += 1;
      retained.push({ observation: {
        scenario: 'refund-revoke', phase: 'TERMINAL_CAPTURE',
      } });
    },
  });
  assert.equal(terminal.phase, 'TERMINAL_CAPTURE');
  assert.equal(advances, 1);
  assert.equal(retained.some(({ observation }) => observation.phase === 'COMPLETE'), false);
});
