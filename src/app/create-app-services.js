import { loadStarterSpellingCatalogue } from '../domain/spelling/index.js';
import { createB1FakeNativePorts } from '../platform/fakes/create-b1-fake-native-ports.js';
import { assertNativePortContract } from '../platform/native-port-contract.js';
import { readCapacitorBuildAuthority } from '../platform/distribution/capacitor-build-authority.js';
import { createCapacitorB3ProofObservation } from '../platform/proof/capacitor-b3-proof-observation.js';
import gatewayAuthority from '../../config/b3-gateway-authority.json' with { type: 'json' };
import { createB2AppServices } from './create-b2-app-services.js';
import { createB3AppServices } from './create-b3-app-services.js';

export { createB2AppServices, createB3AppServices };

export function selectNativeAppComposition({ buildMode, platform }) {
  if (platform !== 'ios' && platform !== 'android') {
    throw new TypeError('Native application platform is invalid.');
  }
  if (buildMode !== 'B3SandboxProof') {
    return Object.freeze({ serviceMode: 'b2', runtime: null });
  }
  const buildAuthority = Object.freeze({
    mode: 'B3SandboxProof',
    proofKind: 'physical-live',
    platform,
    distribution: platform === 'ios' ? 'development' : 'play-internal',
    publicSandboxOrigin: gatewayAuthority.publicSandboxOrigin,
    workerName: gatewayAuthority.workerName,
  });
  return Object.freeze({
    serviceMode: 'b3',
    runtime: Object.freeze({
      isNativePlatform: true,
      platform,
      buildAuthority,
    }),
  });
}

export async function createSelectedAppServices({
  buildMode,
  isNativePlatform,
  platform,
  b3Options = {},
}) {
  if (isNativePlatform === true) {
    const composition = selectNativeAppComposition({ buildMode, platform });
    if (composition.serviceMode !== 'b3') return createB2AppServices();
    if (Object.hasOwn(b3Options, 'proofObservationPort')) {
      throw new TypeError('B3 physical proof observation transport is application-owned.');
    }
    const embeddedBuildAuthority = await readCapacitorBuildAuthority(platform);
    return createB3AppServices({
      ...b3Options,
      runtime: Object.freeze({
        ...composition.runtime,
        buildAuthority: embeddedBuildAuthority,
      }),
      proofObservationPort: createCapacitorB3ProofObservation({
        buildAuthority: embeddedBuildAuthority,
      }),
    });
  }
  if (buildMode !== 'B3DeterministicTest') return null;
  return createB3AppServices({
    ...b3Options,
    runtime: Object.freeze({ isNativePlatform: false, platform: 'web' }),
  });
}

export function createAppServices({ nativePorts = createB1FakeNativePorts() } = {}) {
  const starterCatalogue = loadStarterSpellingCatalogue();
  const native = assertNativePortContract(nativePorts);

  if (starterCatalogue.items.length !== 20) {
    throw new Error('The certified B1 Starter catalogue must contain exactly 20 words.');
  }

  return Object.freeze({
    native,
    starterContentCount: starterCatalogue.items.length,
  });
}
