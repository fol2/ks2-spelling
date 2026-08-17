import { createPrivateKey, createSign } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { screenshotNineIsStale } from './store-listing-copy.mjs';

export const DEFAULT_ASC_KEY_ID = 'NA8CPX2ZL2';
export const DEFAULT_ASC_ISSUER_ID = '86050c03-0021-426c-8c9a-70965f016e81';
export const APP_STORE_CONNECT_API = 'https://api.appstoreconnect.apple.com';
export const STALE_SCREENSHOT_DISPLAY_TYPES = Object.freeze([
  'APP_IPHONE_61',
  'APP_IPAD_PRO_3GEN_11',
]);

export function createAppStoreConnectToken({
  keyId,
  issuerId,
  privateKeyPem,
  now = Date.now(),
}) {
  if (typeof keyId !== 'string' || keyId.length === 0) {
    throw new TypeError('App Store Connect key id is required.');
  }
  if (typeof issuerId !== 'string' || issuerId.length === 0) {
    throw new TypeError('App Store Connect issuer id is required.');
  }
  if (typeof privateKeyPem !== 'string' || !privateKeyPem.includes('PRIVATE KEY')) {
    const error = new Error('App Store Connect private key is not a PEM.');
    error.code = 'missing_asc_private_key';
    throw error;
  }
  const iat = Math.floor(now / 1000);
  const signingInput = [
    Buffer.from(JSON.stringify({ alg: 'ES256', kid: keyId, typ: 'JWT' })).toString(
      'base64url',
    ),
    Buffer.from(
      JSON.stringify({
        iss: issuerId,
        iat,
        exp: iat + 20 * 60,
        aud: 'appstoreconnect-v1',
      }),
    ).toString('base64url'),
  ].join('.');
  const signature = createSign('SHA256')
    .update(signingInput)
    .sign({
      key: createPrivateKey(privateKeyPem),
      dsaEncoding: 'ieee-p1363',
    });
  return `${signingInput}.${signature.toString('base64url')}`;
}

export async function resolveAscPrivateKey({
  env = process.env,
  home = homedir(),
  readFileImpl = readFile,
} = {}) {
  if (typeof env.ASC_PRIVATE_KEY === 'string' && env.ASC_PRIVATE_KEY.includes('PRIVATE KEY')) {
    return env.ASC_PRIVATE_KEY;
  }
  const keyId = env.ASC_KEY_ID || DEFAULT_ASC_KEY_ID;
  const path =
    env.ASC_PRIVATE_KEY_PATH ||
    join(home, '.appstoreconnect/private_keys', `AuthKey_${keyId}.p8`);
  try {
    return await readFileImpl(path, 'utf8');
  } catch {
    const error = new Error(
      'App Store Connect private key is not available in this environment.',
    );
    error.code = 'missing_asc_private_key';
    error.path = path;
    throw error;
  }
}

export function buildAppInfoLocalizationPatch(copy) {
  return Object.freeze({
    privacyPolicyUrl: copy.privacyPolicyUrl,
    supportUrl: copy.supportUrl,
    marketingUrl: copy.marketingUrl === '' ? null : copy.marketingUrl,
  });
}

export function buildVersionLocalizationPatch(copy) {
  return Object.freeze({
    description: copy.description,
    keywords: copy.keywords,
    promotionalText: copy.promotionalText,
  });
}

export function buildIapLocalizationPatch(copy) {
  return Object.freeze({
    name: copy.iap.displayName,
    description: copy.iap.description,
  });
}

export async function appStoreConnectRequest({
  token,
  method,
  path,
  body,
  fetchImpl = fetch,
}) {
  const response = await fetchImpl(`${APP_STORE_CONNECT_API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = { raw: text };
    }
  }
  if (!response.ok) {
    const error = new Error(
      `App Store Connect ${method} ${path} failed: ${response.status}`,
    );
    error.code = 'app_store_connect_request_failed';
    error.status = response.status;
    error.body = json;
    throw error;
  }
  return json;
}

function jsonApiPatch(type, id, attributes) {
  return { data: { type, id, attributes } };
}

function firstOrThrow(data, code, message) {
  const item = Array.isArray(data) ? data[0] : data;
  if (!item?.id) {
    const error = new Error(message);
    error.code = code;
    throw error;
  }
  return item;
}

export async function findEnGbAppInfoLocalization(request, appId) {
  const infos = await request({
    method: 'GET',
    path: `/v1/apps/${appId}/appInfos?limit=10`,
  });
  const appInfo = firstOrThrow(
    infos.data,
    'app_info_not_found',
    'No App Store Connect appInfo exists for this app.',
  );
  const localizations = await request({
    method: 'GET',
    path: `/v1/appInfos/${appInfo.id}/appInfoLocalizations?filter[locale]=en-GB`,
  });
  return firstOrThrow(
    localizations.data,
    'app_info_localization_not_found',
    'No en-GB appInfo localization exists.',
  );
}

export async function findIosVersionLocalization(request, appId, versionString) {
  const versions = await request({
    method: 'GET',
    path: `/v1/apps/${appId}/appStoreVersions?filter[platform]=IOS&limit=50`,
  });
  const match =
    (versions.data ?? []).find(
      (version) => version.attributes?.versionString === versionString,
    ) ??
    (versions.data ?? []).find((version) =>
      ['PREPARE_FOR_SUBMISSION', 'READY_FOR_REVIEW', 'WAITING_FOR_REVIEW'].includes(
        version.attributes?.appStoreState,
      ),
    );
  const version = firstOrThrow(
    match ? [match] : [],
    'app_store_version_not_found',
    'No iOS App Store version is available to receive listing copy.',
  );
  const localizations = await request({
    method: 'GET',
    path: `/v1/appStoreVersions/${version.id}/appStoreVersionLocalizations?filter[locale]=en-GB`,
  });
  return {
    version,
    localization: firstOrThrow(
      localizations.data,
      'version_localization_not_found',
      'No en-GB version localization exists.',
    ),
  };
}

export async function findIapLocalization(request, appId, productId) {
  const purchases = await request({
    method: 'GET',
    path: `/v1/apps/${appId}/inAppPurchasesV2?filter[productId]=${encodeURIComponent(productId)}&limit=10`,
  });
  const purchase = firstOrThrow(
    purchases.data,
    'iap_not_found',
    `In-app purchase ${productId} was not found.`,
  );
  const localizations = await request({
    method: 'GET',
    path: `/v1/inAppPurchasesV2/${purchase.id}/inAppPurchaseLocalizations`,
  });
  const existing = (localizations.data ?? []).find(
    (item) => item.attributes?.locale === 'en-GB',
  );
  return { purchase, localization: existing ?? null };
}

export async function deleteStaleScreenshotSets(request, versionLocalizationId) {
  const sets = await request({
    method: 'GET',
    path: `/v1/appStoreVersionLocalizations/${versionLocalizationId}/appScreenshotSets`,
  });
  const stale = (sets.data ?? []).filter((item) =>
    STALE_SCREENSHOT_DISPLAY_TYPES.includes(item.attributes?.screenshotDisplayType),
  );
  for (const item of stale) {
    await request({ method: 'DELETE', path: `/v1/appScreenshotSets/${item.id}` });
  }
  return stale.length === 0 ? 'absent' : 'deleted';
}

export async function applyLockedListing({
  request,
  copy,
  sha256Sums,
  includeStaleScreenshotDeletion = true,
}) {
  const appInfoLocalization = await findEnGbAppInfoLocalization(request, copy.appId);
  await request({
    method: 'PATCH',
    path: `/v1/appInfoLocalizations/${appInfoLocalization.id}`,
    body: jsonApiPatch(
      'appInfoLocalizations',
      appInfoLocalization.id,
      buildAppInfoLocalizationPatch(copy),
    ),
  });

  const { localization: versionLocalization } = await findIosVersionLocalization(
    request,
    copy.appId,
    copy.versionString,
  );
  await request({
    method: 'PATCH',
    path: `/v1/appStoreVersionLocalizations/${versionLocalization.id}`,
    body: jsonApiPatch(
      'appStoreVersionLocalizations',
      versionLocalization.id,
      buildVersionLocalizationPatch(copy),
    ),
  });

  const { purchase, localization: existingIapLocalization } = await findIapLocalization(
    request,
    copy.appId,
    copy.iap.productId,
  );
  let iapLocalizationId;
  if (existingIapLocalization) {
    iapLocalizationId = existingIapLocalization.id;
    await request({
      method: 'PATCH',
      path: `/v1/inAppPurchaseLocalizations/${iapLocalizationId}`,
      body: jsonApiPatch(
        'inAppPurchaseLocalizations',
        iapLocalizationId,
        buildIapLocalizationPatch(copy),
      ),
    });
  } else {
    const created = await request({
      method: 'POST',
      path: '/v1/inAppPurchaseLocalizations',
      body: {
        data: {
          type: 'inAppPurchaseLocalizations',
          attributes: {
            locale: copy.locale,
            ...buildIapLocalizationPatch(copy),
          },
          relationships: {
            inAppPurchaseV2: {
              data: { type: 'inAppPurchasesV2', id: purchase.id },
            },
          },
        },
      },
    });
    iapLocalizationId = created.data?.id;
  }

  let staleScreenshotSets = 'skipped';
  if (includeStaleScreenshotDeletion) {
    staleScreenshotSets = await deleteStaleScreenshotSets(
      request,
      versionLocalization.id,
    );
  }

  return Object.freeze({
    appInfoLocalizationId: appInfoLocalization.id,
    versionLocalizationId: versionLocalization.id,
    iapLocalizationId,
    staleScreenshotSets,
    screenshots:
      screenshotNineIsStale(sha256Sums)
        ? 'blocked_stale_screenshot_9'
        : 'not_attempted',
  });
}
