import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  applyLockedListing,
  appStoreConnectRequest,
  createAppStoreConnectToken,
  DEFAULT_ASC_ISSUER_ID,
  DEFAULT_ASC_KEY_ID,
  readListingEvidence,
  resolveAscPrivateKey,
} from './lib/app-store-connect.mjs';
import { EXIT_CODES, isMain, printJson } from './lib/run-command.mjs';
import {
  IAP_IMAGE_RELATIVE_PATH,
  LISTING_SCREENSHOT_SETS,
  SCREENSHOT_DIR_RELATIVE_PATH,
  SCREENSHOT_FILENAMES,
  readScreenshotSums,
  readStoreListingCopy,
} from './lib/store-listing-copy.mjs';

const ROOT = resolve(import.meta.dirname, '..');

export async function probeHelpUrls(copy, fetchImpl = fetch) {
  const probe = async (url) => {
    try {
      const response = await fetchImpl(url, { method: 'GET', redirect: 'follow' });
      return response.status;
    } catch {
      return 0;
    }
  };
  const privacy = await probe(copy.privacyPolicyUrl);
  const support = await probe(copy.supportUrl);
  return Object.freeze({
    privacy,
    support,
    live: privacy === 200 && support === 200,
  });
}

async function readListingAssets(root) {
  const screenshotSets = [];
  for (const set of LISTING_SCREENSHOT_SETS) {
    const files = [];
    for (const fileName of SCREENSHOT_FILENAMES) {
      files.push({
        fileName,
        bytes: await readFile(
          join(root, SCREENSHOT_DIR_RELATIVE_PATH, set.directory, fileName),
        ),
      });
    }
    screenshotSets.push({ displayType: set.displayType, files });
  }
  return Object.freeze({ screenshotSets });
}

export async function applyStoreListingFromRepo({
  root = ROOT,
  env = process.env,
  fetchImpl = fetch,
  now = Date.now(),
} = {}) {
  const copy = await readStoreListingCopy(root);
  const sha256Sums = await readScreenshotSums(root);
  const privateKeyPem = await resolveAscPrivateKey({ env });
  const helpUrls = await probeHelpUrls(copy, fetchImpl);
  const assets = await readListingAssets(root);
  const token = createAppStoreConnectToken({
    keyId: env.ASC_KEY_ID || DEFAULT_ASC_KEY_ID,
    issuerId: env.ASC_ISSUER_ID || DEFAULT_ASC_ISSUER_ID,
    privateKeyPem,
    now,
  });
  const request = ({ method, path, body }) =>
    appStoreConnectRequest({ token, method, path, body, fetchImpl });
  const result = await applyLockedListing({
    request,
    fetchImpl,
    copy,
    sha256Sums,
    helpUrlsLive: helpUrls.live,
    includeIapLocalization: false,
    screenshotSets: assets.screenshotSets,
  });
  let evidence = null;
  try {
    evidence = await readListingEvidence(request, result);
  } catch (error) {
    evidence = {
      error: error.message,
      status: error.status ?? null,
      path: error.path ?? null,
      body: error.body ?? null,
    };
  }
  return Object.freeze({
    ok: true,
    code: 'store_listing_applied',
    homeScreenName: copy.homeScreenName,
    iapImagePath: IAP_IMAGE_RELATIVE_PATH,
    helpUrls,
    ...result,
    evidence,
  });
}

export async function main() {
  try {
    printJson(await applyStoreListingFromRepo());
    return EXIT_CODES.success;
  } catch (error) {
    printJson(
      {
        ok: false,
        code: error.code ?? 'store_listing_apply_failed',
        message: error.message,
        status: error.status,
        path: error.path,
        body: error.body,
      },
      process.stderr,
    );
    if (error.code === 'missing_asc_private_key') return EXIT_CODES.usage;
    return EXIT_CODES.commandFailed;
  }
}

if (isMain(import.meta.url)) {
  process.exitCode = await main();
}
