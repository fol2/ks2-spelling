import { createProductAppServices } from './create-product-app-services.js';

function requireProductPlatform(platform) {
  if (platform !== 'ios' && platform !== 'android') {
    throw new TypeError('Native application platform is invalid.');
  }
  return platform;
}

export function selectNativeAppComposition({ buildMode, platform }) {
  if (buildMode !== 'production') {
    throw new TypeError('Production composition requires production build mode.');
  }
  const approvedPlatform = requireProductPlatform(platform);
  return Object.freeze({
    serviceMode: 'product',
    productIdentifier: 'ks2-spelling-product',
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
  if (buildMode !== 'production') {
    throw new TypeError('Production services require production build mode.');
  }
  if (isNativePlatform !== true) return null;
  if (Object.hasOwn(productOptions, 'runtime')) {
    throw new TypeError('Product runtime authority is application-owned.');
  }
  const composition = selectNativeAppComposition({ buildMode, platform });
  return createProductAppServices({
    ...productOptions,
    runtime: composition.runtime,
  });
}

export async function createB2AppServices() {
  throw new Error('b2_proof_services_excluded_from_product_bundle');
}
