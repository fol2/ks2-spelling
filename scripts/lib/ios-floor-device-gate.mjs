export const IPHONEOS_DEPLOYMENT_TARGET = '26.0';
export const EXPECTED_IPHONEOS_DEPLOYMENT_TARGET_COUNT = 13;
export const COMMITTED_PHYSICAL_PROOF_RELATIVE =
  'reports/b4-physical/ios-physical-proof.json';

export const ASC_AUTH_ENV = Object.freeze({
  keyId: 'KS2_ASC_KEY_ID',
  issuerId: 'KS2_ASC_ISSUER_ID',
  keyPath: 'KS2_ASC_KEY_PATH',
});

export const ASC_AUTH_ENV_NAMES = Object.freeze([
  ASC_AUTH_ENV.keyId,
  ASC_AUTH_ENV.issuerId,
  ASC_AUTH_ENV.keyPath,
]);

export const ASC_XCODEBUILD_FLAGS = Object.freeze({
  keyId: '-authenticationKeyID',
  issuerId: '-authenticationKeyIssuerID',
  keyPath: '-authenticationKeyPath',
});

export const FLOOR_DEVICES = Object.freeze([
  Object.freeze({
    id: 'iphone-se-2',
    modelName: 'iPhone SE (2nd generation)',
    silicon: 'A13',
    widthPt: 375,
    heightPt: 667,
    notch: false,
    family: 'iphone',
  }),
  Object.freeze({
    id: 'ipad-8',
    modelName: 'iPad (8th generation)',
    silicon: 'A12',
    widthPt: 810,
    heightPt: 1080,
    laminated: false,
    colourSpace: 'sRGB',
    family: 'ipad',
  }),
]);

export const OWNER_IPHONE_ARTEFACT_MODEL = 'iPhone 16 Pro Max';
export const PHYSICAL_FLOOR_REPORT_SCHEMA_VERSION = 2;
export const HISTORICAL_OWNER_IPHONE_REPORT_SCHEMA_VERSION = 1;
export const CAPACITOR_SWIFT_TOOLS_VERSION = '6.2';
export const SWIFTPM_IOS_VERSION = '26';
export const FLOOR_DEVICE_REPORT_RELATIVES = Object.freeze(
  Object.fromEntries(
    FLOOR_DEVICES.map((device) => [
      device.id,
      `reports/b4-physical/ios-floor-${device.id}.json`,
    ]),
  ),
);

export const FRAME_RATE_RISK_SURFACES = Object.freeze([
  'codexZoomMonsterStage',
  'celebrationTier',
  'ambientBackdropPan',
]);

export const PHYSICAL_FLOOR_COMPARATOR_KINDS = Object.freeze([
  'answerFeedback',
  'audioStart',
  'coldLaunch',
  'frameRate',
  'memory',
  'sqliteTransactionUpperBound',
  'timeToInteractive',
]);

export const PHYSICAL_FLOOR_COMPARATOR_SPECS = Object.freeze({
  coldLaunch: Object.freeze({
    unit: 'ms',
    threshold: 2_000,
    thresholdStatus: 'authoritative',
    authority: 'frozen source design section 18 / scripts/investigate-b4-release-launch-ios.mjs',
  }),
  answerFeedback: Object.freeze({
    unit: 'ms',
    threshold: 100,
    thresholdStatus: 'authoritative',
    authority: 'frozen source design section 18',
  }),
  sqliteTransactionUpperBound: Object.freeze({
    unit: 'ms',
    threshold: 50,
    thresholdStatus: 'authoritative',
    authority: 'frozen source design section 18',
  }),
  audioStart: Object.freeze({
    unit: 'ms',
    threshold: 250,
    thresholdStatus: 'authoritative',
    authority: 'frozen source design section 18',
  }),
  timeToInteractive: Object.freeze({
    unit: 'ms',
    threshold: null,
    thresholdStatus: 'pending-owner-adjudication',
    authority:
      'GitHub issue #152 performance budget; #141/#152 name time-to-interactive but do not publish a numeric threshold',
  }),
  frameRate: Object.freeze({
    unit: 'fps',
    threshold: null,
    thresholdStatus: 'pending-owner-adjudication',
    questionCardDroppedFramesMustBeZero: true,
    riskSurfaces: FRAME_RATE_RISK_SURFACES,
    authority:
      'GitHub issue #152: nothing may drop frames during a question card; named risk surfaces are the Phaser Monster Stage behind the Codex zoom, the celebration tier, and the ambient backdrop pan. #141/#152 publish no fps number',
  }),
  memory: Object.freeze({
    unit: 'bytes',
    threshold: null,
    thresholdStatus: 'pending-owner-adjudication',
    authority:
      'GitHub issue #152 performance budget; nativePayload/localDatabase remain the section-18 size budgets and are not this runtime-memory comparator. #141/#152 publish no byte threshold',
  }),
});

function gateError(code, message) {
  return Object.assign(new Error(message), { code });
}

export function collectIphoneosDeploymentTargets(pbxprojText) {
  if (typeof pbxprojText !== 'string') {
    throw gateError(
      'ios_deployment_target_source_invalid',
      'PBX project text is required.',
    );
  }
  return [...pbxprojText.matchAll(/IPHONEOS_DEPLOYMENT_TARGET = ([^;]+);/gu)].map(
    (match) => match[1],
  );
}

export function assertIphoneosDeploymentTargetFloor(
  pbxprojText,
  expected = IPHONEOS_DEPLOYMENT_TARGET,
) {
  const values = collectIphoneosDeploymentTargets(pbxprojText);
  if (values.length !== EXPECTED_IPHONEOS_DEPLOYMENT_TARGET_COUNT) {
    throw gateError(
      'ios_deployment_target_count_invalid',
      `Expected ${EXPECTED_IPHONEOS_DEPLOYMENT_TARGET_COUNT} IPHONEOS_DEPLOYMENT_TARGET entries, found ${values.length}.`,
    );
  }
  const unexpected = [...new Set(values.filter((value) => value !== expected))];
  if (unexpected.length > 0) {
    throw gateError(
      'ios_deployment_target_value_invalid',
      `Every IPHONEOS_DEPLOYMENT_TARGET must be ${expected}; found ${unexpected.join(', ')}.`,
    );
  }
  return Object.freeze({ count: values.length, value: expected });
}

export function floorDeviceModelNames() {
  return Object.freeze(FLOOR_DEVICES.map((device) => device.modelName));
}

export function matchFloorDevice(modelName) {
  if (typeof modelName !== 'string' || modelName.length === 0) return null;
  return FLOOR_DEVICES.find((device) => device.modelName === modelName) ?? null;
}

export function classifyPhysicalDeviceReport(report) {
  const modelName = report?.runner?.deviceModel;
  const reality = report?.runner?.reality;
  if (reality !== 'physical') {
    return Object.freeze({
      kind: 'not-physical',
      floorDevice: null,
      ownerIphoneArtefact: false,
    });
  }
  const floorDevice = matchFloorDevice(modelName);
  if (floorDevice) {
    return Object.freeze({
      kind: 'floor-device',
      floorDevice,
      ownerIphoneArtefact: false,
    });
  }
  return Object.freeze({
    kind: 'non-floor-physical',
    floorDevice: null,
    ownerIphoneArtefact: modelName === OWNER_IPHONE_ARTEFACT_MODEL,
  });
}

export function capacitorSwiftToolsVersion(config) {
  const version = config?.experimental?.ios?.spm?.swiftToolsVersion;
  return typeof version === 'string' ? version : '';
}

export function assertSwiftPmFloorContract({
  capacitorConfig,
  packageSwift,
  pbxprojText,
}) {
  assertIphoneosDeploymentTargetFloor(pbxprojText);
  if (Object.hasOwn(capacitorConfig ?? {}, 'server')) {
    throw gateError(
      'ios_capacitor_server_forbidden',
      'Root capacitor.config.json must not declare server.url or any server key.',
    );
  }
  if (capacitorSwiftToolsVersion(capacitorConfig) !== CAPACITOR_SWIFT_TOOLS_VERSION) {
    throw gateError(
      'ios_swift_tools_version_invalid',
      `Root capacitor.config.json experimental.ios.spm.swiftToolsVersion must be ${CAPACITOR_SWIFT_TOOLS_VERSION}.`,
    );
  }
  const toolsLine = `// swift-tools-version: ${CAPACITOR_SWIFT_TOOLS_VERSION}`;
  if (!packageSwift?.includes(toolsLine)) {
    throw gateError(
      'ios_swiftpm_tools_version_drift',
      `CapApp-SPM/Package.swift must be generated with ${toolsLine}.`,
    );
  }
  const platform = `platforms: [.iOS(.v${SWIFTPM_IOS_VERSION})]`;
  if (!packageSwift.includes(platform)) {
    throw gateError(
      'ios_swiftpm_platform_drift',
      `CapApp-SPM/Package.swift must be generated with ${platform}.`,
    );
  }
  return Object.freeze({
    swiftToolsVersion: CAPACITOR_SWIFT_TOOLS_VERSION,
    iosVersion: SWIFTPM_IOS_VERSION,
  });
}

export function physicalFloorReportRelative(deviceModel) {
  const device = matchFloorDevice(deviceModel);
  return device ? FLOOR_DEVICE_REPORT_RELATIVES[device.id] : null;
}

export function hasFloorDeviceCheckpointIdentity(report) {
  const checkpoint = report?.applicationCheckpoint;
  return Boolean(
    checkpoint
    && /^[a-f0-9]{40}$/u.test(checkpoint.commit ?? '')
    && /^[a-f0-9]{40}$/u.test(checkpoint.tree ?? ''),
  );
}

export function isValidFloorDeviceReport(report) {
  const classification = classifyPhysicalDeviceReport(report);
  return classification.kind === 'floor-device'
    && report?.schemaVersion === PHYSICAL_FLOOR_REPORT_SCHEMA_VERSION
    && report?.platform === 'ios-physical'
    && report?.runner?.buildConfiguration === 'Release'
    && report?.runner?.reality === 'physical'
    && hasFloorDeviceCheckpointIdentity(report)
    && hasRecordedFloorComparators(report.comparators);
}

export function evaluateFloorDeviceMatrix(reports) {
  const list = Array.isArray(reports) ? reports : [];
  const matched = new Map();
  const invalid = [];
  for (const report of list) {
    const classification = classifyPhysicalDeviceReport(report);
    if (classification.kind !== 'floor-device') continue;
    if (!isValidFloorDeviceReport(report)) {
      invalid.push(classification.floorDevice.modelName);
      continue;
    }
    matched.set(classification.floorDevice.id, report);
  }
  const missing = FLOOR_DEVICES
    .filter((device) => !matched.has(device.id))
    .map((device) => device.modelName);
  const validReports = [...matched.values()];
  const checkpointKeys = validReports.map((report) => (
    `${report.applicationCheckpoint.commit}:${report.applicationCheckpoint.tree}`
  ));
  const checkpointMismatch = validReports.length >= 2
    && new Set(checkpointKeys).size !== 1;
  const complete = missing.length === 0
    && invalid.length === 0
    && !checkpointMismatch
    && validReports.length === FLOOR_DEVICES.length;
  const green = complete
    && validReports.every((report) => scoredFloorComparatorsAreWithin(
      scorePhysicalFloorComparatorsFromEvidence(report.comparators),
    ));
  return Object.freeze({
    complete,
    green,
    checkpointMismatch,
    matchedIds: Object.freeze([...matched.keys()]),
    missing: Object.freeze(missing),
    invalid: Object.freeze(invalid),
  });
}

export function countProductCssFeatureUses(cssText) {
  if (typeof cssText !== 'string') {
    throw gateError('ios_css_feature_source_invalid', 'CSS text is required.');
  }
  return Object.freeze({
    colorMix: [...cssText.matchAll(/color-mix\(/gu)].length,
    textWrapBalance: [...cssText.matchAll(/text-wrap:\s*balance/gu)].length,
    supportsBlocks: [...cssText.matchAll(/@supports/gu)].length,
  });
}

export function resolveAscAuthenticationArguments(env = {}) {
  const values = ASC_AUTH_ENV_NAMES.map((name) => {
    const raw = env[name];
    return typeof raw === 'string' ? raw.trim() : '';
  });
  const presentCount = values.filter(Boolean).length;
  if (presentCount === 0) {
    return Object.freeze({
      forwarded: false,
      arguments: Object.freeze([]),
    });
  }
  if (presentCount !== 3) {
    const missing = ASC_AUTH_ENV_NAMES.filter((name, index) => values[index] === '');
    throw gateError(
      'b4_ios_physical_asc_auth_incomplete',
      `Set all of ${ASC_AUTH_ENV_NAMES.join(', ')}, or none of them. Missing: ${missing.join(', ')}. The verification script does not read the keychain, certificates, provisioning profiles, or hidden prompts.`,
    );
  }
  const [keyId, issuerId, keyPath] = values;
  return Object.freeze({
    forwarded: true,
    arguments: Object.freeze([
      ASC_XCODEBUILD_FLAGS.keyId,
      keyId,
      ASC_XCODEBUILD_FLAGS.issuerId,
      issuerId,
      ASC_XCODEBUILD_FLAGS.keyPath,
      keyPath,
    ]),
  });
}

export function insertAllowProvisioningAuthenticationArguments(
  args,
  authenticationArguments = [],
) {
  if (!Array.isArray(args)) {
    throw gateError(
      'b4_ios_physical_xcode_args_invalid',
      'xcodebuild arguments must be an array.',
    );
  }
  const list = [...args];
  const index = list.indexOf('-allowProvisioningUpdates');
  if (index === -1) {
    throw gateError(
      'b4_ios_physical_allow_provisioning_missing',
      'xcodebuild arguments must include -allowProvisioningUpdates next to owner-forwarded App Store Connect authentication flags.',
    );
  }
  list.splice(index + 1, 0, ...authenticationArguments);
  return Object.freeze(list);
}

export function withOwnerForwardedAscAuthentication(args, env = {}) {
  const { arguments: authenticationArguments } = resolveAscAuthenticationArguments(env);
  return insertAllowProvisioningAuthenticationArguments(args, authenticationArguments);
}

function finiteNonNegative(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isCanonicalObservation(value) {
  return value === null || finiteNonNegative(value);
}

const MS_COMPARATOR_CAPTURE_KEYS = Object.freeze({
  coldLaunch: 'coldLaunchMs',
  answerFeedback: 'answerFeedbackMs',
  sqliteTransactionUpperBound: 'sqliteTransactionUpperBoundMs',
  audioStart: 'audioStartMs',
  timeToInteractive: 'timeToInteractiveMs',
});

function matchesCanonicalScalarComparator(comparator, spec, observedKey) {
  return Boolean(
    comparator
    && typeof comparator === 'object'
    && comparator.unit === spec.unit
    && comparator.threshold === spec.threshold
    && comparator.thresholdStatus === spec.thresholdStatus
    && isCanonicalObservation(comparator[observedKey]),
  );
}

function matchesCanonicalFrameRateComparator(comparator) {
  const spec = PHYSICAL_FLOOR_COMPARATOR_SPECS.frameRate;
  const surfaces = comparator?.riskSurfaces;
  if (!comparator || typeof comparator !== 'object'
      || comparator.unit !== spec.unit
      || comparator.threshold !== spec.threshold
      || comparator.thresholdStatus !== spec.thresholdStatus
      || comparator.observedFps !== null
      || !isCanonicalObservation(comparator.questionCardDroppedFrames)
      || !surfaces || typeof surfaces !== 'object') {
    return false;
  }
  const names = Object.keys(surfaces).sort();
  if (names.join('|') !== [...FRAME_RATE_RISK_SURFACES].sort().join('|')) {
    return false;
  }
  return FRAME_RATE_RISK_SURFACES.every(
    (name) => isCanonicalObservation(surfaces[name]?.observedFps),
  );
}

export function unmeasuredFrameRateCapture() {
  return Object.freeze({
    questionCardDroppedFrames: null,
    riskSurfaces: Object.freeze(
      Object.fromEntries(
        FRAME_RATE_RISK_SURFACES.map((name) => [
          name,
          Object.freeze({ observedFps: null }),
        ]),
      ),
    ),
  });
}

export function unmeasuredMemoryCapture() {
  return Object.freeze({ peakBytes: null });
}

export function validateFrameRateCapture(capture) {
  const surfaces = capture?.riskSurfaces;
  if (!capture || typeof capture !== 'object'
      || (capture.questionCardDroppedFrames !== null
        && !finiteNonNegative(capture.questionCardDroppedFrames))
      || !surfaces || typeof surfaces !== 'object') {
    throw gateError(
      'b4_ios_physical_frame_rate_unmeasured',
      'Floor-device frame-rate capture must supply questionCardDroppedFrames and the three named risk surfaces, using null when the current UITest cannot instrument the metric.',
    );
  }
  const names = Object.keys(surfaces).sort();
  if (names.join('|') !== [...FRAME_RATE_RISK_SURFACES].sort().join('|')) {
    throw gateError(
      'b4_ios_physical_frame_rate_risk_surfaces_invalid',
      `Frame-rate risk surfaces must be exactly ${FRAME_RATE_RISK_SURFACES.join(', ')}.`,
    );
  }
  for (const name of FRAME_RATE_RISK_SURFACES) {
    const observedFps = surfaces[name]?.observedFps;
    if (observedFps !== null && !finiteNonNegative(observedFps)) {
      throw gateError(
        'b4_ios_physical_frame_rate_unmeasured',
        `Frame-rate risk surface ${name} must be a finite fps value or null.`,
      );
    }
  }
  return capture;
}

export function validateMemoryCapture(capture) {
  if (!capture || typeof capture !== 'object'
      || (capture.peakBytes !== null && !finiteNonNegative(capture.peakBytes))) {
    throw gateError(
      'b4_ios_physical_memory_unmeasured',
      'Floor-device memory capture must supply peakBytes, using null when the current UITest cannot instrument the metric.',
    );
  }
  return capture;
}

function scoreThresholdedObservation({ observed, spec }) {
  const recorded = finiteNonNegative(observed);
  const within = spec.thresholdStatus === 'authoritative'
    && recorded
    && observed <= spec.threshold;
  const result = {
    unit: spec.unit,
    threshold: spec.threshold,
    thresholdStatus: spec.thresholdStatus,
    recorded,
    within,
  };
  if (spec.unit === 'ms') result.observedMs = recorded ? observed : null;
  if (spec.unit === 'bytes') result.observedBytes = recorded ? observed : null;
  if (spec.unit === 'fps') result.observedFps = recorded ? observed : null;
  return result;
}

export function evaluatePhysicalFloorComparators({
  coldLaunchMs,
  answerFeedbackMs,
  sqliteTransactionUpperBoundMs,
  audioStartMs,
  timeToInteractiveMs,
  frameRate,
  memory,
}) {
  const frameCapture = validateFrameRateCapture(frameRate);
  const memoryCapture = validateMemoryCapture(memory);
  const questionCardDroppedFrames = frameCapture.questionCardDroppedFrames;
  const questionCardDroppedFramesRecorded = finiteNonNegative(questionCardDroppedFrames);
  const questionCardDroppedFramesWithin =
    PHYSICAL_FLOOR_COMPARATOR_SPECS.frameRate.questionCardDroppedFramesMustBeZero
    && questionCardDroppedFramesRecorded
    && questionCardDroppedFrames === 0;
  const riskSurfaces = Object.freeze(Object.fromEntries(
    FRAME_RATE_RISK_SURFACES.map((name) => {
      const observedFps = frameCapture.riskSurfaces[name].observedFps;
      const recorded = finiteNonNegative(observedFps);
      return [name, Object.freeze({
        observedFps: recorded ? observedFps : null,
        recorded,
      })];
    }),
  ));
  const frameRateRecorded = questionCardDroppedFramesRecorded
    && FRAME_RATE_RISK_SURFACES.every(
      (name) => riskSurfaces[name].recorded === true,
    );
  const comparators = Object.freeze({
    coldLaunch: Object.freeze(scoreThresholdedObservation({
      observed: coldLaunchMs,
      spec: PHYSICAL_FLOOR_COMPARATOR_SPECS.coldLaunch,
    })),
    answerFeedback: Object.freeze(scoreThresholdedObservation({
      observed: answerFeedbackMs,
      spec: PHYSICAL_FLOOR_COMPARATOR_SPECS.answerFeedback,
    })),
    sqliteTransactionUpperBound: Object.freeze(scoreThresholdedObservation({
      observed: sqliteTransactionUpperBoundMs,
      spec: PHYSICAL_FLOOR_COMPARATOR_SPECS.sqliteTransactionUpperBound,
    })),
    audioStart: Object.freeze(scoreThresholdedObservation({
      observed: audioStartMs,
      spec: PHYSICAL_FLOOR_COMPARATOR_SPECS.audioStart,
    })),
    timeToInteractive: Object.freeze(scoreThresholdedObservation({
      observed: timeToInteractiveMs,
      spec: PHYSICAL_FLOOR_COMPARATOR_SPECS.timeToInteractive,
    })),
    frameRate: Object.freeze({
      unit: PHYSICAL_FLOOR_COMPARATOR_SPECS.frameRate.unit,
      threshold: PHYSICAL_FLOOR_COMPARATOR_SPECS.frameRate.threshold,
      thresholdStatus: PHYSICAL_FLOOR_COMPARATOR_SPECS.frameRate.thresholdStatus,
      observedFps: null,
      recorded: frameRateRecorded,
      questionCardDroppedFrames: questionCardDroppedFramesRecorded
        ? questionCardDroppedFrames
        : null,
      questionCardDroppedFramesRecorded,
      questionCardDroppedFramesWithin,
      riskSurfaces,
      within: false,
    }),
    memory: Object.freeze(scoreThresholdedObservation({
      observed: memoryCapture.peakBytes,
      spec: PHYSICAL_FLOOR_COMPARATOR_SPECS.memory,
    })),
  });
  const kinds = Object.keys(comparators).sort();
  if (kinds.join('|') !== [...PHYSICAL_FLOOR_COMPARATOR_KINDS].sort().join('|')) {
    throw gateError(
      'b4_ios_physical_comparator_set_invalid',
      'The physical floor comparator set drifted from the seven-kind contract.',
    );
  }
  return comparators;
}

export function extractPhysicalFloorComparatorEvidence(comparators) {
  if (!comparators || typeof comparators !== 'object') return null;
  const evidence = {};
  for (const [kind, captureKey] of Object.entries(MS_COMPARATOR_CAPTURE_KEYS)) {
    const comparator = comparators[kind];
    if (!matchesCanonicalScalarComparator(
      comparator,
      PHYSICAL_FLOOR_COMPARATOR_SPECS[kind],
      'observedMs',
    )) {
      return null;
    }
    evidence[captureKey] = comparator.observedMs;
  }
  if (!matchesCanonicalScalarComparator(
    comparators.memory,
    PHYSICAL_FLOOR_COMPARATOR_SPECS.memory,
    'observedBytes',
  )) {
    return null;
  }
  if (!matchesCanonicalFrameRateComparator(comparators.frameRate)) return null;
  evidence.memory = Object.freeze({
    peakBytes: comparators.memory.observedBytes,
  });
  evidence.frameRate = Object.freeze({
    questionCardDroppedFrames: comparators.frameRate.questionCardDroppedFrames,
    riskSurfaces: Object.freeze(Object.fromEntries(
      FRAME_RATE_RISK_SURFACES.map((name) => [
        name,
        Object.freeze({
          observedFps: comparators.frameRate.riskSurfaces[name].observedFps,
        }),
      ]),
    )),
  });
  return Object.freeze(evidence);
}

export function scorePhysicalFloorComparatorsFromEvidence(comparators) {
  const evidence = extractPhysicalFloorComparatorEvidence(comparators);
  if (!evidence) return null;
  return evaluatePhysicalFloorComparators(evidence);
}

export function scoredFloorComparatorsAreRecorded(scored) {
  if (!scored) return false;
  for (const kind of PHYSICAL_FLOOR_COMPARATOR_KINDS) {
    if (scored[kind]?.recorded !== true) return false;
  }
  if (scored.frameRate.questionCardDroppedFramesRecorded !== true) return false;
  return FRAME_RATE_RISK_SURFACES.every(
    (name) => scored.frameRate.riskSurfaces?.[name]?.recorded === true,
  );
}

export function scoredFloorComparatorsAreWithin(scored) {
  return Boolean(
    scored
    && PHYSICAL_FLOOR_COMPARATOR_KINDS.every((kind) => scored[kind]?.within === true)
    && scored.frameRate.questionCardDroppedFramesWithin === true,
  );
}

// Completeness and GREEN recompute from observations, units and specs.
// Caller-supplied recorded/within booleans are ignored.
export function hasRecordedFloorComparators(comparators) {
  return scoredFloorComparatorsAreRecorded(
    scorePhysicalFloorComparatorsFromEvidence(comparators),
  );
}

export function isHistoricalOwnerIphonePhysicalProof(report) {
  return report?.schemaVersion === HISTORICAL_OWNER_IPHONE_REPORT_SCHEMA_VERSION
    && report?.runner?.deviceModel === OWNER_IPHONE_ARTEFACT_MODEL
    && report?.comparators?.timeToInteractive === undefined
    && report?.comparators?.frameRate === undefined
    && report?.comparators?.memory === undefined;
}
