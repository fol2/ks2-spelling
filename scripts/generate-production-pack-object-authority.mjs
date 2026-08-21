#!/usr/bin/env node

/**
 * Derive or verify production pack-object authority from the live R2 bucket.
 *
 * Read-only against Cloudflare. Writes only the committed repository document
 * when invoked with --write.
 *
 *   node scripts/generate-production-pack-object-authority.mjs --check
 *   node scripts/generate-production-pack-object-authority.mjs --write
 *   node scripts/generate-production-pack-object-authority.mjs --check --ceremony-dir <dir>
 */

import { readdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { EXIT_CODES, isMain } from './lib/run-command.mjs';
import {
  PRODUCTION_PACK_OBJECT_AUTHORITY_RELATIVE,
  PRODUCTION_PACK_OBJECT_BUCKET,
  assertDocumentsMatch,
  assertProductionPackObjectAuthorityBytes,
  assertProductionPackObjectAuthorityMatchesGateway,
  buildProductionPackObjectAuthorityFromLive,
  hashObjectBytes,
  readCompleteCeremonyDirectory,
  readProductionPackSigningKeyring,
  serialiseProductionPackObjectAuthority,
} from './lib/production-pack-object-authority.mjs';
import { parseJsonWithoutDuplicateMembers } from '../src/domain/packs/signed-manifest-contract.js';

const ROOT = resolve(import.meta.dirname, '..');
const ACCOUNT_ID = '6d00cb4a0396c17ad6ba617bcbcaa45d';
const OBJECT_LIST_PATH = (accountId, bucketName) =>
  `https://api.cloudflare.com/client/v4/accounts/${accountId}/r2/buckets/${bucketName}/objects`;

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function parseArgs(args) {
  const write = args.includes('--write');
  if (write && args.includes('--check')) {
    throw fail('usage', 'Pass either --check or --write, not both.');
  }
  const ceremonyIndex = args.indexOf('--ceremony-dir');
  const ceremonyDir = ceremonyIndex === -1 ? null : args[ceremonyIndex + 1];
  if (ceremonyIndex !== -1 && (typeof ceremonyDir !== 'string' || ceremonyDir.startsWith('--'))) {
    throw fail('usage', '--ceremony-dir requires a directory path.');
  }
  return { write, ceremonyDir };
}

function readOauthTokenFromWranglerConfig(text) {
  const match = /^oauth_token\s*=\s*"(.*)"\s*$/m.exec(text);
  if (!match || match[1].length === 0) return null;
  return match[1];
}

export function wranglerConfigCandidates(home = homedir()) {
  return Object.freeze([
    resolve(home, 'Library/Preferences/.wrangler/config/default.toml'),
    resolve(home, '.wrangler/config/default.toml'),
    resolve(home, '.config/.wrangler/config/default.toml'),
  ]);
}

export async function readCloudflareAccessToken({
  env = process.env,
  home = homedir(),
  readFileImpl = readFile,
} = {}) {
  if (typeof env.CLOUDFLARE_API_TOKEN === 'string' && env.CLOUDFLARE_API_TOKEN.length > 0) {
    return env.CLOUDFLARE_API_TOKEN;
  }
  for (const path of wranglerConfigCandidates(home)) {
    let text;
    try {
      text = await readFileImpl(path, 'utf8');
    } catch {
      continue;
    }
    const token = readOauthTokenFromWranglerConfig(text);
    if (token) return token;
  }
  throw fail(
    'cloudflare_reconsent_required',
    'No Cloudflare OAuth session is available to this process. Re-consent with a browser ' +
      '`wrangler login`, then re-run. Do not simulate production object facts.',
  );
}

async function cloudflareJson(url, token, fetchImpl = fetch) {
  const response = await fetchImpl(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = await response.text();
  if (response.status === 401 || response.status === 403) {
    throw fail(
      'cloudflare_reconsent_required',
      'The Cloudflare OAuth session cannot read the production bucket. Re-consent with a ' +
        'browser `wrangler login`, then re-run. Do not simulate production object facts.',
    );
  }
  let payload;
  try {
    payload = JSON.parse(body);
  } catch {
    throw fail('cloudflare_read_failed', `Cloudflare returned a non-JSON response for ${url.pathname}.`);
  }
  if (!response.ok || payload?.success === false) {
    const message = payload?.errors?.[0]?.message ?? `HTTP ${response.status}`;
    throw fail('cloudflare_read_failed', `Cloudflare read failed: ${message}`);
  }
  return payload;
}

export async function listProductionR2Objects({
  token,
  accountId = ACCOUNT_ID,
  bucketName = PRODUCTION_PACK_OBJECT_BUCKET,
  fetchImpl = fetch,
} = {}) {
  const objects = [];
  let cursor;
  const seenCursors = new Set();
  do {
    const url = new URL(OBJECT_LIST_PATH(accountId, bucketName));
    url.searchParams.set('per_page', '1000');
    if (cursor) url.searchParams.set('cursor', cursor);
    const payload = await cloudflareJson(url, token, fetchImpl);
    const page = Array.isArray(payload.result) ? payload.result : [];
    objects.push(...page);
    cursor = payload.result_info?.cursor ?? payload.result_info?.cursors?.after ?? null;
    if (cursor) {
      if (seenCursors.has(cursor)) {
        throw fail('cloudflare_read_failed', 'Cloudflare object listing cursor repeated.');
      }
      seenCursors.add(cursor);
    }
    if (page.length === 0) break;
  } while (cursor);
  return objects;
}

export async function getProductionR2Object({
  token,
  key,
  accountId = ACCOUNT_ID,
  bucketName = PRODUCTION_PACK_OBJECT_BUCKET,
  fetchImpl = fetch,
} = {}) {
  const url = new URL(
    `${OBJECT_LIST_PATH(accountId, bucketName)}/${encodeURIComponent(key)}`,
  );
  const response = await fetchImpl(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (response.status === 401 || response.status === 403) {
    throw fail(
      'cloudflare_reconsent_required',
      'The Cloudflare OAuth session cannot read the production bucket. Re-consent with a ' +
        'browser `wrangler login`, then re-run. Do not simulate production object facts.',
    );
  }
  if (!response.ok) {
    throw fail('cloudflare_read_failed', `Cloudflare GET ${key} failed with HTTP ${response.status}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

export async function generateProductionPackObjectAuthority({
  root = ROOT,
  listObjects,
  getObject,
  ceremonyBytesByKey,
  keyring,
  clock,
  verifyP256Der,
  readFileImpl = readFile,
} = {}) {
  const resolvedKeyring = keyring ?? await readProductionPackSigningKeyring(root, readFileImpl);
  const document = await buildProductionPackObjectAuthorityFromLive({
    listObjects,
    getObject,
    ceremonyBytesByKey,
    keyring: resolvedKeyring,
    clock,
    verifyP256Der,
  });
  await assertProductionPackObjectAuthorityMatchesGateway(root, document);
  return document;
}

export async function createLiveProductionObjectReader({
  env = process.env,
  home = homedir(),
  fetchImpl = fetch,
  readFileImpl = readFile,
} = {}) {
  const token = await readCloudflareAccessToken({ env, home, readFileImpl });
  return {
    listObjects: () => listProductionR2Objects({ token, fetchImpl }),
    getObject: (key) => getProductionR2Object({ token, key, fetchImpl }),
  };
}

function assertCeremonyMatchesAuthorityFacts(ceremonyBytesByKey, document) {
  for (const pack of document.packs) {
    for (const object of pack.objects) {
      const local = hashObjectBytes(ceremonyBytesByKey.get(object.key));
      if (
        local.sha256 !== object.sha256
        || local.etag !== object.etag
        || local.bytes !== object.bytes
      ) {
        throw new TypeError(
          `Production pack-object authority ceremony ${object.key} differs from live/committed facts.`,
        );
      }
    }
  }
}

export async function main(args = process.argv.slice(2), options = {}) {
  const {
    root = ROOT,
    env = process.env,
    home = homedir(),
    fetchImpl = fetch,
    readFileImpl = readFile,
    readdirImpl = readdir,
    writeFileImpl = writeFile,
    log = (line) => process.stderr.write(`${line}\n`),
  } = options;
  try {
    const parsed = parseArgs(args);
    const ceremonyBytesByKey = parsed.ceremonyDir
      ? await readCompleteCeremonyDirectory({
        ceremonyDir: parsed.ceremonyDir,
        readFileImpl,
        readdirImpl,
      })
      : undefined;
    const live = await createLiveProductionObjectReader({ env, home, fetchImpl, readFileImpl });
    const document = await generateProductionPackObjectAuthority({
      root,
      listObjects: async () => {
        const listing = await live.listObjects();
        log(`Listed ${listing.length} live objects in ${PRODUCTION_PACK_OBJECT_BUCKET}.`);
        return listing;
      },
      getObject: async (key) => {
        log(`GET ${key}`);
        return live.getObject(key);
      },
      ceremonyBytesByKey,
      readFileImpl,
    });
    const serialised = serialiseProductionPackObjectAuthority(document);
    const path = resolve(root, PRODUCTION_PACK_OBJECT_AUTHORITY_RELATIVE);
    if (parsed.write) {
      await writeFileImpl(path, serialised, 'utf8');
      log(`Wrote ${PRODUCTION_PACK_OBJECT_AUTHORITY_RELATIVE} from live ${PRODUCTION_PACK_OBJECT_BUCKET}.`);
    } else {
      const committed = await readFileImpl(path);
      assertProductionPackObjectAuthorityBytes(committed);
      assertDocumentsMatch(
        JSON.parse(serialised),
        parseJsonWithoutDuplicateMembers(committed, 'committed production pack-object authority'),
        'live bucket differs from the committed production pack-object authority',
      );
      log(`Checked ${PRODUCTION_PACK_OBJECT_AUTHORITY_RELATIVE} against live ${PRODUCTION_PACK_OBJECT_BUCKET}.`);
    }
    if (ceremonyBytesByKey) {
      assertCeremonyMatchesAuthorityFacts(ceremonyBytesByKey, document);
    }
    log(
      `${document.packs.length} packs / ${document.packs.reduce((count, pack) => count + pack.objects.length, 0)} objects.`,
    );
    return EXIT_CODES.success;
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    if (error.code === 'cloudflare_reconsent_required' || error.code === 'usage') {
      return error.code === 'usage' ? EXIT_CODES.usage : EXIT_CODES.stateMismatch;
    }
    return EXIT_CODES.commandFailed;
  }
}

if (isMain(import.meta.url)) {
  process.exitCode = await main();
}
