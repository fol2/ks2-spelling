import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  IAP_IMAGE_RELATIVE_PATH,
  LISTING_SCREENSHOT_SETS,
  SCREENSHOT_DIR_RELATIVE_PATH,
  SCREENSHOT_FILENAMES,
  STALE_SCREENSHOT_9_SHA256,
  parseSha256Sums,
  parseStoreListingCopy,
  screenshotNineIsStale,
} from '../scripts/lib/store-listing-copy.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

async function readUtf8(...parts) {
  return readFile(join(ROOT, ...parts), 'utf8');
}

const EXPECTED_PROMOTIONAL_TEXT =
  'Hear it, type it, master it. KS2 spelling for Years 3-6, with companions, a Word Bank, and a parent area. Offline. No accounts, ads or tracking.';
const EXPECTED_KEYWORDS =
  'Key Stage 2,SATs,Year 3,Year 4,Year 5,Year 6,dictation,homework,statutory,revision,lists,test,words';
const EXPECTED_DESCRIPTION = `Spelling Camp is offline KS2 spelling practice for Years 3–6 (ages 7–11). Hear the word, type it, and make it stick — on this device, with no child account.

The free download includes 20 statutory spellings across both year bands, with companions that grow as words become secure. A one-time Full KS2 unlock adds the complete 213-word list and its audio. It downloads once, then practice stays offline.

Spell with confidence: hear it, type it, master it — including a slower replay.
Spell words and grow companions: practice unlocks companions, growth and a world to discover.
Every round is an adventure on the Trail — Smart Review, Trouble, a SATs-style assessed round, and Guardian.
Know every word in the Word Bank: see what is secure, learning or due, then open a word to hear it and practise.
Make spellings stick with Camp and Guardian, returning at the right time.
Learn from every try: clear feedback, and tricky words come back. See every step forward after each round.

Grown-ups stay in control. Learner profiles, weekly goals and progress stay on this device. Purchases live in the Parent area, not in front of the child. No advertising, analytics or tracking.`;

test('the locked listing copy parses into the App Store Connect payload fields', async () => {
  const copy = parseStoreListingCopy(await readUtf8('docs/product/store-listing.md'));
  assert.equal(copy.locale, 'en-GB');
  assert.equal(copy.appId, '6798866142');
  assert.equal(copy.versionString, '1.0');
  assert.equal(copy.name, 'Spelling Camp');
  assert.equal(copy.subtitle, 'Offline KS2 spelling practice');
  assert.equal(copy.privacyPolicyUrl, 'https://help.eugnel.uk/privacy');
  assert.equal(copy.supportUrl, 'https://help.eugnel.uk/');
  assert.equal(copy.marketingUrl, '');
  assert.equal(copy.homeScreenName, 'Spelling Camp');
  assert.equal(copy.promotionalText, EXPECTED_PROMOTIONAL_TEXT);
  assert.equal(copy.promotionalText.length, 144);
  assert.equal(copy.keywords, EXPECTED_KEYWORDS);
  assert.equal(copy.keywords.length, 99);
  assert.equal(copy.keywords.includes(', '), false);
  assert.equal(copy.description, EXPECTED_DESCRIPTION);
  assert.equal(copy.iap.productId, 'uk.eugnel.ks2spelling.fullks2');
  assert.equal(copy.iap.displayName, 'Full KS2');
  assert.equal(
    copy.iap.description,
    'All 213 KS2 spelling words, with offline audio. One-time unlock.',
  );
  assert.equal(copy.iap.promotionalImage, IAP_IMAGE_RELATIVE_PATH);
});

test('the Home Screen name matches the locked listing on iOS, Android and Capacitor', async () => {
  const [copy, infoPlist, strings, capacitorConfig] = await Promise.all([
    readUtf8('docs/product/store-listing.md').then(parseStoreListingCopy),
    readUtf8('ios/App/App/Info.plist'),
    readUtf8('android/app/src/main/res/values/strings.xml'),
    readUtf8('capacitor.config.json').then(JSON.parse),
  ]);

  assert.equal(copy.homeScreenName, 'Spelling Camp');
  assert.match(
    infoPlist,
    /<key>CFBundleDisplayName<\/key>\s*<string>Spelling Camp<\/string>/,
  );
  assert.match(strings, /<string name="app_name">Spelling Camp<\/string>/);
  assert.match(strings, /<string name="title_activity_main">Spelling Camp<\/string>/);
  assert.equal(capacitorConfig.appName, 'Spelling Camp');
  assert.equal(capacitorConfig.appId, 'uk.eugnel.ks2spelling');
});

test('screenshot 9 is a fresh RGB capture, not the stale backup-UI files', async () => {
  const sums = parseSha256Sums(
    await readUtf8('design/app-store-screenshots/final-v3/SHA256SUMS'),
  );
  assert.notEqual(
    sums['iphone/09-grown-ups-stay-in-control.png'],
    STALE_SCREENSHOT_9_SHA256['iphone/09-grown-ups-stay-in-control.png'],
  );
  assert.notEqual(
    sums['ipad/09-grown-ups-stay-in-control.png'],
    STALE_SCREENSHOT_9_SHA256['ipad/09-grown-ups-stay-in-control.png'],
  );
  assert.equal(screenshotNineIsStale(sums), false);
  assert.equal(
    screenshotNineIsStale({
      ...sums,
      'iphone/09-grown-ups-stay-in-control.png':
        STALE_SCREENSHOT_9_SHA256['iphone/09-grown-ups-stay-in-control.png'],
      'ipad/09-grown-ups-stay-in-control.png':
        STALE_SCREENSHOT_9_SHA256['ipad/09-grown-ups-stay-in-control.png'],
    }),
    true,
  );
});

test('screenshot 9 files are opaque RGB at the App Store sizes', async () => {
  for (const set of LISTING_SCREENSHOT_SETS) {
    const bytes = await readFile(
      join(
        ROOT,
        SCREENSHOT_DIR_RELATIVE_PATH,
        set.directory,
        '09-grown-ups-stay-in-control.png',
      ),
    );
    assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    assert.equal(bytes.readUInt32BE(16), set.width);
    assert.equal(bytes.readUInt32BE(20), set.height);
    assert.equal(bytes[25], 2);
    assert.equal(SCREENSHOT_FILENAMES.at(-1), '09-grown-ups-stay-in-control.png');
  }
});

test('listing copy that promises backups or a price is refused', () => {
  const markdown = `App Store Connect app \`6798866142\`, version 1.0

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
Grown-ups stay in control. Progress and backups stay on this device.
\`\`\`

## In-app purchase — Full KS2

| Field | Value |
|---|---|
| Product id | \`uk.eugnel.ks2spelling.fullks2\` |
| Display name | \`Full KS2\` |
| Description | \`All 213 KS2 spelling words, with offline audio. One-time unlock.\` |
| Promotional image | \`assets/branding/iap-full-ks2-phaeton.png\` |
`;
  assert.throws(
    () => parseStoreListingCopy(markdown),
    ({ code, message }) =>
      code === 'store_listing_copy_invalid' && message.includes('must not promise backups'),
  );
});
