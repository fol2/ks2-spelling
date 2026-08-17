import { isDeepStrictEqual } from 'node:util';

export const GOOGLE_PLAY_SERVICE_ACCOUNT_SECRET_NAME = 'GOOGLE_PLAY_SERVICE_ACCOUNT_JSON';

// Sandbox B3 evidence stays on the historical seven-name pin. Production is a
// different authority: the iOS Worker does not declare Google Play.
export const B3_SANDBOX_REQUIRED_SECRET_NAMES = Object.freeze([
  'APPLE_IAP_ISSUER_ID',
  'APPLE_IAP_KEY_ID',
  'APPLE_IAP_PRIVATE_KEY',
  GOOGLE_PLAY_SERVICE_ACCOUNT_SECRET_NAME,
  'ENTITLEMENT_HANDLE_KEY_CURRENT',
  'ENTITLEMENT_HANDLE_KEY_PREVIOUS',
  'R2_CAPABILITY_HMAC_KEY',
]);

export const PRODUCTION_IOS_REQUIRED_SECRET_NAMES = Object.freeze([
  'APPLE_IAP_ISSUER_ID',
  'APPLE_IAP_KEY_ID',
  'APPLE_IAP_PRIVATE_KEY',
  'ENTITLEMENT_HANDLE_KEY_CURRENT',
  'ENTITLEMENT_HANDLE_KEY_PREVIOUS',
  'R2_CAPABILITY_HMAC_KEY',
]);

export function isExactRequiredSecretNameSet(actualNames, requiredNames) {
  return (
    Array.isArray(actualNames) &&
    actualNames.length === requiredNames.length &&
    actualNames.every((entry) => typeof entry === 'string') &&
    new Set(actualNames).size === actualNames.length &&
    isDeepStrictEqual([...actualNames].sort(), [...requiredNames].sort())
  );
}

export function matchesProductionIosRequiredSecretNames(actualNames) {
  return isExactRequiredSecretNameSet(actualNames, PRODUCTION_IOS_REQUIRED_SECRET_NAMES);
}

export function assertProductionIosRequiredSecretNames(actualNames) {
  if (!matchesProductionIosRequiredSecretNames(actualNames)) {
    const error = new Error(
      'production iOS Worker required-secret set must be exactly the six iOS names',
    );
    error.code = 'production_ios_required_secret_set_invalid';
    throw error;
  }
  return Object.freeze([...PRODUCTION_IOS_REQUIRED_SECRET_NAMES]);
}
