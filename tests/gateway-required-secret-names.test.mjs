import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  B3_SANDBOX_REQUIRED_SECRET_NAMES,
  GOOGLE_PLAY_SERVICE_ACCOUNT_SECRET_NAME,
  PRODUCTION_IOS_REQUIRED_SECRET_NAMES,
  assertProductionIosRequiredSecretNames,
  matchesProductionIosRequiredSecretNames,
} from '../scripts/lib/gateway-required-secret-names.mjs';

const SANDBOX_SEVEN = Object.freeze([
  'APPLE_IAP_ISSUER_ID',
  'APPLE_IAP_KEY_ID',
  'APPLE_IAP_PRIVATE_KEY',
  'GOOGLE_PLAY_SERVICE_ACCOUNT_JSON',
  'ENTITLEMENT_HANDLE_KEY_CURRENT',
  'ENTITLEMENT_HANDLE_KEY_PREVIOUS',
  'R2_CAPABILITY_HMAC_KEY',
]);

const PRODUCTION_SIX = Object.freeze([
  'APPLE_IAP_ISSUER_ID',
  'APPLE_IAP_KEY_ID',
  'APPLE_IAP_PRIVATE_KEY',
  'ENTITLEMENT_HANDLE_KEY_CURRENT',
  'ENTITLEMENT_HANDLE_KEY_PREVIOUS',
  'R2_CAPABILITY_HMAC_KEY',
]);

const B3_SECRET_NAME_SITES = Object.freeze([
  'scripts/check-b3-external-prerequisites.mjs',
  'scripts/lib/b3-cloudflare-oauth-child.mjs',
  'scripts/lib/b3-cloudflare-evidence.mjs',
  'scripts/lib/b3-evidence.mjs',
]);

test('sandbox evidence keeps the historical seven names including Play', () => {
  assert.deepEqual(B3_SANDBOX_REQUIRED_SECRET_NAMES, SANDBOX_SEVEN);
  assert.equal(B3_SANDBOX_REQUIRED_SECRET_NAMES.length, 7);
  assert.equal(
    B3_SANDBOX_REQUIRED_SECRET_NAMES.includes(GOOGLE_PLAY_SERVICE_ACCOUNT_SECRET_NAME),
    true,
  );
});

test('production iOS required-secret set is exactly the six iOS names', () => {
  assert.deepEqual(PRODUCTION_IOS_REQUIRED_SECRET_NAMES, PRODUCTION_SIX);
  assert.equal(PRODUCTION_IOS_REQUIRED_SECRET_NAMES.length, 6);
  assert.equal(
    PRODUCTION_IOS_REQUIRED_SECRET_NAMES.includes(GOOGLE_PLAY_SERVICE_ACCOUNT_SECRET_NAME),
    false,
  );
  assert.deepEqual(
    [...new Set(B3_SANDBOX_REQUIRED_SECRET_NAMES)
      .difference(new Set(PRODUCTION_IOS_REQUIRED_SECRET_NAMES))],
    [GOOGLE_PLAY_SERVICE_ACCOUNT_SECRET_NAME],
  );
});

test('production secret-list checks pass only on the exact six iOS names', () => {
  assert.equal(matchesProductionIosRequiredSecretNames([...PRODUCTION_SIX].reverse()), true);
  assert.deepEqual(
    assertProductionIosRequiredSecretNames(['R2_CAPABILITY_HMAC_KEY', ...PRODUCTION_SIX.slice(0, 5)]),
    PRODUCTION_SIX,
  );

  assert.equal(
    matchesProductionIosRequiredSecretNames([...PRODUCTION_SIX, GOOGLE_PLAY_SERVICE_ACCOUNT_SECRET_NAME]),
    false,
  );
  assert.equal(
    matchesProductionIosRequiredSecretNames(
      PRODUCTION_SIX.filter((name) => name !== 'R2_CAPABILITY_HMAC_KEY'),
    ),
    false,
  );
  assert.equal(
    matchesProductionIosRequiredSecretNames([...PRODUCTION_SIX, 'EXTRA_SECRET']),
    false,
  );
  assert.equal(matchesProductionIosRequiredSecretNames([...SANDBOX_SEVEN]), false);
  assert.throws(
    () => assertProductionIosRequiredSecretNames([...SANDBOX_SEVEN]),
    { code: 'production_ios_required_secret_set_invalid' },
  );
});

test('the four B3 secret-name sites import the shared sandbox list', async () => {
  for (const file of B3_SECRET_NAME_SITES) {
    const source = await readFile(new URL(`../${file}`, import.meta.url), 'utf8');
    assert.match(source, /gateway-required-secret-names\.mjs/, file);
  }
});
