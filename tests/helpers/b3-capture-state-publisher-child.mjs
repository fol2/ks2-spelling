import { createHash } from 'node:crypto';
import {
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { installB3CaptureStateRootMock } from './b3-capture-state-install-root-mock.mjs';

installB3CaptureStateRootMock();

const {
  canonicaliseB3ProofValue,
  createB3ProofObservation,
} = await import('../../src/app/b3-live-proof-protocol.js');
const { buildB3PhysicalProofAuthority } = await import(
  '../../scripts/lib/b3-capture-proof-domain.mjs'
);
const { openB3CaptureStateRepository } = await import(
  '../../scripts/lib/b3-capture-state-repository.mjs'
);
const { openB3CaptureStore } = await import('../../scripts/lib/b3-capture-store.mjs');

const COMMIT = '1'.repeat(40);
const FINGERPRINT = '2'.repeat(64);
const CAPTURE_ID = '018f1d7b-97e8-4a52-8cf2-783e5089c001';
const INSTALLATION_ID = '018f1d7b-97e8-4a52-8cf2-783e5089c002';
const mode = process.argv[2];
const observedAt = process.argv[3];
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
let publicationAttempts = 0;
let publicationPhase = 'attempt-start';

function writeOutput(output) {
  if (typeof process.send === 'function') process.send({ type: 'result', output });
  else process.stdout.write(`${JSON.stringify(output)}\n`);
}

function replaceBuildSourceInode() {
  const directory = resolve('.native-build', 'b3', 'distribution');
  const path = resolve(directory, 'build-authority.json');
  const temporary = resolve(directory, `build-authority.${process.pid}.next.json`);
  writeFileSync(temporary, readFileSync(path), { mode: 0o600, flag: 'wx' });
  renameSync(temporary, path);
}

function command() {
  const unsigned = {
    schemaVersion: 1, captureId: CAPTURE_ID, platform: 'ios-physical',
    testedApplicationCommit: COMMIT, applicationFingerprint: FINGERPRINT,
    expectedScenarioIndex: 0, expectedSequence: 1,
    previousObservationSha256: '0'.repeat(64), installationMode: 'existing',
    actionCode: 'ARM_CAPTURE',
  };
  return {
    ...unsigned,
    challengeSha256: sha256(Buffer.from(
      `ks2-spelling:b3-host-command-challenge:v1\0${canonicaliseB3ProofValue(unsigned)}`,
      'utf8',
    )),
  };
}

function projection() {
  return {
    challengeSha256: command().challengeSha256, scenarioOutcome: 'in-progress',
    entitlementState: 'none', packState: 'absent', storeCompletionObserved: false,
    storeEvents: [],
    storeAuthority: {
      environment: 'sandbox', productId: 'uk.eugnel.ks2spelling.fullks2',
      localisedPriceObserved: false, completionState: 'not-observed',
    },
    gatewayCalls: [],
    syntheticLearners: {
      syntheticAuthorityMatched: true,
      positionalSnapshotSha256: ['a'.repeat(64), 'b'.repeat(64)],
    },
    transactionAuthority: {
      source: 'none', crossCheckedOnRefresh: false,
      domainSeparatedDigestSha256: null, rawProofCleared: false,
    },
    refreshHandleLifecycle: {
      present: false, positiveVersionObserved: false, rotated: false, deleted: false,
    },
    entitlementAuthority: {
      id: null, state: 'none', domainSeparatedDigestSha256: null,
      refreshHandlePresent: false,
    },
    packAuthority: {
      packId: null, manifestSha256: null, archiveSha256: null, installed: false,
    },
    gatewaySmokeAuthority: null,
    transportAuthority: {
      storeAdapter: 'concreteCapacitorStore', gatewayAdapter: 'concreteHttpGateway',
      serverUrl: null, nativeOriginAllowed: true, noRedirects: true,
    },
  };
}

let store;
let repository;
let originalPrepare;
let originalExec;
try {
  store = await openB3CaptureStore({ platform: 'ios' });
  if (mode === 'read-empty') await store.readCapture();
  if (mode === 'read-pending') {
    repository = await openB3CaptureStateRepository({ platform: 'ios' });
    await repository.reserveInitialCaptureStart({ command: command() });
    await repository.close();
    repository = null;
    await store.readCapture();
  }
  await store.startCapture({ command: command() });
  if (mode === 'seed-only') {
    writeOutput({ seeded: true });
    process.exitCode = 0;
  } else {
  repository = await openB3CaptureStateRepository({ platform: 'ios' });
  const { command: source } = await repository.readActiveCommand();
  await repository.close();
  repository = null;

  if (mode !== 'publish') {
    let inserted = false;
    originalPrepare = DatabaseSync.prototype.prepare;
    originalExec = DatabaseSync.prototype.exec;
    DatabaseSync.prototype.prepare = function wrappedPrepare(sql) {
      const statement = originalPrepare.call(this, sql);
      if (!/INSERT\s+INTO\s+b3_capture_steps/iu.test(String(sql))) return statement;
      return new Proxy(statement, {
        get(target, property) {
          if (property === 'run') {
            return (...args) => {
              if (mode === 'death-before-insert') process.kill(process.pid, 'SIGKILL');
              const result = target.run(...args);
              inserted = true;
              if (mode === 'death-after-insert') process.kill(process.pid, 'SIGKILL');
              return result;
            };
          }
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    };
    DatabaseSync.prototype.exec = function wrappedExec(sql) {
      const statement = String(sql);
      const readBegin = /^\s*BEGIN\s*;?\s*$/iu.test(statement);
      const writeBegin = /^\s*BEGIN\s+IMMEDIATE\s*;?\s*$/iu.test(statement);
      const commit = /^\s*COMMIT\s*;?\s*$/iu.test(statement);
      const rollback = /^\s*ROLLBACK\s*;?\s*$/iu.test(statement);
      if (readBegin && publicationPhase === 'attempt-start') {
        publicationAttempts += 1;
        publicationPhase = 'preflight-open';
      } else if (readBegin && publicationPhase === 'after-preflight') {
        publicationPhase = 'verification-open';
      }
      if (writeBegin) {
        publicationPhase = 'writer-open';
        if (mode === 'signal-before-write' && publicationAttempts === 1) {
          process.send?.({ type: 'ready', attempt: publicationAttempts });
        }
        if (mode === 'drift-every-attempt') replaceBuildSourceInode();
      }
      let result;
      try {
        result = originalExec.call(this, sql);
      } catch (error) {
        if (readBegin || writeBegin) publicationPhase = 'attempt-start';
        throw error;
      }
      if (commit && publicationPhase === 'preflight-open') {
        publicationPhase = 'after-preflight';
      } else if (commit && ['verification-open', 'writer-open'].includes(publicationPhase)) {
        publicationPhase = 'done';
      } else if (rollback && [
        'preflight-open', 'verification-open', 'writer-open',
      ].includes(publicationPhase)) {
        publicationPhase = 'attempt-start';
      }
      if (mode === 'death-after-commit' && inserted && commit) {
        process.kill(process.pid, 'SIGKILL');
      }
      return result;
    };
  }

  const buildAuthority = buildB3PhysicalProofAuthority('ios', {
    schemaVersion: 1, testedApplicationCommit: COMMIT,
    applicationFingerprint: FINGERPRINT, versionName: '0.3.0-b3',
    iosBuildNumber: '19', androidVersionCode: 19,
  });
  const observation = await createB3ProofObservation({
    command: command(), buildAuthority, installationId: INSTALLATION_ID,
    sequence: 1, scenario: 'product-query', phase: 'ARMED',
    nextActionCode: 'QUERY_PRODUCT', completedTransitions: ['UNBOUND', 'ARMED'],
    proofProjection: projection(), observedAt,
  });
  const observationBytes = Buffer.from(canonicaliseB3ProofValue(observation), 'utf8');
  if (mode === 'signal-before-write') {
    process.send?.({ type: 'prepared' });
    await new Promise((resolve) => {
      process.once('message', (message) => {
        if (message?.type === 'go') resolve();
      });
    });
  }
  if (mode === 'invalid-matrix') {
    const errors = {};
    let getterCalls = 0;
    async function reject(label, operation) {
      try {
        await operation();
        errors[label] = { accepted: true };
      } catch (error) {
        errors[label] = {
          code: error?.code ?? null,
          message: error?.message ?? String(error),
        };
      }
    }
    await reject('nonUint8Array', () => store.publishObservation({
      source, observationBytes: 'not bytes',
    }));
    await reject('accessor', () => store.publishObservation({
      get source() {
        getterCalls += 1;
        return source;
      },
      observationBytes,
    }));
    await reject('empty', () => store.publishObservation({
      source, observationBytes: Buffer.alloc(0),
    }));
    await reject('oversized', () => store.publishObservation({
      source, observationBytes: Buffer.alloc(65_537, 0x61),
    }));
    await reject('malformedUtf8', () => store.publishObservation({
      source, observationBytes: Buffer.from([0xc3, 0x28]),
    }));
    await reject('malformedJson', () => store.publishObservation({
      source, observationBytes: Buffer.from('{', 'utf8'),
    }));
    await reject('nonCanonical', () => store.publishObservation({
      source,
      observationBytes: Buffer.from(JSON.stringify(observation, null, 2), 'utf8'),
    }));
    await reject('wrongPlatform', () => store.publishObservation({
      source: { ...source, platform: 'android' }, observationBytes,
    }));
    await reject('wrongBuild', () => store.publishObservation({
      source: {
        ...source,
        command: { ...source.command, testedApplicationCommit: '3'.repeat(40) },
      },
      observationBytes,
    }));
    await reject('wrongTail', () => store.publishObservation({
      source: {
        ...source,
        command: { ...source.command, previousObservationSha256: 'f'.repeat(64) },
      },
      observationBytes,
    }));
    await reject('readArgument', () => store.readCapture({ unexpected: true }));
    await store.close();
    await reject('closedPublish', () => store.publishObservation({ source, observationBytes }));
    await reject('closedRead', () => store.readCapture());
    store = null;
    const database = new DatabaseSync(resolve(
      '.native-build', 'b3', 'evidence', 'ios-capture-state', 'recovery.sqlite',
    ), { readOnly: true });
    const stepCount = database.prepare(
      'SELECT count(*) AS count FROM b3_capture_steps',
    ).get().count;
    database.close();
    writeOutput({ errors, getterCalls, stepCount });
  } else {
    const result = await store.publishObservation({ source, observationBytes });
    writeOutput({ result, attempts: publicationAttempts });
  }
  }
} catch (error) {
  writeOutput({
    error: { code: error?.code ?? null, message: error?.message ?? String(error) },
    attempts: publicationAttempts,
  });
} finally {
  if (originalPrepare) DatabaseSync.prototype.prepare = originalPrepare;
  if (originalExec) DatabaseSync.prototype.exec = originalExec;
  await repository?.close();
  await store?.close();
}
