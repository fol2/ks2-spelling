import { validateB3DistributionProjection } from './b3-evidence.mjs';

const PLATFORMS = new Set(['ios', 'android']);

function recoveryError(message) {
  return Object.assign(new Error(message), { code: 'b3_capture_recovery_invalid' });
}

function assertPlatform(platform) {
  if (!PLATFORMS.has(platform)) {
    throw recoveryError('B3 capture recovery platform is invalid');
  }
  return platform;
}

function assertDistribution({ platform, distribution, buildAuthority }) {
  try {
    validateB3DistributionProjection({
      value: distribution,
      platform,
      buildAuthority,
    });
  } catch {
    throw recoveryError('B3 capture recovery distribution authority differs');
  }
}

export function createB3CaptureRecoveryStore({
  platform: rawPlatform,
  buildAuthority,
  transitionalBridge,
} = {}) {
  const platform = assertPlatform(rawPlatform);
  if (typeof buildAuthority !== 'function' ||
      typeof transitionalBridge?.pinInvocation !== 'function' ||
      typeof transitionalBridge?.finaliseInvocation !== 'function') {
    throw recoveryError('B3 capture recovery store authority is invalid');
  }
  const pins = new WeakMap();

  async function pinInvocation({ acknowledgeReinstall } = {}) {
    if (acknowledgeReinstall !== undefined && typeof acknowledgeReinstall !== 'boolean') {
      throw recoveryError('B3 capture recovery acknowledgement is invalid');
    }
    const legacyAuthority = await transitionalBridge.pinInvocation();
    const invocation = Object.freeze(Object.create(null));
    pins.set(invocation, Object.freeze({
      legacyAuthority,
      acknowledgeReinstall: acknowledgeReinstall === true,
    }));
    return invocation;
  }

  async function finaliseInvocation({ invocation, distribution } = {}) {
    const pin = pins.get(invocation);
    if (!pin) throw recoveryError('B3 capture recovery invocation pin is invalid');
    const authority = await buildAuthority();
    assertDistribution({ platform, distribution, buildAuthority: authority });
    const recovered = await transitionalBridge.finaliseInvocation(pin);
    return Object.freeze({ status: recovered ? 'recovered' : 'not-applicable' });
  }

  function authorisePlannedRebind() {
    return false;
  }

  return Object.freeze({
    pinInvocation,
    finaliseInvocation,
    authorisePlannedRebind,
  });
}
