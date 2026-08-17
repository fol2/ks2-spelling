import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export const STORE_LISTING_RELATIVE_PATH = 'docs/product/store-listing.md';
export const SHA256SUMS_RELATIVE_PATH =
  'design/app-store-screenshots/final-v3/SHA256SUMS';
export const IAP_IMAGE_RELATIVE_PATH = 'assets/branding/iap-full-ks2-phaeton.png';

export const STALE_SCREENSHOT_9_SHA256 = Object.freeze({
  'iphone/09-grown-ups-stay-in-control.png':
    'b7fab3350cbab077741ce6328996803cc7ce743a1e65864c860834ad172768f2',
  'ipad/09-grown-ups-stay-in-control.png':
    'cf0d01120c291a84abd75f9a9cf6507dd8b56faa8cac9d7766d10d863b750e17',
});

const LOCKED_FIELD_KEYS = Object.freeze([
  'Name (30)',
  'Subtitle (30)',
  'Privacy Policy URL',
  'Support URL',
  'Marketing URL',
  'Home Screen name',
]);
const IAP_FIELD_KEYS = Object.freeze([
  'Product id',
  'Display name',
  'Description',
  'Promotional image',
]);

function fail(detail) {
  const error = new Error(`Store listing copy ${detail}.`);
  error.code = 'store_listing_copy_invalid';
  throw error;
}

function section(markdown, heading) {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const match = new RegExp(`## ${escaped}\\n\\n([\\s\\S]*?)(?=\\n## |$)`, 'u').exec(
    markdown,
  );
  if (!match) fail(`is missing section "${heading}"`);
  return match[1].trim();
}

function firstFence(body) {
  const match = /```\n([\s\S]*?)\n```/u.exec(body);
  if (!match) fail('is missing a fenced block');
  return match[1];
}

function unwrapCell(value) {
  if (value === 'empty') return '';
  const tick = /^`([^`]+)`/u.exec(value);
  return tick ? tick[1] : value;
}

function parseTable(body, requiredKeys) {
  const rows = body.split('\n').filter((line) => line.startsWith('|'));
  const parsed = {};
  for (const row of rows) {
    if (row.includes('---')) continue;
    const cells = row.split('|').slice(1, -1).map((cell) => cell.trim());
    if (cells.length < 2 || cells[0] === 'Field') continue;
    parsed[cells[0]] = unwrapCell(cells[1]);
  }
  for (const key of requiredKeys) {
    const value = parsed[key];
    if (key === 'Marketing URL') {
      if (typeof value !== 'string') fail(`is missing table field "${key}"`);
      continue;
    }
    if (typeof value !== 'string' || value.length === 0) {
      fail(`is missing table field "${key}"`);
    }
  }
  return parsed;
}

export function parseSha256Sums(text) {
  if (typeof text !== 'string' || text.trim() === '') {
    fail('SHA256SUMS is empty');
  }
  const entries = {};
  for (const line of text.split('\n').filter(Boolean)) {
    const match = /^([0-9a-f]{64})  (.+)$/u.exec(line);
    if (!match) fail(`SHA256SUMS line is malformed: ${line}`);
    entries[match[2]] = match[1];
  }
  return Object.freeze(entries);
}

export function screenshotNineIsStale(sums) {
  return Object.entries(STALE_SCREENSHOT_9_SHA256).some(
    ([path, sha256]) => sums[path] === sha256,
  );
}

export function parseStoreListingCopy(markdown) {
  if (typeof markdown !== 'string' || markdown.trim() === '') {
    fail('markdown is required');
  }

  const appIdMatch = /App Store Connect app `(\d+)`/u.exec(markdown);
  const versionMatch = /,\s*version ([0-9.]+)/u.exec(markdown);
  if (!appIdMatch || !versionMatch) {
    fail('preamble must name the App Store Connect app id and version');
  }

  const locked = parseTable(section(markdown, 'Locked fields'), LOCKED_FIELD_KEYS);
  const iap = parseTable(
    section(markdown, 'In-app purchase — Full KS2'),
    IAP_FIELD_KEYS,
  );

  const copy = {
    locale: 'en-GB',
    appId: appIdMatch[1],
    versionString: versionMatch[1],
    name: locked['Name (30)'],
    subtitle: locked['Subtitle (30)'],
    privacyPolicyUrl: locked['Privacy Policy URL'],
    supportUrl: locked['Support URL'],
    marketingUrl: locked['Marketing URL'],
    homeScreenName: locked['Home Screen name'],
    promotionalText: firstFence(section(markdown, 'Promotional text (170; evergreen)')),
    keywords: firstFence(section(markdown, 'Keywords (100)')),
    description: firstFence(section(markdown, 'Description')),
    iap: {
      productId: iap['Product id'],
      displayName: iap['Display name'],
      description: iap['Description'],
      promotionalImage: iap['Promotional image'],
    },
  };

  if (copy.homeScreenName !== copy.name) {
    fail('Home Screen name must match the listing name');
  }
  if (/\bbackups\b/u.test(copy.description) || /\bbackups\b/iu.test(copy.promotionalText)) {
    fail('must not promise backups');
  }
  if (/£9\.99/u.test(copy.description) || /£9\.99/u.test(copy.promotionalText)) {
    fail('must not show the IAP price on listing copy');
  }
  if (/purchases are not enabled/iu.test(copy.description)) {
    fail('must not keep the TestFlight purchases sentence');
  }
  if (copy.iap.promotionalImage !== IAP_IMAGE_RELATIVE_PATH) {
    fail('IAP promotional image path drifted from the branding asset');
  }

  return Object.freeze({
    ...copy,
    iap: Object.freeze(copy.iap),
  });
}

export async function readStoreListingCopy(root) {
  return parseStoreListingCopy(
    await readFile(join(root, STORE_LISTING_RELATIVE_PATH), 'utf8'),
  );
}

export async function readScreenshotSums(root) {
  return parseSha256Sums(await readFile(join(root, SHA256SUMS_RELATIVE_PATH), 'utf8'));
}
