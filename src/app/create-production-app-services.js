import { createProductAppServices } from './create-product-app-services.js';

function requireProductReleaseChannel(buildMode) {
  if (buildMode !== 'sandbox' && buildMode !== 'production') {
    throw new TypeError('Product composition requires a declared release channel.');
  }
  return buildMode;
}

function requireProductPlatform(platform) {
  if (platform !== 'ios' && platform !== 'android') {
    throw new TypeError('Native application platform is invalid.');
  }
  return platform;
}

export function selectNativeAppComposition({ buildMode, platform }) {
  const releaseChannel = requireProductReleaseChannel(buildMode);
  const approvedPlatform = requireProductPlatform(platform);
  return Object.freeze({
    serviceMode: 'product',
    productIdentifier: 'ks2-spelling-product',
    releaseChannel,
    runtime: Object.freeze({
      isNativePlatform: true,
      platform: approvedPlatform,
    }),
  });
}

export async function createSelectedAppServices({
  buildMode,
  isNativePlatform,
  platform,
  productOptions = {},
}) {
  const releaseChannel = requireProductReleaseChannel(buildMode);
  if (isNativePlatform !== true) return null;
  if (Object.hasOwn(productOptions, 'runtime') ||
      Object.hasOwn(productOptions, 'packTrustEnvironment')) {
    throw new TypeError('Product release authority is application-owned.');
  }
  const composition = selectNativeAppComposition({ buildMode, platform });
  return createProductAppServices({
    ...productOptions,
    runtime: composition.runtime,
    packTrustEnvironment: releaseChannel,
  });
}

export async function createB2AppServices() {
  throw new Error('b2_proof_services_excluded_from_product_bundle');
}
