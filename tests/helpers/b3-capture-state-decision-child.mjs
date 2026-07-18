import { createHash } from 'node:crypto';

import { installB3CaptureStateRootMock } from './b3-capture-state-install-root-mock.mjs';

installB3CaptureStateRootMock();

const { openB3CaptureStateRepository } = await import(
  '../../scripts/lib/b3-capture-state-repository.mjs'
);
const { createB3IssuedCommandStateAuthority } = await import(
  '../../scripts/lib/b3-issued-command-authority.mjs'
);
const { buildB3PhysicalProofAuthority } = await import(
  '../../scripts/lib/b3-capture-proof-domain.mjs'
);
const {
  canonicaliseB3ProofValue,
  createB3ProofObservation,
} = await import('../../src/app/b3-live-proof-protocol.js');

const INSTALLATION_ID = '018f1d7b-97e8-4a52-8cf2-783e5089c002';
const GENERIC_STATES = new Set([
  'prepared', 'stop-intent', 'stop-executing', 'host-stopped', 'launching',
  'reinstall-authorised', 'reinstall-launching', 'launched',
]);

function proofProjection(command, complete) {
  return {
    challengeSha256: command.challengeSha256,
    scenarioOutcome: complete ? 'products-visible' : 'in-progress',
    entitlementState: 'none', packState: 'absent',
    storeCompletionObserved: false,
    storeEvents: complete
      ? [{ operation: 'queryProducts', outcome: 'products-visible' }]
      : [],
    storeAuthority: {
      environment: 'sandbox', productId: 'uk.eugnel.ks2spelling.fullks2',
      localisedPriceObserved: complete, completionState: 'not-observed',
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

function challenge(commandWithoutChallenge) {
  return createHash('sha256').update(Buffer.from(
    `ks2-spelling:b3-host-command-challenge:v1\0${
      canonicaliseB3ProofValue(commandWithoutChallenge)}`,
    'utf8',
  )).digest('hex');
}

function deriveFixtureAllocationCommand(proposed, capture) {
  if (proposed.expectedSequence > 512 ||
      proposed.expectedSequence !== capture.records.length + 1) return proposed;
  const tail = capture.records.at(-1)?.observation;
  if (!tail) return proposed;
  const actionCode = tail.nextActionCode;
  const expectedScenarioIndex = actionCode === 'ARM_CAPTURE'
    ? capture.checkpoint.nextScenarioIndex
    : tail.scenarioIndex;
  const unsigned = {
    ...proposed,
    expectedScenarioIndex,
    expectedSequence: tail.sequence + 1,
    previousObservationSha256: tail.observationSha256,
    installationMode: 'existing',
    actionCode,
  };
  delete unsigned.challengeSha256;
  return { ...unsigned, challengeSha256: challenge(unsigned) };
}

async function publishFixtureStep(repository, source) {
  const capture = await repository.readCapture();
  if (capture.records.length >= source.command.expectedSequence) return;
  const command = source.command;
  const completeProductQuery = command.actionCode === 'QUERY_PRODUCT';
  const scenario = command.expectedScenarioIndex === 0 ? 'product-query' : 'cancel';
  const observation = await createB3ProofObservation({
    command,
    buildAuthority: buildB3PhysicalProofAuthority(platform, {
      schemaVersion: 1,
      testedApplicationCommit: command.testedApplicationCommit,
      applicationFingerprint: command.applicationFingerprint,
      versionName: '0.3.0-b3', iosBuildNumber: '19', androidVersionCode: 19,
    }),
    installationId: INSTALLATION_ID,
    sequence: command.expectedSequence,
    scenario,
    phase: completeProductQuery ? 'SCENARIO_COMPLETE' : 'ARMED',
    nextActionCode: completeProductQuery ? 'ARM_CAPTURE' :
      (command.expectedScenarioIndex === 0 ? 'QUERY_PRODUCT' : 'CANCEL_PURCHASE'),
    completedTransitions: completeProductQuery
      ? ['UNBOUND', 'ARMED', 'WAITING_OPERATOR', 'OBSERVING', 'SCENARIO_COMPLETE']
      : (command.expectedSequence === 1 ? ['UNBOUND', 'ARMED'] : ['ARMED']),
    proofProjection: proofProjection(command, completeProductQuery),
    observedAt: `2026-07-17T10:00:0${command.expectedSequence}.000Z`,
  });
  await repository.publishObservation({
    source,
    observationBytes: Buffer.from(canonicaliseB3ProofValue(observation), 'utf8'),
  });
}

const platform = process.argv[2];
const actions = JSON.parse(Buffer.from(process.argv[3], 'base64url').toString('utf8'));
let repository;
let repositoryClosed = false;
let sourceGetterCalls = 0;
let commandGetterCalls = 0;
let optionGetterCalls = 0;
let allocationCommandGetterCalls = 0;
const synchronousGetterSnapshots = [];
const synchronousAllocationGetterSnapshots = [];
try {
  repository = await openB3CaptureStateRepository({ platform });
  const initial = await repository.readActiveCommand();
  let source = initial.kind === 'active' ? initial.command : null;
  const sources = new Map();
  if (source) {
    sources.set(source.state, source);
    sources.set('A', source);
  }
  const results = [];
  for (const action of actions) {
    let selectedSource;
    if (action.sourceSnapshot !== undefined) {
      selectedSource = action.sourceSnapshot;
    } else if (action.sourceName !== undefined) {
      selectedSource = sources.get(action.sourceName);
    } else {
      selectedSource = action.sourceState === undefined
        ? source
        : sources.get(action.sourceState);
    }
    if (action.op !== 'allocate' && !selectedSource) {
      throw new Error(`decision helper source is absent: ${action.sourceName ?? action.sourceState}`);
    }
    if (action.forgeState) {
      try {
        const forged = createB3IssuedCommandStateAuthority({
          platform,
          command: selectedSource.command,
          state: action.forgeState,
        });
        selectedSource = {
          ...selectedSource,
          state: forged.state,
          recordSha256: forged.recordSha256,
        };
      } catch {
        selectedSource = { ...selectedSource, state: action.forgeState };
      }
    }
    if (action.malformedCommand) {
      selectedSource = {
        ...selectedSource,
        command: {
          ...selectedSource.command,
          challengeSha256: 'not-a-hash',
        },
      };
    }
    if (action.mutateBeforeAwait && action.op !== 'allocate') {
      selectedSource = {
        ...selectedSource,
        command: { ...selectedSource.command },
      };
    }
    if (action.op === 'consume' && !action.withoutStep) {
      const current = await repository.readActiveCommand();
      if (current.kind === 'active' &&
          GENERIC_STATES.has(selectedSource.state) &&
          current.command.commandSha256 === selectedSource.commandSha256 &&
          current.command.state === selectedSource.state) {
        await publishFixtureStep(repository, selectedSource);
      }
    }
    if (action.countGetters && action.op !== 'allocate') {
      const originalSource = selectedSource;
      const originalCommand = originalSource.command;
      const countedCommand = Object.fromEntries(Object.keys(originalCommand).map((key) => [
        key,
        undefined,
      ]));
      for (const key of Object.keys(originalCommand)) {
        Object.defineProperty(countedCommand, key, {
          enumerable: true,
          get() {
            commandGetterCalls += 1;
            return originalCommand[key];
          },
        });
      }
      const countedSource = Object.fromEntries(Object.keys(originalSource).map((key) => [
        key,
        undefined,
      ]));
      for (const key of Object.keys(originalSource)) {
        Object.defineProperty(countedSource, key, {
          enumerable: true,
          get() {
            sourceGetterCalls += 1;
            return key === 'command' ? countedCommand : originalSource[key];
          },
        });
      }
      selectedSource = countedSource;
    }
    let result;
    try {
      if (action.op === 'close-transition' || action.op === 'close-consume' ||
          action.op === 'close-allocate') {
        await repository.close();
        repositoryClosed = true;
      }
      if (action.op === 'transition-extra') {
        result = await repository.transitionCommand({
          get source() {
            optionGetterCalls += 1;
            throw new Error('closed options must reject before reading source');
          },
          nextState: action.nextState,
          unexpected: true,
        });
      } else if (action.op === 'consume-extra') {
        result = await repository.consumeCommand({
          get source() {
            optionGetterCalls += 1;
            throw new Error('closed options must reject before reading source');
          },
          unexpected: true,
        });
      } else if (action.op === 'allocate-extra') {
        result = await repository.allocateNextCommand({
          get command() {
            optionGetterCalls += 1;
            throw new Error('closed options must reject before reading command');
          },
          unexpected: true,
        });
      } else if (action.op === 'publish') {
        await publishFixtureStep(repository, selectedSource);
        result = { kind: 'published-fixture-step' };
      } else if (action.op === 'allocate' || action.op === 'close-allocate') {
        let allocationCommand = action.mutateBeforeAwait
          ? { ...action.command }
          : action.command;
        const allocationState = await repository.readActiveCommand();
        if (allocationState.kind !== 'start-reserved') {
          allocationCommand = deriveFixtureAllocationCommand(
            allocationCommand,
            await repository.readCapture(),
          );
        }
        if (action.countAllocationGetters) {
          const originalCommand = allocationCommand;
          const countedCommand = Object.fromEntries(Object.keys(originalCommand).map((key) => [
            key,
            undefined,
          ]));
          for (const key of Object.keys(originalCommand)) {
            Object.defineProperty(countedCommand, key, {
              enumerable: true,
              get() {
                allocationCommandGetterCalls += 1;
                return originalCommand[key];
              },
            });
          }
          allocationCommand = countedCommand;
        }
        const operation = repository.allocateNextCommand({ command: allocationCommand });
        if (action.observeBeforeAwait) {
          synchronousAllocationGetterSnapshots.push(allocationCommandGetterCalls);
        }
        if (action.mutateBeforeAwait) {
          allocationCommand.challengeSha256 = 'e'.repeat(64);
          allocationCommand.expectedSequence = 99;
        }
        result = await operation;
      } else if (action.op === 'transition' || action.op === 'close-transition') {
        const operation = repository.transitionCommand({
          source: selectedSource,
          nextState: action.nextState,
        });
        if (action.observeBeforeAwait) {
          synchronousGetterSnapshots.push({
            sourceGetterCalls,
            commandGetterCalls,
          });
        }
        if (action.mutateBeforeAwait) {
          selectedSource.state = 'launched';
          selectedSource.recordSha256 = 'f'.repeat(64);
          selectedSource.command.challengeSha256 = 'e'.repeat(64);
        }
        result = await operation;
      } else {
        const operation = repository.consumeCommand({ source: selectedSource });
        if (action.observeBeforeAwait) {
          synchronousGetterSnapshots.push({
            sourceGetterCalls,
            commandGetterCalls,
          });
        }
        if (action.mutateBeforeAwait) {
          selectedSource.state = 'launched';
          selectedSource.recordSha256 = 'f'.repeat(64);
          selectedSource.command.challengeSha256 = 'e'.repeat(64);
        }
        result = await operation;
      }
    } catch (error) {
      if (!action.expectError) throw error;
      result = {
        kind: 'error',
        code: error?.code ?? null,
        message: error?.message ?? String(error),
      };
    }
    results.push(result);
    if (result.command) {
      source = result.command;
      sources.set(source.state, source);
      if (action.saveAs) sources.set(action.saveAs, source);
    }
  }
  const final = repositoryClosed
    ? { kind: 'closed' }
    : await repository.readActiveCommand();
  process.stdout.write(`${JSON.stringify({
    ok: true,
    results,
    final,
    sourceGetterCalls,
    commandGetterCalls,
    optionGetterCalls,
    allocationCommandGetterCalls,
    synchronousGetterSnapshots,
    synchronousAllocationGetterSnapshots,
  })}\n`);
} catch (error) {
  process.stdout.write(`${JSON.stringify({
    ok: false,
    error: { code: error?.code ?? null, message: error?.message ?? String(error) },
  })}\n`);
} finally {
  if (!repositoryClosed) await repository?.close();
}
