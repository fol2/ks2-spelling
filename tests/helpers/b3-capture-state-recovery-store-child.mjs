import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as sqlite from 'node:sqlite';

import {
  canonicaliseB3ProofValue,
  createB3ProofObservation,
} from '../../src/app/b3-live-proof-protocol.js';
import { installB3CaptureStateRootMock } from './b3-capture-state-install-root-mock.mjs';
import { buildB3PhysicalProofAuthority } from
  '../../scripts/lib/b3-capture-proof-domain.mjs';

installB3CaptureStateRootMock();

const { openB3CaptureStore } = await import('../../scripts/lib/b3-capture-store.mjs');

const COMMIT = '1'.repeat(40);
const FINGERPRINT = '2'.repeat(64);
const INITIAL_CAPTURE_ID = '018f1d7b-97e8-4a52-8cf2-783e5089c001';
const FRESH_CAPTURE_ID = '018f1d7b-97e8-4a52-8cf2-783e5089c002';
const LOSING_CAPTURE_ID = '018f1d7b-97e8-4a52-8cf2-783e5089c003';

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function command(captureId, overrides = {}) {
  const unsigned = {
    schemaVersion: 1,
    captureId,
    platform: 'ios-physical',
    testedApplicationCommit: COMMIT,
    applicationFingerprint: FINGERPRINT,
    expectedScenarioIndex: 0,
    expectedSequence: 1,
    previousObservationSha256: '0'.repeat(64),
    installationMode: 'existing',
    actionCode: 'ARM_CAPTURE',
    ...overrides,
  };
  return Object.freeze({
    ...unsigned,
    challengeSha256: sha256(Buffer.from(
      `ks2-spelling:b3-host-command-challenge:v1\0${canonicaliseB3ProofValue(unsigned)}`,
      'utf8',
    )),
  });
}

function buildAuthority() {
  return buildB3PhysicalProofAuthority('ios', {
    schemaVersion: 1,
    testedApplicationCommit: COMMIT,
    applicationFingerprint: FINGERPRINT,
    versionName: '0.3.0-b3',
    iosBuildNumber: '19',
    androidVersionCode: 19,
  });
}

function projection(retainedCommand) {
  return {
    challengeSha256: retainedCommand.challengeSha256,
    scenarioOutcome: 'in-progress',
    entitlementState: 'none',
    packState: 'absent',
    storeCompletionObserved: false,
    storeEvents: [],
    storeAuthority: {
      environment: 'sandbox',
      productId: 'uk.eugnel.ks2spelling.fullks2',
      localisedPriceObserved: false,
      completionState: 'not-observed',
    },
    gatewayCalls: [],
    syntheticLearners: {
      syntheticAuthorityMatched: true,
      positionalSnapshotSha256: ['a'.repeat(64), 'b'.repeat(64)],
    },
    transactionAuthority: {
      source: 'none',
      crossCheckedOnRefresh: false,
      domainSeparatedDigestSha256: null,
      rawProofCleared: false,
    },
    refreshHandleLifecycle: {
      present: false,
      positiveVersionObserved: false,
      rotated: false,
      deleted: false,
    },
    entitlementAuthority: {
      id: null,
      state: 'none',
      domainSeparatedDigestSha256: null,
      refreshHandlePresent: false,
    },
    packAuthority: {
      packId: null,
      manifestSha256: null,
      archiveSha256: null,
      installed: false,
    },
    gatewaySmokeAuthority: null,
    transportAuthority: {
      storeAdapter: 'concreteCapacitorStore',
      gatewayAdapter: 'concreteHttpGateway',
      serverUrl: null,
      nativeOriginAllowed: true,
      noRedirects: true,
    },
  };
}

async function observationBytes(retainedCommand, observedAt) {
  const observation = await createB3ProofObservation({
    command: retainedCommand,
    buildAuthority: buildAuthority(),
    installationId: '018f1d7b-97e8-4a52-8cf2-783e5089c004',
    sequence: retainedCommand.expectedSequence,
    scenario: 'product-query',
    phase: 'ARMED',
    nextActionCode: 'QUERY_PRODUCT',
    completedTransitions: ['UNBOUND', 'ARMED'],
    proofProjection: projection(retainedCommand),
    observedAt,
  });
  return Object.freeze({
    bytes: Buffer.from(canonicaliseB3ProofValue(observation), 'utf8'),
    observation,
  });
}

function nextCommand(capture) {
  const tail = capture.records.at(-1).observation;
  return command(capture.captureId, {
    expectedScenarioIndex: tail.scenarioIndex,
    expectedSequence: tail.sequence + 1,
    previousObservationSha256: tail.observationSha256,
    actionCode: tail.nextActionCode,
  });
}

function distribution() {
  return Object.freeze({
    embeddedCommit: COMMIT,
    embeddedFingerprint: FINGERPRINT,
    versionName: '0.3.0-b3',
    kind: 'development',
    iosBuildNumber: '19',
    signedIpaSha256: '3'.repeat(64),
    ipaEmbeddedAuthoritySha256: '4'.repeat(64),
    codeSigningCertificateSha256: '5'.repeat(64),
    installedBundleId: 'uk.eugnel.ks2spelling',
    installedVersion: '0.3.0-b3',
    installedBuild: '19',
    installedEmbeddedAuthoritySha256: '4'.repeat(64),
    installedBuiltByDeveloper: true,
    sandboxReceiptVerified: true,
  });
}

async function reachRestartRequired(store) {
  await store.startCapture({ command: command(INITIAL_CAPTURE_ID) });
  let source = (await store.readActiveCommand()).command;
  source = (await store.transitionCommand({ source, nextState: 'launching' })).command;
  return (await store.transitionCommand({
    source,
    nextState: 'restart-required',
  })).command;
}

async function reachLaunching(store) {
  await store.startCapture({ command: command(INITIAL_CAPTURE_ID) });
  const source = (await store.readActiveCommand()).command;
  return (await store.transitionCommand({ source, nextState: 'launching' })).command;
}

function databaseBytes() {
  return readFileSync(resolve(
    '.native-build', 'b3', 'evidence', 'ios-capture-state', 'recovery.sqlite',
  ));
}

async function interruptAfterRecoveryCommit(storeHandle, invocation, target) {
  const originalExec = sqlite.DatabaseSync.prototype.exec;
  const originalPrepare = sqlite.DatabaseSync.prototype.prepare;
  const originalRun = sqlite.StatementSync.prototype.run;
  const statements = new WeakMap();
  let durablePhase = null;
  const normalise = (sql) => String(sql).trim().replace(/\s+/gu, ' ');
  sqlite.DatabaseSync.prototype.prepare = function tracedPrepare(sql) {
    const statement = Reflect.apply(originalPrepare, this, [sql]);
    const value = normalise(sql);
    if (value.startsWith('INSERT INTO b3_recoveries')) {
      statements.set(statement, 'archive');
    } else if (value.startsWith('INSERT INTO b3_recovery_terminals')) {
      statements.set(statement, 'terminal');
    } else if (value.startsWith('INSERT INTO b3_captures')) {
      statements.set(statement, 'fresh');
    }
    return statement;
  };
  sqlite.StatementSync.prototype.run = function tracedRun(...values) {
    const result = Reflect.apply(originalRun, this, values);
    durablePhase = statements.get(this) ?? durablePhase;
    return result;
  };
  sqlite.DatabaseSync.prototype.exec = function tracedExec(sql) {
    const value = normalise(sql);
    const result = Reflect.apply(originalExec, this, [sql]);
    if (value === 'COMMIT' && durablePhase === target) {
      durablePhase = null;
      throw new Error(`interrupted-after-${target}-commit`);
    }
    return result;
  };
  try {
    await storeHandle.finaliseRecoveryInvocation({
      invocation,
      distribution: distribution(),
      freshCommand: command(FRESH_CAPTURE_ID),
    });
    throw new Error(`recovery ${target} interruption did not fire`);
  } catch (error) {
    if (error?.message !== `interrupted-after-${target}-commit`) throw error;
  } finally {
    sqlite.DatabaseSync.prototype.exec = originalExec;
    sqlite.DatabaseSync.prototype.prepare = originalPrepare;
    sqlite.StatementSync.prototype.run = originalRun;
  }
}

const mode = process.argv[2];
let store;
try {
  store = await openB3CaptureStore({ platform: 'ios' });
  let publishedObservation = null;
  let restartRequired;
  if (mode === 'archived-publication-retries') {
    const launching = await reachLaunching(store);
    publishedObservation = await observationBytes(
      launching.command,
      '2026-07-17T10:00:00.000Z',
    );
    await store.publishObservation({
      source: launching,
      observationBytes: publishedObservation.bytes,
    });
    restartRequired = (await store.transitionCommand({
      source: launching,
      nextState: 'restart-required',
    })).command;
  } else {
    restartRequired = mode === 'post-pin-gate'
      ? await reachLaunching(store)
      : await reachRestartRequired(store);
  }
  const acknowledgeReinstall = ![
    'operator-required',
    'stale-unack-after-archive',
    'stale-unack-after-fresh',
  ].includes(mode);
  const invocation = await store.pinRecoveryInvocation({
    acknowledgeReinstall,
  });
  if (mode === 'invalid-distribution' || mode === 'missing-distribution') {
    const before = databaseBytes();
    let rejected;
    try {
      await store.finaliseRecoveryInvocation({
        invocation,
        distribution: mode === 'missing-distribution'
          ? undefined
          : { ...distribution(), embeddedCommit: '9'.repeat(40) },
        freshCommand: command(FRESH_CAPTURE_ID),
      });
      rejected = null;
    } catch (error) {
      rejected = { code: error?.code ?? null, message: error?.message ?? String(error) };
    }
    const after = databaseBytes();
    process.stdout.write(`${JSON.stringify({
      ok: true,
      rejected,
      databaseIdentical: before.equals(after),
      active: await store.readActiveCommand(),
    })}\n`);
    process.exitCode = 0;
  } else if (mode === 'post-pin-gate') {
    await store.transitionCommand({ source: restartRequired, nextState: 'restart-required' });
    const outcome = await store.finaliseRecoveryInvocation({
      invocation,
      distribution: distribution(),
      freshCommand: command(FRESH_CAPTURE_ID),
    });
    process.stdout.write(`${JSON.stringify({
      ok: true, outcome, active: await store.readActiveCommand(),
    })}\n`);
  } else if (mode === 'ordinary-first') {
    await store.transitionCommand({ source: restartRequired, nextState: 'launched' });
    const outcome = await store.finaliseRecoveryInvocation({
      invocation,
      distribution: distribution(),
      freshCommand: command(FRESH_CAPTURE_ID),
    });
    process.stdout.write(`${JSON.stringify({
      ok: true, outcome, active: await store.readActiveCommand(),
    })}\n`);
  } else if (mode === 'stale-successor') {
    const winner = await openB3CaptureStore({ platform: 'ios' });
    try {
      const winningPin = await winner.pinRecoveryInvocation({ acknowledgeReinstall: true });
      await winner.finaliseRecoveryInvocation({
        invocation: winningPin,
        distribution: distribution(),
        freshCommand: command(FRESH_CAPTURE_ID),
      });
      const fresh = (await winner.readActiveCommand()).command;
      await winner.transitionCommand({ source: fresh, nextState: 'launching' });
      const outcome = await store.finaliseRecoveryInvocation({
        invocation,
        distribution: distribution(),
        freshCommand: command(LOSING_CAPTURE_ID),
      });
      process.stdout.write(`${JSON.stringify({
        ok: true, outcome, active: await store.readActiveCommand(),
      })}\n`);
    } finally {
      await winner.close();
    }
  } else if (mode === 'stale-successor-full') {
    const winner = await openB3CaptureStore({ platform: 'ios' });
    try {
      const winningPin = await winner.pinRecoveryInvocation({ acknowledgeReinstall: true });
      await winner.finaliseRecoveryInvocation({
        invocation: winningPin,
        distribution: distribution(),
        freshCommand: command(FRESH_CAPTURE_ID),
      });
      let fresh = (await winner.readActiveCommand()).command;
      fresh = (await winner.transitionCommand({
        source: fresh,
        nextState: 'launching',
      })).command;
      fresh = (await winner.transitionCommand({
        source: fresh,
        nextState: 'launched',
      })).command;
      const published = await observationBytes(
        fresh.command,
        '2026-07-17T10:00:00.000Z',
      );
      await winner.publishObservation({
        source: fresh,
        observationBytes: published.bytes,
      });
      await winner.consumeCommand({ source: fresh });
      await winner.allocateNextCommand({
        command: nextCommand(await winner.readCapture()),
      });
      const outcome = await store.finaliseRecoveryInvocation({
        invocation,
        distribution: distribution(),
        freshCommand: command(LOSING_CAPTURE_ID),
      });
      process.stdout.write(`${JSON.stringify({
        ok: true, outcome, active: await store.readActiveCommand(),
      })}\n`);
    } finally {
      await winner.close();
    }
  } else if (mode === 'stale-unack-after-archive' ||
      mode === 'stale-unack-after-fresh') {
    const winner = await openB3CaptureStore({ platform: 'ios' });
    try {
      const winningPin = await winner.pinRecoveryInvocation({ acknowledgeReinstall: true });
      if (mode.endsWith('archive')) {
        await interruptAfterRecoveryCommit(winner, winningPin, 'archive');
      } else {
        await winner.finaliseRecoveryInvocation({
          invocation: winningPin,
          distribution: distribution(),
          freshCommand: command(FRESH_CAPTURE_ID),
        });
      }
      const outcome = await store.finaliseRecoveryInvocation({
        invocation,
        distribution: distribution(),
        freshCommand: command(LOSING_CAPTURE_ID),
      });
      process.stdout.write(`${JSON.stringify({
        ok: true, outcome, active: await store.readActiveCommand(),
      })}\n`);
    } finally {
      await winner.close();
    }
  } else if (mode === 'reservation-allocator-archive' ||
      mode === 'reservation-allocator-terminal') {
    const phase = mode.endsWith('archive') ? 'archive' : 'terminal';
    await interruptAfterRecoveryCommit(store, invocation, phase);
    await store.close();
    store = await openB3CaptureStore({ platform: 'ios' });
    const before = databaseBytes();
    let allocationRejected;
    try {
      await store.allocateNextCommand({ command: command(FRESH_CAPTURE_ID) });
      allocationRejected = null;
    } catch (error) {
      allocationRejected = {
        code: error?.code ?? null,
        message: error?.message ?? String(error),
      };
    }
    const databaseIdentical = before.equals(databaseBytes());
    const retry = await store.pinRecoveryInvocation({ acknowledgeReinstall: false });
    const outcome = await store.finaliseRecoveryInvocation({
      invocation: retry,
      distribution: distribution(),
      freshCommand: command(LOSING_CAPTURE_ID),
    });
    process.stdout.write(`${JSON.stringify({
      ok: true,
      allocationRejected,
      databaseIdentical,
      outcome,
      active: await store.readActiveCommand(),
    })}\n`);
  } else if (mode === 'archived-publication-retries') {
    await interruptAfterRecoveryCommit(store, invocation, 'archive');
    const before = databaseBytes();
    const identical = await store.publishObservation({
      source: restartRequired,
      observationBytes: publishedObservation.bytes,
    });
    const conflictingObservation = await observationBytes(
      restartRequired.command,
      '2026-07-17T10:00:01.000Z',
    );
    const conflict = await store.publishObservation({
      source: restartRequired,
      observationBytes: conflictingObservation.bytes,
    });
    process.stdout.write(`${JSON.stringify({
      ok: true,
      identical,
      conflict,
      databaseIdentical: before.equals(databaseBytes()),
      active: await store.readActiveCommand(),
    })}\n`);
  } else if (mode === 'public-start-terminal') {
    await interruptAfterRecoveryCommit(store, invocation, 'terminal');
    const before = databaseBytes();
    let rejected;
    try {
      await store.startCapture({ command: command(FRESH_CAPTURE_ID) });
      rejected = null;
    } catch (error) {
      rejected = { code: error?.code ?? null, message: error?.message ?? String(error) };
    }
    const databaseIdentical = before.equals(databaseBytes());
    const retry = await store.pinRecoveryInvocation({ acknowledgeReinstall: false });
    const outcome = await store.finaliseRecoveryInvocation({
      invocation: retry,
      distribution: distribution(),
      freshCommand: command(LOSING_CAPTURE_ID),
    });
    process.stdout.write(`${JSON.stringify({
      ok: true,
      rejected,
      databaseIdentical,
      outcome,
      active: await store.readActiveCommand(),
    })}\n`);
  } else if (mode === 'archive-boundaries') {
    await interruptAfterRecoveryCommit(store, invocation, 'archive');
    let readRejected;
    try {
      await store.readCapture();
      readRejected = null;
    } catch (error) {
      readRejected = { code: error?.code ?? null, message: error?.message ?? String(error) };
    }
    const missingObservation = await observationBytes(
      restartRequired.command,
      '2026-07-17T10:00:00.000Z',
    );
    const operations = [
      ['start', () => store.startCapture({ command: command(FRESH_CAPTURE_ID) })],
      ['allocate', () => store.allocateNextCommand({ command: command(FRESH_CAPTURE_ID) })],
      ['transition', () => store.transitionCommand({
        source: restartRequired,
        nextState: 'launched',
      })],
      ['publish', () => store.publishObservation({
        source: restartRequired,
        observationBytes: missingObservation.bytes,
      })],
      ['consume', () => store.consumeCommand({ source: restartRequired })],
    ];
    const mutators = [];
    for (const [operation, mutate] of operations) {
      const before = databaseBytes();
      let rejected;
      try {
        await mutate();
        rejected = null;
      } catch (error) {
        rejected = { code: error?.code ?? null, message: error?.message ?? String(error) };
      }
      mutators.push({
        operation,
        rejected,
        databaseIdentical: before.equals(databaseBytes()),
      });
    }
    process.stdout.write(`${JSON.stringify({
      ok: true,
      active: await store.readActiveCommand(),
      readRejected,
      mutators,
    })}\n`);
  } else if (mode === 'fresh-working-read') {
    await store.finaliseRecoveryInvocation({
      invocation,
      distribution: distribution(),
      freshCommand: command(FRESH_CAPTURE_ID),
    });
    process.stdout.write(`${JSON.stringify({
      ok: true,
      capture: await store.readCapture(),
    })}\n`);
  } else if (mode === 'double-use') {
    const outcome = await store.finaliseRecoveryInvocation({
      invocation,
      distribution: distribution(),
      freshCommand: command(FRESH_CAPTURE_ID),
    });
    let secondUse;
    try {
      await store.finaliseRecoveryInvocation({
        invocation,
        distribution: distribution(),
        freshCommand: command(LOSING_CAPTURE_ID),
      });
      secondUse = null;
    } catch (error) {
      secondUse = { code: error?.code ?? null, message: error?.message ?? String(error) };
    }
    process.stdout.write(`${JSON.stringify({ ok: true, outcome, secondUse })}\n`);
  } else if (mode === 'cross-store' || mode === 'forged-pin') {
    const foreign = await openB3CaptureStore({ platform: 'ios' });
    let rejected;
    try {
      await foreign.finaliseRecoveryInvocation({
        invocation: mode === 'forged-pin' ? Object.freeze(Object.create(null)) : invocation,
        distribution: distribution(),
        freshCommand: command(FRESH_CAPTURE_ID),
      });
      rejected = null;
    } catch (error) {
      rejected = { code: error?.code ?? null, message: error?.message ?? String(error) };
    } finally {
      await foreign.close();
    }
    process.stdout.write(`${JSON.stringify({ ok: true, rejected })}\n`);
  } else if (mode === 'resume-archive' || mode === 'resume-terminal' ||
      mode === 'resume-fresh') {
    const phase = mode.slice('resume-'.length);
    await interruptAfterRecoveryCommit(store, invocation, phase);
    await store.close();
    store = await openB3CaptureStore({ platform: 'ios' });
    const retry = await store.pinRecoveryInvocation({
      acknowledgeReinstall: phase === 'fresh',
    });
    const outcome = await store.finaliseRecoveryInvocation({
      invocation: retry,
      distribution: distribution(),
      freshCommand: command(LOSING_CAPTURE_ID),
    });
    process.stdout.write(`${JSON.stringify({
      ok: true, outcome, active: await store.readActiveCommand(),
    })}\n`);
  } else {
  const before = mode === 'operator-required' ? databaseBytes() : null;
  let outcome = await store.finaliseRecoveryInvocation({
    invocation,
    distribution: distribution(),
    freshCommand: command(FRESH_CAPTURE_ID),
  });
  if (mode === 'immediate-retry') {
    const retry = await store.pinRecoveryInvocation({ acknowledgeReinstall: true });
    outcome = await store.finaliseRecoveryInvocation({
      invocation: retry,
      distribution: distribution(),
      freshCommand: command(LOSING_CAPTURE_ID),
    });
  }
  const active = await store.readActiveCommand();
  process.stdout.write(`${JSON.stringify({
    ok: true,
    outcome,
    active,
    ...(before ? { databaseIdentical: before.equals(databaseBytes()) } : {}),
  })}\n`);
  }
} catch (error) {
  process.stdout.write(`${JSON.stringify({
    ok: false,
    error: { code: error?.code ?? null, message: error?.message ?? String(error) },
  })}\n`);
} finally {
  await store?.close();
}
