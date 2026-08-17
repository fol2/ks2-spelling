import { resolve } from 'node:path';
import {
  applyLockedListing,
  appStoreConnectRequest,
  createAppStoreConnectToken,
  DEFAULT_ASC_ISSUER_ID,
  DEFAULT_ASC_KEY_ID,
  resolveAscPrivateKey,
} from './lib/app-store-connect.mjs';
import { EXIT_CODES, isMain, printJson } from './lib/run-command.mjs';
import {
  IAP_IMAGE_RELATIVE_PATH,
  readScreenshotSums,
  readStoreListingCopy,
} from './lib/store-listing-copy.mjs';

const ROOT = resolve(import.meta.dirname, '..');

export async function applyStoreListingFromRepo({
  root = ROOT,
  env = process.env,
  fetchImpl = fetch,
  now = Date.now(),
} = {}) {
  const copy = await readStoreListingCopy(root);
  const sha256Sums = await readScreenshotSums(root);
  const privateKeyPem = await resolveAscPrivateKey({ env });
  const token = createAppStoreConnectToken({
    keyId: env.ASC_KEY_ID || DEFAULT_ASC_KEY_ID,
    issuerId: env.ASC_ISSUER_ID || DEFAULT_ASC_ISSUER_ID,
    privateKeyPem,
    now,
  });
  const request = ({ method, path, body }) =>
    appStoreConnectRequest({ token, method, path, body, fetchImpl });
  const result = await applyLockedListing({ request, copy, sha256Sums });
  return Object.freeze({
    ok: true,
    code: 'store_listing_applied',
    homeScreenName: copy.homeScreenName,
    iapImagePath: IAP_IMAGE_RELATIVE_PATH,
    iapPromotionalImage: 'not_attempted',
    ...result,
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
