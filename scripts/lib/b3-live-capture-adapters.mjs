import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import {
  parseB3StrictJsonBytes,
  readApprovedB3PlayCertificate,
} from '../check-b3-external-prerequisites.mjs';
import {
  B3_ANDROID_SCENARIOS,
  B3_IOS_SCENARIOS,
  B3_SYNTHETIC_LEARNER_AUTHORITY_SHA256,
  B3_SYNTHETIC_LEARNER_DIGESTS,
} from './b3-evidence.mjs';
import {
  buildB3PhysicalProofAuthority,
  deriveB3DeviceGatewaySmokeProjection,
  deriveB3ProofObservationChain,
  deriveB3ScenarioTransition,
} from './b3-capture-proof-domain.mjs';
import { createB3PhysicalDeviceTransport } from './b3-physical-device-transport.mjs';
import { captureB3IosScreenshotBytes } from './b3-ios-proof-screenshot.mjs';
import {
  captureB3PlayProtectSettingsScreenshot,
  inspectB3PlayProtectRootAttestation,
} from './b3-play-protect-attestation.mjs';
import { createDefaultB3DistributionInspectors } from './b3-distribution-inspectors.mjs';
import {
  verifyB3InstalledDistributionWithInspectors,
} from '../verify-b3-installed-distribution.mjs';
import { validateB3ReportPngBytes } from './b3-png.mjs';
import { publishB3FinalProofOutput } from './b3-final-proof-output.mjs';
import { createB3StoreBackedLiveCapture } from './b3-store-backed-live-capture.mjs';

export function extractB3DeviceGatewaySmokeProjection({ retained }) {
  if (!Array.isArray(retained) || retained.length === 0) {
    throw captureError('B3 device gateway smoke journal is empty');
  }
  const candidates = retained.filter(({ observation }) =>
    observation?.proofProjection?.gatewaySmokeAuthority !== null &&
    observation?.proofProjection?.gatewaySmokeAuthority !== undefined);
  if (candidates.length !== 1) {
    throw captureError('B3 device gateway smoke must occur exactly once');
  }
  const [{ observation }] = candidates;
  if (observation.scenario !== 'pack-install' ||
      observation.phase !== 'SCENARIO_COMPLETE' ||
      !observation.proofProjection.gatewayCalls.some(({ operation, relation }) =>
        operation === 'authorise' && relation === 'download-capability-authorisation')) {
    throw captureError('B3 device gateway smoke is not bound to pack-install authorisation');
  }
  try {
    const projection = deriveB3DeviceGatewaySmokeProjection(retained);
    if (projection === null) {
      throw captureError('B3 device gateway smoke must occur exactly once');
    }
    return projection;
  } catch (error) {
    if (error?.code === 'b3_live_capture_invalid') throw error;
    throw captureError(error?.message ?? 'B3 device gateway smoke is invalid');
  }
}

const MAXIMUM_SCREENSHOT_BYTES = 64 * 1024 * 1024;
const MAXIMUM_DETERMINISTIC_REPORT_BYTES = 1024 * 1024;
const PLATFORM = Object.freeze({
  ios: Object.freeze({
    commandPlatform: 'ios-physical',
    signedEnvironment: 'B3_IOS_SIGNED_IPA_PATH',
    distribution: 'development',
  }),
  android: Object.freeze({
    commandPlatform: 'android-play-physical',
    signedEnvironment: 'B3_ANDROID_SIGNED_AAB_PATH',
    distribution: 'play-internal',
  }),
});

function captureError(message, code = 'b3_live_capture_invalid') {
  return Object.assign(new Error(message), { code });
}

function platformName(platform) {
  if (!Object.hasOwn(PLATFORM, platform)) {
    throw captureError('B3 live-capture platform is invalid');
  }
  return platform;
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function exactKeys(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

export async function inspectB3DeterministicStoreKitReport({ root }) {
  const canonicalRoot = await realpath(resolve(root));
  const path = resolve(canonicalRoot, 'reports/b3/deterministic-proof.json');
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 ||
      metadata.size <= 0 || metadata.size > MAXIMUM_DETERMINISTIC_REPORT_BYTES ||
      await realpath(path) !== path) {
    throw captureError('B3 deterministic StoreKit report file authority is invalid');
  }
  const bytes = await readFile(path);
  const report = parseB3StrictJsonBytes(bytes, 'B3 deterministic proof report');
  const block = report?.nonLiveStoreKit;
  const expectedCases = [
    { name: 'delayed-approve', initialOutcome: 'pending', finalOutcome: 'purchased' },
    { name: 'delayed-decline', initialOutcome: 'pending', finalOutcome: 'cancelled' },
  ];
  if (report?.status !== 'pass' ||
      report?.evidenceBoundary?.liveStoreProof !== false ||
      report?.evidenceBoundary?.physicalDeviceProof !== false ||
      !exactKeys(block, ['evidenceKind', 'physicalSandbox', 'liveStore', 'cases']) ||
      block.evidenceKind !== 'xcode-storekit-test-non-live' ||
      block.physicalSandbox !== false || block.liveStore !== false ||
      !isDeepStrictEqual(block.cases, expectedCases)) {
    throw captureError('B3 deterministic StoreKit authority differs from the closed transcript');
  }
  return Object.freeze({
    reportSha256: sha256(bytes),
    scenarios: Object.freeze([
      'storekit-test-pending-approve',
      'storekit-test-pending-decline',
    ]),
    liveSandbox: false,
  });
}

function validateScreenshotBytes(rawBytes) {
  try {
    return validateB3ReportPngBytes(rawBytes, {
      maximumBytes: MAXIMUM_SCREENSHOT_BYTES,
      label: 'B3 committable screenshot',
    }).bytes;
  } catch {
    throw captureError('B3 screenshot is not a bounded original-resolution PNG');
  }
}

export async function persistB3PlatformScreenshot({ root, platform, bytes: rawBytes }) {
  const name = platformName(platform);
  const bytes = validateScreenshotBytes(rawBytes);
  await publishB3FinalProofOutput({
    root,
    output: `reports/b3/${name}-sandbox-proof.png`,
    bytes,
  });
  return Object.freeze({
    path: `reports/b3/${name}-sandbox-proof.png`,
    sha256: sha256(bytes),
  });
}
function remainingCaptureDeadline(deadlineMs, monotonicClock) {
  if (deadlineMs === undefined) return null;
  if (!Number.isFinite(deadlineMs) || typeof monotonicClock !== 'function') {
    throw captureError('B3 slow-card capture deadline authority is invalid');
  }
  const now = monotonicClock();
  if (!Number.isFinite(now) || now < 0 || now >= deadlineMs) {
    throw captureError(
      'B3 slow-card polling exceeded ten minutes',
      'b3_slow_card_poll_timeout',
    );
  }
  return deadlineMs - now;
}

const HOST_OPERATOR_ACTIONS = Object.freeze(new Set([
  'APPROVE_PENDING_PURCHASE',
  'DECLINE_PENDING_PURCHASE',
]));

export function createB3StoreActionResumeAuthority(enabled, binding = null) {
  if (typeof enabled !== 'boolean') {
    throw captureError('B3 store-action resume authority is invalid');
  }
  if (enabled && (!binding || !HOST_OPERATOR_ACTIONS.has(binding.actionCode) ||
      !/^[0-9a-f]{64}$/u.test(binding.observationSha256 ?? ''))) {
    throw captureError('B3 store-action resume flag has no retained invocation-tail authority');
  }
  let consumed = false;
  return Object.freeze(({ actionCode, observationSha256 } = {}) => {
    if (!enabled || consumed || !HOST_OPERATOR_ACTIONS.has(actionCode) ||
        !/^[0-9a-f]{64}$/u.test(observationSha256 ?? '') ||
        actionCode !== binding.actionCode || observationSha256 !== binding.observationSha256) {
      return false;
    }
    consumed = true;
    return true;
  });
}

export async function driveB3HostScenario({
  authority,
  readRecords,
  advance,
  resumeStoreAction = false,
  resumeReinstall = false,
  maximumCommands = 16,
}) {
  if (typeof readRecords !== 'function' || typeof advance !== 'function' ||
      !['boolean', 'function'].includes(typeof resumeStoreAction) ||
      !['boolean', 'function'].includes(typeof resumeReinstall) ||
      !Number.isSafeInteger(maximumCommands) || maximumCommands < 1 || maximumCommands > 16) {
    throw captureError('B3 host scenario driver options are invalid');
  }
  let storeActionResumed = false;
  for (let count = 0; count <= maximumCommands; count += 1) {
    const retained = await readRecords();
    if (retained.length > 0) {
      const nextAction = retained.at(-1).observation.nextActionCode;
      let operatorGateResumed = false;
      if (HOST_OPERATOR_ACTIONS.has(nextAction)) {
        const resumeAllowed = typeof resumeStoreAction === 'function'
          ? resumeStoreAction(Object.freeze({
              actionCode: nextAction,
              observationSha256: retained.at(-1).observation.observationSha256,
            }))
          : resumeStoreAction;
        if (!resumeAllowed || storeActionResumed) {
          throw operatorRequired(nextAction);
        }
        storeActionResumed = true;
        operatorGateResumed = true;
      }
      if (nextAction === 'REBIND_FRESH_INSTALL') {
        const resumeAllowed = typeof resumeReinstall === 'function'
          ? resumeReinstall(Object.freeze({
              actionCode: nextAction,
              observationSha256: retained.at(-1).observation.observationSha256,
            }))
          : resumeReinstall;
        if (!resumeAllowed) throw operatorRequired('REINSTALL_EXACT_BUILD');
        operatorGateResumed = true;
      }
      if (!operatorGateResumed) {
        try {
          return deriveB3ScenarioTransition({ records: retained, authority });
        } catch (error) {
          if (!/absent|outcome/u.test(error?.message ?? '')) throw error;
        }
      }
    }
    if (count === maximumCommands) break;
    await advance();
  }
  throw captureError('B3 host scenario exceeded its closed command bound');
}

export async function driveB3HostUntilPhase({
  scenario,
  phase,
  readRecords,
  advance,
  maximumCommands = 16,
}) {
  if (typeof scenario !== 'string' || typeof phase !== 'string' ||
      typeof readRecords !== 'function' || typeof advance !== 'function' ||
      !Number.isSafeInteger(maximumCommands) || maximumCommands < 1 || maximumCommands > 16) {
    throw captureError('B3 host phase driver options are invalid');
  }
  for (let count = 0; count <= maximumCommands; count += 1) {
    const tail = (await readRecords()).at(-1)?.observation;
    if (tail?.scenario === scenario && tail.phase === phase) return tail;
    if (count === maximumCommands) break;
    await advance();
  }
  throw captureError('B3 host phase driver exceeded its closed command bound');
}

export function createB3AndroidSlowCardController({
  readRecords,
  consumeStoreActionResume,
  pollFreshProcess,
  deriveTransition = ({ records, authority }) =>
    deriveB3ScenarioTransition({ records, authority }),
} = {}) {
  if (typeof readRecords !== 'function' ||
      typeof consumeStoreActionResume !== 'function' ||
      typeof pollFreshProcess !== 'function' ||
      typeof deriveTransition !== 'function') {
    throw captureError('B3 Android slow-card controller options are invalid');
  }
  let activeScenario = null;
  let terminalState = null;

  function expectedTerminal(authority) {
    return authority?.scenario === 'slow-card-pending-decline' ? 'declined' : 'approved';
  }

  function deriveIfTerminal(records, authority) {
    try {
      const transition = deriveTransition({ records, authority });
      terminalState = expectedTerminal(authority);
      return transition;
    } catch (error) {
      if (!/absent|outcome/u.test(error?.message ?? '')) throw error;
      return null;
    }
  }

  function currentBudget(timing) {
    if (timing === undefined) return Object.freeze({});
    if (!timing || typeof timing !== 'object' ||
        typeof timing.monotonicClock !== 'function' ||
        !Number.isFinite(timing.deadlineMs)) {
      throw captureError('B3 Android slow-card timing authority is invalid');
    }
    const remainingMs = remainingCaptureDeadline(
      timing.deadlineMs,
      timing.monotonicClock,
    );
    return Object.freeze({
      deadlineMs: timing.deadlineMs,
      monotonicClock: timing.monotonicClock,
      remainingMs,
    });
  }

  async function begin(authority, timing) {
    if (!['slow-card-pending-decline', 'slow-card-pending-approve']
      .includes(authority?.scenario)) {
      throw captureError('B3 Android slow-card scenario authority is invalid');
    }
    if (activeScenario !== authority.scenario) terminalState = null;
    activeScenario = authority.scenario;
    for (let count = 0; count <= 16; count += 1) {
      const retained = await readRecords();
      if (deriveIfTerminal(retained, authority)) return;
      const tail = retained.at(-1)?.observation;
      const expectedAction = authority.scenario.endsWith('decline')
        ? 'DECLINE_PENDING_PURCHASE'
        : 'APPROVE_PENDING_PURCHASE';
      if (tail?.scenario === authority.scenario && tail.phase === 'OBSERVING' &&
          tail.nextActionCode === expectedAction) {
        if (!consumeStoreActionResume({
          actionCode: expectedAction,
          observationSha256: tail.observationSha256,
        })) throw operatorRequired(expectedAction);
        return;
      }
      if (count === 16) break;
      await pollFreshProcess({ authority, phase: 'arm', ...currentBudget(timing) });
    }
    throw captureError('B3 Android slow-card arming exceeded its closed command bound');
  }

  async function poll(authority, timing) {
    if (authority?.scenario !== activeScenario) {
      throw captureError('B3 Android slow-card poll differs from the armed scenario');
    }
    if (terminalState) return terminalState;
    await pollFreshProcess({ authority, phase: 'poll', ...currentBudget(timing) });
    const retained = await readRecords();
    deriveIfTerminal(retained, authority);
    return terminalState ?? 'pending';
  }

  async function finish(authority) {
    if (authority?.scenario !== activeScenario || !terminalState) {
      throw captureError('B3 Android slow-card finish has no terminal authority');
    }
    return deriveTransition({ records: await readRecords(), authority });
  }

  return Object.freeze({ begin, poll, finish });
}

function mapDistribution(platform, value) {
  return platform === 'ios'
    ? Object.freeze({
        embeddedCommit: value.embeddedCommit,
        embeddedFingerprint: value.embeddedFingerprint,
        versionName: value.versionName,
        kind: 'development',
        iosBuildNumber: value.build,
        signedIpaSha256: value.signedIpaSha256,
        ipaEmbeddedAuthoritySha256: value.ipaEmbeddedAuthoritySha256,
        codeSigningCertificateSha256: value.codeSigningCertificateSha256,
        installedBundleId: value.installedBundleId,
        installedVersion: value.installedVersion,
        installedBuild: value.installedBuild,
        installedEmbeddedAuthoritySha256: value.installedEmbeddedAuthoritySha256,
        installedBuiltByDeveloper: value.installedBuiltByDeveloper,
        sandboxReceiptVerified: value.sandboxReceiptVerified,
      })
    : Object.freeze({
        embeddedCommit: value.embeddedCommit,
        embeddedFingerprint: value.embeddedFingerprint,
        versionName: value.versionName,
        kind: 'play-internal',
        androidVersionCode: value.versionCode,
        signedAabSha256: value.signedAabSha256,
        aabEmbeddedAuthoritySha256: value.aabEmbeddedAuthoritySha256,
        playAppSigningCertificateSha256: value.playAppSigningCertificateSha256,
        installer: value.installer,
        installedEmbeddedAuthoritySha256: value.installedEmbeddedAuthoritySha256,
        pmPathOrderVerified: value.pmPathOrderVerified,
        installedApks: value.installedApks,
      });
}

async function readBuildExpected(root) {
  return parseB3StrictJsonBytes(
    await readFile(resolve(root, '.native-build/b3/distribution/build-authority.json')),
    'B3 distribution build authority',
  );
}

export function buildAuthorityFor(platform, expected) {
  return buildB3PhysicalProofAuthority(platform, expected);
}

function operatorRequired(instructionCode) {
  const messages = Object.freeze({
    START_CAPTURE: 'Start or resume the closed physical-device B3 capture journey.',
    COMPLETE_STORE_ACTION: 'Complete the displayed sandbox store action on the physical device.',
    APPROVE_PENDING_PURCHASE: 'Approve the displayed pending sandbox purchase on the device.',
    DECLINE_PENDING_PURCHASE: 'Decline the displayed pending sandbox purchase on the device.',
    REINSTALL_EXACT_BUILD: 'Reinstall the exact approved B3 distribution, then resume capture.',
    SHOW_PLAY_PROTECT_SETTINGS: 'Open the Play Protect certification settings on the approved device.',
    ATTEST_PLAY_PROTECT_SETTINGS: 'Inspect and attest the retained Play Protect settings screenshot.',
  });
  if (!Object.hasOwn(messages, instructionCode)) {
    throw captureError('B3 operator instruction code is invalid');
  }
  const error = new Error(messages[instructionCode]);
  error.code = 'b3_operator_action_required';
  error.instructionCode = instructionCode;
  return error;
}

export function deriveB3DeviceStoreEvidence({
  platform,
  retained,
  device,
  playProtect,
}) {
  if (!Object.hasOwn(PLATFORM, platform) || !Array.isArray(retained) ||
      !exactKeys(device, ['model', 'osVersion', 'physical']) ||
      typeof device.model !== 'string' || typeof device.osVersion !== 'string' ||
      device.physical !== true) {
    throw captureError('B3 physical device/store retained authority is incomplete');
  }
  deriveB3ScenarioTransition({
    records: retained,
    authority: { scenario: 'product-query', outcome: 'products-visible', traces: [] },
  });
  const completionScenario = platform === 'ios'
    ? 'unfinished-relaunch'
    : 'unacknowledged-relaunch';
  const scenarioAuthorities = platform === 'ios' ? B3_IOS_SCENARIOS : B3_ANDROID_SCENARIOS;
  deriveB3ScenarioTransition({
    records: retained,
    authority: scenarioAuthorities.find(({ scenario }) => scenario === completionScenario),
  });
  const expectedProductId = platform === 'ios'
    ? 'uk.eugnel.ks2spelling.fullks2'
    : 'full_ks2';
  const expectedCompletionState = platform === 'ios' ? 'finished' : 'acknowledged';
  const productVisible = retained.some(({ observation }) =>
      observation.scenario === 'product-query' &&
      observation.proofProjection.storeAuthority.environment === 'sandbox' &&
      observation.proofProjection.storeAuthority.productId === expectedProductId &&
      observation.proofProjection.storeAuthority.localisedPriceObserved === true &&
      observation.proofProjection.storeEvents.some((event) =>
        event.operation === 'queryProducts' && event.outcome === 'products-visible'));
  const completed = retained.some(({ observation }) =>
      observation.scenario === completionScenario &&
      observation.phase === 'SCENARIO_COMPLETE' &&
      observation.proofProjection.storeCompletionObserved === true &&
      observation.proofProjection.storeAuthority.environment === 'sandbox' &&
      observation.proofProjection.storeAuthority.productId === expectedProductId &&
      observation.proofProjection.storeAuthority.completionState === expectedCompletionState &&
      observation.proofProjection.transactionAuthority.rawProofCleared === true &&
      observation.proofProjection.storeEvents.some((event) =>
        ['queryTransactions', 'transaction-update'].includes(event.operation) &&
        event.outcome === 'purchased') &&
      observation.proofProjection.storeEvents.some((event) =>
        event.operation === 'finishTransaction' && event.outcome === 'finished') &&
      observation.proofProjection.gatewayCalls.some((call) =>
        call.operation === 'complete' && call.relation === 'completion-of-prior-verify'));
  if (!productVisible || !completed) {
    throw captureError('B3 product price or store completion authority is absent');
  }
  const store = Object.freeze({
    environment: platform === 'ios' ? 'sandbox' : 'play-test',
    productId: expectedProductId,
    localisedPriceObserved: true,
  });
  if (platform === 'ios') {
    return Object.freeze({
      device: Object.freeze({ ...device }),
      store,
      storeCompletion: Object.freeze({ finished: true }),
    });
  }
  if (!exactKeys(playProtect, [
    'playCertified',
    'playProtectSettingsScreenshotSha256',
    'playProtectRootAttestationSha256',
    'attestationPath',
  ]) || playProtect.playCertified !== true ||
      !/^[0-9a-f]{64}$/u.test(playProtect.playProtectSettingsScreenshotSha256) ||
      !/^[0-9a-f]{64}$/u.test(playProtect.playProtectRootAttestationSha256)) {
    throw captureError('B3 Play Protect retained authority is incomplete');
  }
  return Object.freeze({
    device: Object.freeze({
      ...device,
      playCertified: true,
      playProtectSettingsScreenshotSha256:
        playProtect.playProtectSettingsScreenshotSha256,
      playProtectRootAttestationSha256:
        playProtect.playProtectRootAttestationSha256,
    }),
    store,
    storeCompletion: Object.freeze({ acknowledged: true }),
  });
}

export function deriveB3TerminalEvidenceProjection({
  terminal,
  restoreRecord,
  preReinstallRecord,
  redownloadRecord,
  positiveVersionObserved,
  redownloadTransitionValidated,
}) {
  const projection = terminal?.proofProjection;
  const entitlement = projection?.entitlementAuthority;
  const pack = projection?.packAuthority;
  const restoreProjection = restoreRecord?.proofProjection;
  const restoreDigests = restoreProjection?.syntheticLearners?.positionalSnapshotSha256;
  const hash = (value) => typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value);
  if (terminal?.phase !== 'TERMINAL_CAPTURE' || redownloadTransitionValidated !== true ||
      positiveVersionObserved !== true || entitlement?.id !== 'full-ks2' ||
      entitlement.state !== 'revoked' ||
      !hash(entitlement.domainSeparatedDigestSha256) ||
      entitlement.refreshHandlePresent !== false || pack?.packId !== 'b3-sandbox-proof' ||
      pack.installed !== true || !hash(pack.manifestSha256) ||
      !hash(pack.archiveSha256) ||
      restoreRecord?.installationId === preReinstallRecord?.installationId ||
      restoreProjection?.entitlementAuthority?.state !== 'active' ||
      restoreProjection?.entitlementAuthority?.refreshHandlePresent !== true ||
      restoreProjection?.refreshHandleLifecycle?.present !== true ||
      restoreProjection?.refreshHandleLifecycle?.positiveVersionObserved !== true ||
      restoreProjection?.packAuthority?.installed !== true ||
      redownloadRecord?.proofProjection?.packAuthority?.installed !== true ||
      projection.transactionAuthority.rawProofCleared !== true ||
      restoreDigests?.[0] !==
        B3_SYNTHETIC_LEARNER_DIGESTS['after-fresh-install-reseed'].learnerA ||
      restoreDigests?.[1] !==
        B3_SYNTHETIC_LEARNER_DIGESTS['after-fresh-install-reseed'].learnerB) {
    throw captureError('B3 terminal retained authority is incomplete or inconsistent');
  }
  const transportAuthority = projection.transportAuthority;
  return Object.freeze({
    transport: Object.freeze({
      concreteCapacitorStore: transportAuthority.storeAdapter === 'concreteCapacitorStore',
      concreteHttpGateway: transportAuthority.gatewayAdapter === 'concreteHttpGateway',
      serverUrl: transportAuthority.serverUrl,
      nativeOriginAllowed: transportAuthority.nativeOriginAllowed,
      noRedirects: transportAuthority.noRedirects,
    }),
    storeTransactionAuthority: Object.freeze({
      source: projection.transactionAuthority.source,
      crossCheckedOnRefresh: projection.transactionAuthority.crossCheckedOnRefresh,
      // This is a report/privacy claim: no raw store value enters committed evidence.
      rawValueCommitted: false,
    }),
    refreshHandleLifecycle: Object.freeze({
      positiveVersionObserved,
      rawProofCleared: projection.transactionAuthority.rawProofCleared,
      restoredFreshHandle: restoreProjection.refreshHandleLifecycle.present,
      revokedHandleDeleted: projection.refreshHandleLifecycle.deleted,
      // This is a report/privacy claim: no raw sealed handle enters committed evidence.
      rawHandleCommitted: false,
    }),
    entitlement: Object.freeze({
      id: entitlement.id,
      finalState: entitlement.state,
      digest: entitlement.domainSeparatedDigestSha256,
      refreshHandlePresent: entitlement.refreshHandlePresent,
    }),
    pack: Object.freeze({
      packId: pack.packId,
      manifestSha256: pack.manifestSha256,
      archiveSha256: pack.archiveSha256,
      installed: pack.installed,
      redownloaded: true,
    }),
    syntheticLearnerAuthoritySha256: B3_SYNTHETIC_LEARNER_AUTHORITY_SHA256,
    restore: Object.freeze({
      freshInstall: true,
      entitlementRebuilt: true,
      packRedownloaded: true,
      learnerBackupRestoreClaimed: false,
      baselineCreatedAfterFreshInstall: true,
    }),
  });
}

function createDefaultAdapter({
  root,
  env,
  platform,
  runner,
  binaryRunner,
  wait,
  resumeStoreAction = false,
  resumeReinstall = false,
  capturePlayProtectSettings = false,
}) {
  if (typeof resumeStoreAction !== 'boolean' || typeof resumeReinstall !== 'boolean' ||
      typeof capturePlayProtectSettings !== 'boolean') {
    throw captureError('B3 store-action resume authority is invalid');
  }
  const hostWait = wait ?? ((milliseconds) =>
    new Promise((resolveWait) => setTimeout(resolveWait, milliseconds)));
  const inspectors = createDefaultB3DistributionInspectors({
    root,
    env,
    ...(runner ? { commandRunner: runner } : {}),
  });
  const transport = createB3PhysicalDeviceTransport({
    root,
    platform,
    env,
    ...(runner ? { runner } : {}),
    ...(binaryRunner ? { binaryRunner } : {}),
  });
  const signedPath = env[PLATFORM[platform].signedEnvironment];
  let distributionPromise;
  let invocationTailCaptured = false;
  let invocationTail = null;
  let reinstallAcknowledgementConsumed = false;
  let storeActionResumeAuthority = null;

  async function inspectDistributionFresh() {
    if (typeof signedPath !== 'string' || signedPath.length === 0) {
      throw captureError(`B3 ${platform} signed distribution path is required`);
    }
    const expected = await readBuildExpected(root);
    const approvedPlayCertificateSha256 = platform === 'android'
      ? await readApprovedB3PlayCertificate({
          approvalFile: env.B3_PREREQUISITES_FILE,
          root,
        })
      : undefined;
    return mapDistribution(platform, await verifyB3InstalledDistributionWithInspectors({
      expected,
      platform,
      signedPath,
      artifactInspector: inspectors.artifactInspector,
      deviceInspector: inspectors.deviceInspector,
      approvedPlayCertificateSha256,
    }));
  }

  function inspectDistribution({ fresh = false } = {}) {
    if (fresh) return inspectDistributionFresh();
    distributionPromise ??= inspectDistributionFresh();
    return distributionPromise;
  }

  async function buildAuthority() {
    return buildAuthorityFor(platform, await readBuildExpected(root));
  }

  const liveCapture = createB3StoreBackedLiveCapture({
    platform,
    buildAuthority,
    transport,
    wait: hostWait,
    consumeReinstallAcknowledgement() {
      if (!resumeReinstall || reinstallAcknowledgementConsumed) {
        throw captureError('B3 reinstall acknowledgement consumption is invalid');
      }
      reinstallAcknowledgementConsumed = true;
    },
  });

  async function records() {
    await inspectDistribution();
    const retained = (await liveCapture.readCapture())?.records ?? Object.freeze([]);
    if (!invocationTailCaptured) {
      invocationTail = retained.at(-1)?.observation ?? null;
      invocationTailCaptured = true;
    }
    return retained;
  }

  async function inspectSyntheticLearners({ baseline } = {}) {
    const authority = B3_SYNTHETIC_LEARNER_DIGESTS[baseline];
    if (!authority) throw captureError('B3 synthetic learner baseline is invalid');
    let retained = await records();
    if (retained.length === 0) {
      await liveCapture.advance();
      retained = await records();
    }
    const digests = retained.at(-1).observation.proofProjection.syntheticLearners
      .positionalSnapshotSha256;
    if (digests[0] !== authority.learnerA || digests[1] !== authority.learnerB) {
      throw captureError('B3 retained synthetic learner digest authority differs');
    }
    return Object.freeze([
      Object.freeze({ learnerId: 'learner-a', nickname: 'Ada', digest: digests[0] }),
      Object.freeze({ learnerId: 'learner-b', nickname: 'Ben', digest: digests[1] }),
    ]);
  }

  async function runScenario(authority) {
    const retained = await records();
    const tail = retained.at(-1)?.observation;
    if (platform === 'ios' && authority?.scenario === 'unfinished-relaunch' &&
        tail?.scenario === 'normal-purchase' && tail.phase === 'HOLD_REACHED') {
      await hostWait(5_000);
      await liveCapture.stopForRelaunch();
    }
    const invocationBinding = invocationTail && {
      actionCode: invocationTail.nextActionCode,
      observationSha256: invocationTail.observationSha256,
    };
    storeActionResumeAuthority ??= createB3StoreActionResumeAuthority(
      resumeStoreAction, invocationBinding,
    );
    const transition = await driveB3HostScenario({
      authority,
      resumeStoreAction: storeActionResumeAuthority,
      resumeReinstall: ({ actionCode, observationSha256 }) => {
        if (!resumeReinstall || reinstallAcknowledgementConsumed ||
            actionCode !== 'REBIND_FRESH_INSTALL' ||
            invocationBinding?.actionCode !== actionCode ||
            invocationBinding?.observationSha256 !== observationSha256) return false;
        reinstallAcknowledgementConsumed = true;
        return true;
      },
      readRecords: records,
      advance: () => liveCapture.advance(),
    });
    if (authority?.scenario === 'refund-revoke') {
      await driveB3HostUntilPhase({
        scenario: authority.scenario,
        phase: 'TERMINAL_CAPTURE',
        readRecords: records,
        advance: () => liveCapture.advance(),
      });
    }
    return transition;
  }

  async function inspectProofObservationChain() {
    const retained = await records();
    const scenarios = platform === 'ios' ? B3_IOS_SCENARIOS : B3_ANDROID_SCENARIOS;
    const transitions = scenarios.map((authority) =>
      deriveB3ScenarioTransition({ records: retained, authority }));
    return deriveB3ProofObservationChain({ records: retained, transitions });
  }

  async function captureScreenshot() {
    const before = await inspectDistribution();
    if (platform === 'android') {
      await transport.foregroundApplication();
      await hostWait(500);
    }
    const bytes = platform === 'ios'
      ? await captureB3IosScreenshotBytes({
          root,
          deviceId: env.B3_IOS_PHYSICAL_DEVICE_ID,
          ...(runner ? { runner } : {}),
        })
      : await transport.captureScreenshot();
    const persisted = await persistB3PlatformScreenshot({ root, platform, bytes });
    const after = await inspectDistributionFresh();
    if (!isDeepStrictEqual(after, before)) {
      throw captureError('B3 installed distribution changed during screenshot capture');
    }
    return persisted;
  }

  async function inspectGatewaySmoke() {
    await inspectDistribution();
    const projection = (await liveCapture.readCapture())?.gatewaySmokeProjection;
    if (projection === null || projection === undefined) {
      throw captureError('B3 device gateway smoke must occur exactly once');
    }
    return projection;
  }

  async function inspectTerminalEvidence() {
    const retained = await records();
    const terminal = retained.at(-1)?.observation;
    if (terminal?.phase !== 'TERMINAL_CAPTURE') {
      throw captureError('B3 terminal observation authority is absent');
    }
    const restoreRecord = retained.filter(({ observation }) =>
      observation.scenario === 'restore-after-reinstall').at(-1)?.observation;
    const preReinstallRecord = retained.filter(({ observation }) =>
      observation.scenario === 'pack-install').at(-1)?.observation;
    const redownloadRecord = retained.filter(({ observation }) =>
      observation.scenario === 'redownload').at(-1)?.observation;
    const scenarioAuthorities = platform === 'ios' ? B3_IOS_SCENARIOS : B3_ANDROID_SCENARIOS;
    const redownloadAuthority = scenarioAuthorities.find(({ scenario }) => scenario === 'redownload');
    deriveB3ScenarioTransition({ records: retained, authority: redownloadAuthority });
    const positiveVersionObserved = retained.some(({ observation }) => {
      const projection = observation.proofProjection;
      return projection.entitlementAuthority.state === 'active' &&
        projection.entitlementAuthority.refreshHandlePresent === true &&
        projection.refreshHandleLifecycle.present === true &&
        projection.refreshHandleLifecycle.positiveVersionObserved === true &&
        typeof projection.transactionAuthority.domainSeparatedDigestSha256 === 'string';
    });
    return deriveB3TerminalEvidenceProjection({
      terminal,
      restoreRecord,
      preReinstallRecord,
      redownloadRecord,
      positiveVersionObserved,
      redownloadTransitionValidated: true,
    });
  }

  async function inspectDeviceStore() {
    await inspectDistribution();
    const device = await transport.inspectDevice();
    const retained = await records();
    if (retained.at(-1)?.observation.phase !== 'TERMINAL_CAPTURE') {
      throw captureError('B3 terminal device/store authority is absent');
    }
    let playProtect;
    if (platform === 'android') {
      if (capturePlayProtectSettings) {
        await captureB3PlayProtectSettingsScreenshot({
          root,
          bytes: await transport.captureScreenshot(),
        });
        throw operatorRequired('ATTEST_PLAY_PROTECT_SETTINGS');
      }
      try {
        playProtect = await inspectB3PlayProtectRootAttestation({ root });
      } catch (error) {
        if (error?.code !== 'b3_play_protect_attestation_absent') throw error;
        throw operatorRequired('SHOW_PLAY_PROTECT_SETTINGS');
      }
    }
    return deriveB3DeviceStoreEvidence({
      platform, retained, device, playProtect,
    });
  }

  async function inspectStoreKitTest() {
    if (platform !== 'ios') {
      throw captureError('StoreKit Test evidence is iOS-only');
    }
    return inspectB3DeterministicStoreKitReport({ root });
  }

  const base = {
    pinInvocation: () => liveCapture.pinInvocation({
      acknowledgeReinstall: resumeReinstall && !reinstallAcknowledgementConsumed,
    }),
    finaliseInvocation: liveCapture.finaliseInvocation,
    inspectDistribution,
    inspectDeviceStore,
    inspectSyntheticLearners,
    runScenario,
    inspectGatewaySmoke,
    inspectTerminalEvidence,
    inspectProofObservationChain,
    captureScreenshot,
    inspectStoreKitTest,
    dispose: liveCapture.dispose,
  };
  return {
    base,
    transport,
    wait: hostWait,
    records,
    buildAuthority,
    liveCapture,
    consumeStoreActionResume(binding) {
      const invocationBinding = invocationTail && {
        actionCode: invocationTail.nextActionCode,
        observationSha256: invocationTail.observationSha256,
      };
      storeActionResumeAuthority ??= createB3StoreActionResumeAuthority(
        resumeStoreAction, invocationBinding,
      );
      return storeActionResumeAuthority(binding);
    },
  };
}

export function createDefaultB3IosCaptureAdapter({
  root,
  env = process.env,
  runner,
  wait,
  resumeStoreAction = false,
  resumeReinstall = false,
  capturePlayProtectSettings = false,
} = {}) {
  const { base } = createDefaultAdapter({
    root, env, platform: 'ios', runner, wait, resumeStoreAction, resumeReinstall,
    capturePlayProtectSettings,
  });
  return Object.freeze(base);
}

export function createDefaultB3AndroidCaptureAdapter({
  root,
  env = process.env,
  runner,
  binaryRunner,
  wait = (milliseconds) => new Promise((resolveWait) => setTimeout(resolveWait, milliseconds)),
  resumeStoreAction = false,
  resumeReinstall = false,
  capturePlayProtectSettings = false,
} = {}) {
  const {
    base, records, liveCapture, consumeStoreActionResume,
  } = createDefaultAdapter({
    root,
    env,
    platform: 'android',
    runner,
    binaryRunner,
    wait,
    resumeStoreAction,
    resumeReinstall,
    capturePlayProtectSettings,
  });
  const slowCard = createB3AndroidSlowCardController({
    readRecords: records,
    consumeStoreActionResume,
    pollFreshProcess: ({ deadlineMs, monotonicClock } = {}) => liveCapture.advance({
      deadlineMs,
      monotonicClock,
    }),
  });
  return Object.freeze({
    ...base,
    beginSlowCardScenario: slowCard.begin,
    pollSlowCardScenario: slowCard.poll,
    finishSlowCardScenario: slowCard.finish,
    beginUnacknowledgedScenario: async (authority) => {
      return driveB3HostUntilPhase({
        scenario: authority?.scenario,
        phase: 'HOLD_REACHED',
        readRecords: records,
        advance: () => liveCapture.advance(),
      });
    },
    forceStopUnacknowledgedScenario: () => liveCapture.stopForRelaunch(),
    finishUnacknowledgedScenario: base.runScenario,
    wait,
  });
}

export { B3_SYNTHETIC_LEARNER_AUTHORITY_SHA256 };
