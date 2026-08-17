import { createHash, createPrivateKey, createSign } from 'node:crypto';
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
  });
}

export function buildVersionLocalizationPatch(copy, { includeSupportUrl = true } = {}) {
  return Object.freeze({
    description: copy.description,
    keywords: copy.keywords,
    promotionalText: copy.promotionalText,
    marketingUrl: copy.marketingUrl === '' ? null : copy.marketingUrl,
    ...(includeSupportUrl ? { supportUrl: copy.supportUrl } : {}),
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
    error.path = path;
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
    path: `/v2/inAppPurchases/${purchase.id}/inAppPurchaseLocalizations`,
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

const READY_ASSET_STATES = new Set([
  'COMPLETE',
  'COMPLETE_WITH_WARNINGS',
  'UPLOAD_COMPLETE',
  'PREPARE_FOR_SUBMISSION',
  'WAITING_FOR_REVIEW',
  'APPROVED',
]);

function md5Hex(bytes) {
  return createHash('md5').update(bytes).digest('hex');
}

function defaultWait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assetDeliveryState(attributes) {
  return attributes?.assetDeliveryState?.state ?? attributes?.state;
}

async function getIgnoring404(request, path) {
  try {
    return await request({ method: 'GET', path });
  } catch (error) {
    if (error.status === 404) return { data: null };
    throw error;
  }
}

export async function uploadAssetBytes({ operation, bytes, fetchImpl = fetch }) {
  const headers = {};
  for (const header of operation.requestHeaders ?? []) {
    headers[header.name] = header.value;
  }
  const chunk = bytes.subarray(operation.offset, operation.offset + operation.length);
  const response = await fetchImpl(operation.url, {
    method: operation.method,
    headers,
    body: chunk,
  });
  if (!response.ok) {
    const error = new Error(`Asset upload failed: ${response.status}`);
    error.code = 'app_store_asset_upload_failed';
    error.status = response.status;
    throw error;
  }
}

async function createAndUploadAsset({
  request,
  fetchImpl,
  type,
  attributes,
  relationships,
  bytes,
  wait = defaultWait,
}) {
  const created = await request({
    method: 'POST',
    path: `/v1/${type}`,
    body: { data: { type, attributes, relationships } },
  });
  const id = created.data?.id;
  if (!id) {
    const error = new Error(`App Store Connect did not return a ${type} id.`);
    error.code = 'app_store_asset_create_failed';
    throw error;
  }
  for (const operation of created.data?.attributes?.uploadOperations ?? []) {
    await uploadAssetBytes({ operation, bytes, fetchImpl });
  }
  await request({
    method: 'PATCH',
    path: `/v1/${type}/${id}`,
    body: jsonApiPatch(type, id, {
      uploaded: true,
      sourceFileChecksum: md5Hex(bytes),
    }),
  });
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const read = await request({ method: 'GET', path: `/v1/${type}/${id}` });
    const state = assetDeliveryState(read.data?.attributes);
    if (READY_ASSET_STATES.has(state)) return id;
    if (state === 'FAILED') {
      const error = new Error(`${type} asset delivery failed.`);
      error.code = 'app_store_asset_delivery_failed';
      throw error;
    }
    await wait(2000);
  }
  const error = new Error(`${type} asset delivery did not complete.`);
  error.code = 'app_store_asset_delivery_timeout';
  throw error;
}

export async function replaceIapPromotionalImage({
  request,
  fetchImpl,
  purchaseId,
  fileName,
  bytes,
  wait = defaultWait,
}) {
  const existing = await getIgnoring404(
    request,
    `/v2/inAppPurchases/${purchaseId}/images`,
  );
  for (const item of existing.data ?? []) {
    await request({ method: 'DELETE', path: `/v1/inAppPurchaseImages/${item.id}` });
  }
  return createAndUploadAsset({
    request,
    fetchImpl,
    type: 'inAppPurchaseImages',
    attributes: { fileName, fileSize: bytes.length },
    relationships: {
      inAppPurchase: { data: { type: 'inAppPurchases', id: purchaseId } },
    },
    bytes,
    wait,
  });
}

export async function replaceIapReviewScreenshot({
  request,
  fetchImpl,
  purchaseId,
  fileName,
  bytes,
  wait = defaultWait,
}) {
  const existing = await getIgnoring404(
    request,
    `/v2/inAppPurchases/${purchaseId}/appStoreReviewScreenshot`,
  );
  const currentId = Array.isArray(existing.data)
    ? existing.data[0]?.id
    : existing.data?.id;
  if (currentId) {
    await request({
      method: 'DELETE',
      path: `/v1/inAppPurchaseAppStoreReviewScreenshots/${currentId}`,
    });
  }
  return createAndUploadAsset({
    request,
    fetchImpl,
    type: 'inAppPurchaseAppStoreReviewScreenshots',
    attributes: { fileName, fileSize: bytes.length },
    relationships: {
      inAppPurchaseV2: { data: { type: 'inAppPurchases', id: purchaseId } },
    },
    bytes,
    wait,
  });
}

export async function replaceListingScreenshots({
  request,
  fetchImpl,
  versionLocalizationId,
  sets,
  wait = defaultWait,
}) {
  const listed = await request({
    method: 'GET',
    path: `/v1/appStoreVersionLocalizations/${versionLocalizationId}/appScreenshotSets`,
  });
  const byType = new Map(
    (listed.data ?? []).map((item) => [item.attributes?.screenshotDisplayType, item]),
  );
  const replaced = [];
  for (const set of sets) {
    let record = byType.get(set.displayType);
    if (!record) {
      const created = await request({
        method: 'POST',
        path: '/v1/appScreenshotSets',
        body: {
          data: {
            type: 'appScreenshotSets',
            attributes: { screenshotDisplayType: set.displayType },
            relationships: {
              appStoreVersionLocalization: {
                data: {
                  type: 'appStoreVersionLocalizations',
                  id: versionLocalizationId,
                },
              },
            },
          },
        },
      });
      record = created.data;
    }
    const current = await request({
      method: 'GET',
      path: `/v1/appScreenshotSets/${record.id}/appScreenshots`,
    });
    for (const shot of current.data ?? []) {
      await request({ method: 'DELETE', path: `/v1/appScreenshots/${shot.id}` });
    }
    for (const file of set.files) {
      await createAndUploadAsset({
        request,
        fetchImpl,
        type: 'appScreenshots',
        attributes: { fileName: file.fileName, fileSize: file.bytes.length },
        relationships: {
          appScreenshotSet: {
            data: { type: 'appScreenshotSets', id: record.id },
          },
        },
        bytes: file.bytes,
        wait,
      });
    }
    replaced.push(set.displayType);
  }
  return replaced;
}

export async function applyLockedListing({
  request,
  fetchImpl = fetch,
  copy,
  sha256Sums,
  includeStaleScreenshotDeletion = true,
  includeIapLocalization = true,
  helpUrlsLive = true,
  iapImage,
  screenshotSets,
  wait = defaultWait,
}) {
  const appInfoLocalization = await findEnGbAppInfoLocalization(request, copy.appId);
  if (helpUrlsLive) {
    await request({
      method: 'PATCH',
      path: `/v1/appInfoLocalizations/${appInfoLocalization.id}`,
      body: jsonApiPatch(
        'appInfoLocalizations',
        appInfoLocalization.id,
        buildAppInfoLocalizationPatch(copy),
      ),
    });
  }

  const { localization: versionLocalization } = await findIosVersionLocalization(
    request,
    copy.appId,
    copy.versionString,
  );
  const versionAttributes = {
    ...buildVersionLocalizationPatch(copy, { includeSupportUrl: helpUrlsLive }),
  };
  if (/purchases are not enabled/iu.test(versionLocalization.attributes?.whatsNew ?? '')) {
    versionAttributes.whatsNew = '';
  }
  await request({
    method: 'PATCH',
    path: `/v1/appStoreVersionLocalizations/${versionLocalization.id}`,
    body: jsonApiPatch(
      'appStoreVersionLocalizations',
      versionLocalization.id,
      versionAttributes,
    ),
  });

  const { purchase, localization: existingIapLocalization } = await findIapLocalization(
    request,
    copy.appId,
    copy.iap.productId,
  );
  let iapLocalizationId = existingIapLocalization?.id ?? null;
  if (includeIapLocalization) {
    if (existingIapLocalization) {
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
  }

  let staleScreenshotSets = 'skipped';
  if (includeStaleScreenshotDeletion) {
    staleScreenshotSets = await deleteStaleScreenshotSets(
      request,
      versionLocalization.id,
    );
  }

  let iapPromotionalImage = 'not_attempted';
  let iapReviewScreenshot = 'not_attempted';
  if (iapImage) {
    iapPromotionalImage = await replaceIapPromotionalImage({
      request,
      fetchImpl,
      purchaseId: purchase.id,
      fileName: iapImage.fileName,
      bytes: iapImage.bytes,
      wait,
    });
    iapReviewScreenshot = await replaceIapReviewScreenshot({
      request,
      fetchImpl,
      purchaseId: purchase.id,
      fileName: iapImage.fileName,
      bytes: iapImage.bytes,
      wait,
    });
  }

  let screenshots;
  if (screenshotNineIsStale(sha256Sums)) {
    screenshots = 'blocked_stale_screenshot_9';
  } else if (screenshotSets) {
    screenshots = await replaceListingScreenshots({
      request,
      fetchImpl,
      versionLocalizationId: versionLocalization.id,
      sets: screenshotSets,
      wait,
    });
  } else {
    screenshots = 'not_attempted';
  }

  return Object.freeze({
    appInfoLocalizationId: appInfoLocalization.id,
    versionLocalizationId: versionLocalization.id,
    iapLocalizationId,
    purchaseId: purchase.id,
    iapPromotionalImage,
    iapReviewScreenshot,
    staleScreenshotSets,
    screenshots,
    appInfoUrls: helpUrlsLive ? 'patched' : 'skipped_help_host_down',
  });
}

export async function readListingEvidence(request, {
  appInfoLocalizationId,
  versionLocalizationId,
  iapLocalizationId,
  purchaseId,
}) {
  const [appInfo, version, iapLoc, iap, sets] = await Promise.all([
    request({ method: 'GET', path: `/v1/appInfoLocalizations/${appInfoLocalizationId}` }),
    request({
      method: 'GET',
      path: `/v1/appStoreVersionLocalizations/${versionLocalizationId}`,
    }),
    iapLocalizationId
      ? request({
          method: 'GET',
          path: `/v1/inAppPurchaseLocalizations/${iapLocalizationId}`,
        })
      : Promise.resolve({ data: null }),
    request({
      method: 'GET',
      path: `/v2/inAppPurchases/${purchaseId}?include=images,appStoreReviewScreenshot`,
    }),
    request({
      method: 'GET',
      path: `/v1/appStoreVersionLocalizations/${versionLocalizationId}/appScreenshotSets`,
    }),
  ]);
  const screenshotSets = [];
  for (const set of sets.data ?? []) {
    const shots = await request({
      method: 'GET',
      path: `/v1/appScreenshotSets/${set.id}/appScreenshots`,
    });
    screenshotSets.push({
      id: set.id,
      displayType: set.attributes?.screenshotDisplayType,
      screenshots: (shots.data ?? []).map((shot) => ({
        id: shot.id,
        fileName: shot.attributes?.fileName,
        assetState: assetDeliveryState(shot.attributes),
      })),
    });
  }
  const included = iap.included ?? [];
  return Object.freeze({
    appInfo: {
      privacyPolicyUrl: appInfo.data?.attributes?.privacyPolicyUrl ?? null,
      supportUrl: appInfo.data?.attributes?.supportUrl ?? null,
      marketingUrl: appInfo.data?.attributes?.marketingUrl ?? null,
    },
    version: {
      description: version.data?.attributes?.description ?? null,
      keywords: version.data?.attributes?.keywords ?? null,
      promotionalText: version.data?.attributes?.promotionalText ?? null,
      whatsNew: version.data?.attributes?.whatsNew ?? null,
    },
    iap: {
      id: purchaseId,
      state: iap.data?.attributes?.state ?? null,
      localization: iapLoc.data?.attributes
        ? {
            locale: iapLoc.data.attributes.locale,
            name: iapLoc.data.attributes.name,
            description: iapLoc.data.attributes.description,
          }
        : null,
      images: included
        .filter((item) => item.type === 'inAppPurchaseImages')
        .map((item) => ({
          id: item.id,
          fileName: item.attributes?.fileName ?? null,
          state: assetDeliveryState(item.attributes),
        })),
      reviewScreenshotId:
        included.find((item) => item.type === 'inAppPurchaseAppStoreReviewScreenshots')
          ?.id ??
        iap.data?.relationships?.appStoreReviewScreenshot?.data?.id ??
        null,
    },
    screenshotSets,
  });
}
