import gatewayAuthorityJson from '../../config/b3-gateway-authority.json' with { type: 'json' };
import packKeyringJson from '../../config/pack-signing-public-keys.json' with { type: 'json' };
import {
  assertB3GatewayAuthority,
  assertPackKeyring,
} from '../domain/commerce/commerce-contracts.js';
import { createProductAppServices } from './create-product-app-services.js';

const GATEWAY_ORIGIN = ['https:', '', 'b3-gateway.eugnel.uk'].join('/');
const GATEWAY_AUTHORITY = assertB3GatewayAuthority(gatewayAuthorityJson);
const PACK_KEYRING = assertPackKeyring(packKeyringJson);

function requireProductPlatform(platform) {
  if (platform !== 'ios' && platform !== 'android') {
    throw new TypeError('Native application platform is invalid.');
  }
  return platform;
}

export function selectNativeAppComposition({ buildMode, platform }) {
  if (buildMode !== 'sandbox') {
    throw new TypeError('Sandbox composition requires the sandbox release channel.');
  }
  return Object.freeze({
    serviceMode: 'product',
    productIdentifier: 'ks2-spelling-product',
    releaseChannel: 'sandbox',
    runtime: Object.freeze({
      isNativePlatform: true,
      platform: requireProductPlatform(platform),
    }),
  });
}

export async function createSelectedAppServices({
  buildMode,
  isNativePlatform,
  platform,
  productOptions = {},
}) {
  if (buildMode !== 'sandbox') {
    throw new TypeError('Sandbox composition requires the sandbox release channel.');
  }
  if (isNativePlatform !== true) return null;
  for (const owned of [
    'runtime',
    'packTrustEnvironment',
    'gatewayAuthority',
    'gatewayOrigin',
    'packKeyring',
  ]) {
    if (Object.hasOwn(productOptions, owned)) {
      throw new TypeError('Product release authority is application-owned.');
    }
  }
  const composition = selectNativeAppComposition({ buildMode, platform });
  return createProductAppServices({
    ...productOptions,
    runtime: composition.runtime,
    packTrustEnvironment: 'sandbox',
    gatewayAuthority: GATEWAY_AUTHORITY,
    gatewayOrigin: GATEWAY_ORIGIN,
    packKeyring: PACK_KEYRING,
  });
}

export async function createB2AppServices() {
  throw new Error('b2_proof_services_excluded_from_product_bundle');
}
