import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import test from 'node:test';
import {
  applyLockedListing,
  appStoreConnectRequest,
  buildAppInfoLocalizationPatch,
  buildIapLocalizationPatch,
  buildVersionLocalizationPatch,
  createAppStoreConnectToken,
  resolveAscPrivateKey,
  STALE_SCREENSHOT_DISPLAY_TYPES,
} from '../scripts/lib/app-store-connect.mjs';
import { parseStoreListingCopy } from '../scripts/lib/store-listing-copy.mjs';
import { applyStoreListingFromRepo } from '../scripts/apply-store-listing.mjs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

function pemKeyPair() {
  return generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({
    type: 'pkcs8',
    format: 'pem',
  });
}

function mockFetch(routes) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    const method = options.method ?? 'GET';
    const parsed = new URL(url);
    const path = `${parsed.pathname}${parsed.search}`;
    const body = options.body ? JSON.parse(options.body) : undefined;
    calls.push({ method, path, body, authorization: options.headers.Authorization });
    const route = routes.find(
      (candidate) =>
        candidate.method === method &&
        (candidate.path === path ||
          (candidate.pathPrefix && path.startsWith(candidate.pathPrefix))),
    );
    if (!route) {
      return {
        ok: false,
        status: 404,
        text: async () => JSON.stringify({ errors: [{ title: `unmocked ${method} ${path}` }] }),
      };
    }
    return {
      ok: (route.status ?? 200) < 400,
      status: route.status ?? 200,
      text: async () =>
        route.json === undefined ? '' : JSON.stringify(route.json),
    };
  };
  return { fetchImpl, calls };
}

const COPY = parseStoreListingCopy(`App Store Connect app \`6798866142\`, version 1.0

## Locked fields

| Field | Value |
|---|---|
| Name (30) | \`Spelling Camp\` |
| Subtitle (30) | \`Offline KS2 spelling practice\` |
| Privacy Policy URL | \`https://help.eugnel.uk/privacy\` |
| Support URL | \`https://help.eugnel.uk/\` |
| Marketing URL | empty |
| Home Screen name | \`Spelling Camp\` |

## Promotional text (170; evergreen)

\`\`\`
Hear it, type it, master it.
\`\`\`

## Keywords (100)

\`\`\`
Key Stage 2,SATs
\`\`\`

## Description

\`\`\`
Grown-ups stay in control. Progress stays on this device.
\`\`\`

## In-app purchase — Full KS2

| Field | Value |
|---|---|
| Product id | \`uk.eugnel.ks2spelling.fullks2\` |
| Display name | \`Full KS2\` |
| Description | \`All 213 KS2 spelling words, with offline audio. One-time unlock.\` |
| Promotional image | \`assets/branding/iap-full-ks2-phaeton.png\` |
`);

test('App Store Connect JWT is ES256 with a 20-minute audience claim', () => {
  const token = createAppStoreConnectToken({
    keyId: 'NA8CPX2ZL2',
    issuerId: '86050c03-0021-426c-8c9a-70965f016e81',
    privateKeyPem: pemKeyPair(),
    now: 1_700_000_000_000,
  });
  const [header, payload, signature] = token.split('.');
  assert.deepEqual(JSON.parse(Buffer.from(header, 'base64url').toString('utf8')), {
    alg: 'ES256',
    kid: 'NA8CPX2ZL2',
    typ: 'JWT',
  });
  assert.deepEqual(JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')), {
    iss: '86050c03-0021-426c-8c9a-70965f016e81',
    iat: 1_700_000_000,
    exp: 1_700_000_000 + 20 * 60,
    aud: 'appstoreconnect-v1',
  });
  assert.equal(signature.length > 0, true);
});

test('missing App Store Connect private key fails closed without calling the API', async () => {
  await assert.rejects(
    () =>
      resolveAscPrivateKey({
        env: {},
        home: '/tmp/ks2-spelling-no-asc-keys',
        readFileImpl: async () => {
          throw new Error('missing');
        },
      }),
    ({ code }) => code === 'missing_asc_private_key',
  );
});

test('listing patches carry the locked URLs, description and IAP strings', () => {
  assert.deepEqual(buildAppInfoLocalizationPatch(COPY), {
    privacyPolicyUrl: 'https://help.eugnel.uk/privacy',
    supportUrl: 'https://help.eugnel.uk/',
    marketingUrl: null,
  });
  assert.deepEqual(buildVersionLocalizationPatch(COPY), {
    description: 'Grown-ups stay in control. Progress stays on this device.',
    keywords: 'Key Stage 2,SATs',
    promotionalText: 'Hear it, type it, master it.',
  });
  assert.deepEqual(buildIapLocalizationPatch(COPY), {
    name: 'Full KS2',
    description: 'All 213 KS2 spelling words, with offline audio. One-time unlock.',
  });
});

test('applyLockedListing patches metadata, deletes stale screenshot sets, and refuses screenshot 9', async () => {
  const { fetchImpl, calls } = mockFetch([
    {
      method: 'GET',
      pathPrefix: '/v1/apps/6798866142/appInfos',
      json: { data: [{ id: 'app-info-1' }] },
    },
    {
      method: 'GET',
      pathPrefix: '/v1/appInfos/app-info-1/appInfoLocalizations',
      json: { data: [{ id: 'app-info-loc-1', attributes: { locale: 'en-GB' } }] },
    },
    {
      method: 'PATCH',
      path: '/v1/appInfoLocalizations/app-info-loc-1',
      json: { data: { id: 'app-info-loc-1' } },
    },
    {
      method: 'GET',
      pathPrefix: '/v1/apps/6798866142/appStoreVersions',
      json: {
        data: [
          {
            id: 'version-1',
            attributes: {
              versionString: '1.0',
              appStoreState: 'PREPARE_FOR_SUBMISSION',
            },
          },
        ],
      },
    },
    {
      method: 'GET',
      pathPrefix: '/v1/appStoreVersions/version-1/appStoreVersionLocalizations',
      json: { data: [{ id: 'version-loc-1', attributes: { locale: 'en-GB' } }] },
    },
    {
      method: 'PATCH',
      path: '/v1/appStoreVersionLocalizations/version-loc-1',
      json: { data: { id: 'version-loc-1' } },
    },
    {
      method: 'GET',
      pathPrefix: '/v1/apps/6798866142/inAppPurchasesV2',
      json: { data: [{ id: 'iap-1', attributes: { productId: 'uk.eugnel.ks2spelling.fullks2' } }] },
    },
    {
      method: 'GET',
      pathPrefix: '/v1/inAppPurchasesV2/iap-1/inAppPurchaseLocalizations',
      json: { data: [{ id: 'iap-loc-1', attributes: { locale: 'en-GB' } }] },
    },
    {
      method: 'PATCH',
      path: '/v1/inAppPurchaseLocalizations/iap-loc-1',
      json: { data: { id: 'iap-loc-1' } },
    },
    {
      method: 'GET',
      pathPrefix: '/v1/appStoreVersionLocalizations/version-loc-1/appScreenshotSets',
      json: {
        data: [
          {
            id: 'set-61',
            attributes: { screenshotDisplayType: 'APP_IPHONE_61' },
          },
          {
            id: 'set-67',
            attributes: { screenshotDisplayType: 'APP_IPHONE_67' },
          },
        ],
      },
    },
    { method: 'DELETE', path: '/v1/appScreenshotSets/set-61', status: 204, json: undefined },
  ]);
  const request = ({ method, path, body }) =>
    appStoreConnectRequest({
      token: 'test-token',
      method,
      path,
      body,
      fetchImpl,
    });
  const result = await applyLockedListing({
    request,
    copy: COPY,
    sha256Sums: {
      'iphone/09-grown-ups-stay-in-control.png':
        'b7fab3350cbab077741ce6328996803cc7ce743a1e65864c860834ad172768f2',
    },
  });
  assert.equal(result.screenshots, 'blocked_stale_screenshot_9');
  assert.equal(result.staleScreenshotSets, 'deleted');
  assert.equal(result.iapLocalizationId, 'iap-loc-1');
  const appInfoPatch = calls.find(
    (call) => call.method === 'PATCH' && call.path.endsWith('app-info-loc-1'),
  );
  assert.equal(appInfoPatch.body.data.attributes.marketingUrl, null);
  assert.equal(
    appInfoPatch.body.data.attributes.privacyPolicyUrl,
    'https://help.eugnel.uk/privacy',
  );
  const versionPatch = calls.find(
    (call) => call.method === 'PATCH' && call.path.endsWith('version-loc-1'),
  );
  assert.doesNotMatch(versionPatch.body.data.attributes.description, /\bbackups\b/);
  const deleted = calls.filter((call) => call.method === 'DELETE');
  assert.deepEqual(
    deleted.map((call) => call.path),
    ['/v1/appScreenshotSets/set-61'],
  );
  assert.equal(
    STALE_SCREENSHOT_DISPLAY_TYPES.includes('APP_IPHONE_67'),
    false,
  );
  assert.equal(
    calls.some((call) => call.method === 'DELETE' && call.path.includes('set-67')),
    false,
  );
});

test('applyStoreListingFromRepo uses the repo listing and fails closed without a key', async () => {
  await assert.rejects(
    () =>
      applyStoreListingFromRepo({
        root: ROOT,
        env: { ASC_PRIVATE_KEY_PATH: '/tmp/does-not-exist-authkey.p8' },
        fetchImpl: async () => {
          throw new Error('fetch must not run');
        },
      }),
    ({ code }) => code === 'missing_asc_private_key',
  );
  const markdown = await readFile(join(ROOT, 'docs/product/store-listing.md'), 'utf8');
  const copy = parseStoreListingCopy(markdown);
  assert.equal(copy.homeScreenName, 'Spelling Camp');
});
