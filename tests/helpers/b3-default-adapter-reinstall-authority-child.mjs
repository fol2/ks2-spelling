import { mock } from 'node:test';

import { installB3CaptureStateRootMock } from './b3-capture-state-install-root-mock.mjs';

installB3CaptureStateRootMock();

const platform = process.argv[2];
const order = process.argv[3];
if (!['ios', 'android'].includes(platform) ||
    !['recovery-first', 'planned-first'].includes(order)) {
  throw new Error('B3 default-adapter reinstall test authority is invalid');
}

const actualController = await import('../../scripts/lib/b3-store-backed-live-capture.mjs');
const actualPrerequisites = await import('../../scripts/check-b3-external-prerequisites.mjs');
const { openB3CaptureStore } = await import('../../scripts/lib/b3-capture-store.mjs');
const { buildB3PhysicalProofAuthority } = await import(
  '../../scripts/lib/b3-capture-proof-domain.mjs'
);
const {
  B3_ANDROID_SCENARIOS,
  B3_IOS_SCENARIOS,
} = await import('../../scripts/lib/b3-evidence.mjs');
const {
  B3_TEST_COMMIT,
  B3_TEST_HASH,
  platformEvidence,
} = await import('./b3-evidence-fixtures.mjs');

let projectedCapture = null;
let plannedAdvances = 0;
let recoveryCallbackCalls = 0;
let disposals = 0;

mock.module('../../scripts/lib/b3-store-backed-live-capture.mjs', {
  namedExports: {
    createB3StoreBackedLiveCapture(options) {
      const controller = actualController.createB3StoreBackedLiveCapture({
        ...options,
        consumeReinstallAcknowledgement() {
          recoveryCallbackCalls += 1;
          return options.consumeReinstallAcknowledgement();
        },
      });
      return Object.freeze({
        ...controller,
        async readCapture() {
          return projectedCapture ?? controller.readCapture();
        },
        async advance() {
          plannedAdvances += 1;
          throw new Error('planned-resume-advanced-once');
        },
        async dispose() {
          disposals += 1;
          return controller.dispose();
        },
      });
    },
  },
});

mock.module('../../scripts/check-b3-external-prerequisites.mjs', {
  namedExports: {
    parseB3StrictJsonBytes: actualPrerequisites.parseB3StrictJsonBytes,
    async readApprovedB3PlayCertificate() {
      return '5'.repeat(64);
    },
  },
});

mock.module('../../scripts/lib/b3-distribution-inspectors.mjs', {
  namedExports: {
    createDefaultB3DistributionInspectors() {
      return Object.freeze({
        async artifactInspector() { return Object.freeze({}); },
        async deviceInspector() { return Object.freeze({}); },
      });
    },
  },
});

function mappedDistribution() {
  return platformEvidence(
    platform === 'ios' ? 'ios-physical' : 'android-play-physical',
  ).distribution;
}

function inspectorDistribution() {
  const distribution = mappedDistribution();
  return platform === 'ios'
    ? Object.freeze({ ...distribution, build: distribution.iosBuildNumber })
    : Object.freeze({ ...distribution, versionCode: distribution.androidVersionCode });
}

mock.module('../../scripts/verify-b3-installed-distribution.mjs', {
  namedExports: {
    async verifyB3InstalledDistributionWithInspectors() {
      return inspectorDistribution();
    },
  },
});

const {
  createDefaultB3AndroidCaptureAdapter,
  createDefaultB3IosCaptureAdapter,
} = await import('../../scripts/lib/b3-live-capture-adapters.mjs');

function buildAuthority() {
  return buildB3PhysicalProofAuthority(platform, {
    schemaVersion: 1,
    testedApplicationCommit: B3_TEST_COMMIT,
    applicationFingerprint: B3_TEST_HASH,
    versionName: '0.3.0-b3',
    iosBuildNumber: '19',
    androidVersionCode: 19,
  });
}

async function seedRestartRequired() {
  const store = await openB3CaptureStore({ platform });
  try {
    const command = actualController.deriveB3NextStoreCommand({
      platform,
      buildAuthority: buildAuthority(),
      capture: null,
      uuidFactory: () => '018f1d7b-97e8-4a52-8cf2-783e5089c001',
    });
    await store.startCapture({ command });
    let source = (await store.readActiveCommand()).command;
    source = (await store.transitionCommand({
      source,
      nextState: 'launching',
    })).command;
    await store.transitionCommand({ source, nextState: 'restart-required' });
  } finally {
    await store.close();
  }
}

function plannedRebindProjection() {
  const captureId = '018f1d7b-97e8-4a52-8cf2-783e5089c009';
  return Object.freeze({
    schemaVersion: 1,
    platform,
    captureId,
    records: Object.freeze([Object.freeze({
      command: Object.freeze({ captureId }),
      observation: Object.freeze({
        captureId,
        scenario: 'pack-install',
        phase: 'SCENARIO_COMPLETE',
        nextActionCode: 'REBIND_FRESH_INSTALL',
        observationSha256: '9'.repeat(64),
      }),
    })]),
    checkpoint: null,
    gatewaySmokeProjection: null,
  });
}

await seedRestartRequired();
const adapter = platform === 'ios'
  ? createDefaultB3IosCaptureAdapter({
      root: process.cwd(),
      env: { B3_IOS_SIGNED_IPA_PATH: '/signed/b3.ipa' },
      resumeReinstall: true,
      wait: async () => {},
    })
  : createDefaultB3AndroidCaptureAdapter({
      root: process.cwd(),
      env: {
        B3_ANDROID_SIGNED_AAB_PATH: '/signed/b3.aab',
        B3_PREREQUISITES_FILE: '/approved/prerequisites.json',
      },
      resumeReinstall: true,
      wait: async () => {},
    });

let result;
try {
  const scenario = (platform === 'ios' ? B3_IOS_SCENARIOS : B3_ANDROID_SCENARIOS)
    .find(({ scenario: name }) => name === 'restore-after-reinstall');
  if (!scenario) throw new Error('B3 restore scenario authority is absent');
  if (order === 'recovery-first') {
    const invocation = await adapter.pinInvocation();
    const recovery = await adapter.finaliseInvocation({
      invocation,
      distribution: mappedDistribution(),
    });
    projectedCapture = plannedRebindProjection();
    let plannedInstruction = null;
    try {
      await adapter.runScenario(structuredClone(scenario));
    } catch (error) {
      plannedInstruction = error?.instructionCode ?? null;
    }
    result = {
      recovery,
      plannedInstruction,
      plannedAdvances,
      recoveryCallbackCalls,
    };
  } else {
    projectedCapture = plannedRebindProjection();
    let plannedAdvanceError = null;
    try {
      await adapter.runScenario(structuredClone(scenario));
    } catch (error) {
      plannedAdvanceError = error?.message ?? String(error);
    }
    const invocation = await adapter.pinInvocation();
    const recovery = await adapter.finaliseInvocation({
      invocation,
      distribution: mappedDistribution(),
    });
    result = {
      plannedAdvanceError,
      plannedAdvances,
      recovery,
      recoveryCallbackCalls,
    };
  }
} catch (error) {
  result = {
    error: { code: error?.code ?? null, message: error?.message ?? String(error) },
  };
} finally {
  await adapter.dispose();
}

process.stdout.write(`${JSON.stringify({
  ok: !result.error,
  platform,
  order,
  disposals,
  ...result,
})}\n`);
