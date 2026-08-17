import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  PRIVACY_NOTICE_RELATIVE_PATH,
  parsePrivacyNotice,
  privacyNoticeProse,
} from '../src/app/privacy-notice-document.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const NOTICE_PATH = join(ROOT, PRIVACY_NOTICE_RELATIVE_PATH);

function decodeRenderedText(html) {
  return html
    .replace(/<[^>]+>/gu, ' ')
    .replace(/&amp;/gu, '&')
    .replace(/&#x27;/gu, "'")
    .replace(/&apos;/gu, "'")
    .replace(/&quot;/gu, '"')
    .replace(/&lt;/gu, '<')
    .replace(/&gt;/gu, '>')
    .replace(/\s+/gu, ' ')
    .trim();
}

async function readNotice() {
  return readFile(NOTICE_PATH, 'utf8');
}

test('the committed privacy notice is the closed markdown subset the in-app renderer accepts', async () => {
  const markdown = await readNotice();
  const notice = parsePrivacyNotice(markdown);
  assert.equal(notice.title, 'KS2 Spelling privacy notice');
  assert.equal(notice.effectiveDate, '17 August 2026');
  assert.equal(notice.sections.length, 4);
  assert.deepEqual(
    notice.sections.map((section) => section.heading),
    [
      'Data kept on the device',
      'Network and sharing',
      'Retention and control',
      'Publication contact',
    ],
  );
});

test('COPPA 312.10 retention is stated: we retain nothing, family iCloud holds the replica, and deleting the app does not delete iCloud copies', async () => {
  const markdown = await readNotice();
  const retention = parsePrivacyNotice(markdown).sections.find(
    (section) => section.heading === 'Retention and control',
  );
  assert.ok(retention, 'retention section must exist');
  const text = retention.paragraphs.join(' ');
  assert.match(text, /We retain nothing\./);
  assert.match(text, /The family's iCloud holds the replica of learner/);
  assert.match(text, /does not delete iCloud copies/);
  assert.match(text, /Deleting the application removes\s+its remaining application-controlled\s+local data\./);
  assert.doesNotMatch(text, /backup copies previously exported elsewhere/);
  assert.doesNotMatch(text, /Nothing is retained off the device/);
});

test('COPPA 312.4(d)(3) internal operations: the transiting IP is disclosed, purpose-limited, and not retained', async () => {
  const markdown = await readNotice();
  const network = parsePrivacyNotice(markdown).sections.find(
    (section) => section.heading === 'Network and sharing',
  );
  assert.ok(network, 'network section must exist');
  const text = network.paragraphs.join(' ');
  assert.match(
    text,
    /An IP address necessarily reaches the entitlement gateway to service a purchase-verification or download request\./,
    'the transiting IP must be disclosed',
  );
  assert.match(
    text,
    /It is used only for that purpose and is not retained or used to contact or profile anyone\./,
  );
  assert.doesNotMatch(text, /A Parent may explicitly export a learning backup/);
});

test('the privacy-notice parser refuses links, HTML, lists and headings it cannot render', () => {
  const valid = '# Title\n\nEffective date: 14 August 2026\n\nPreamble.\n\n## Section\n\nBody.\n';
  parsePrivacyNotice(valid);

  assert.throws(
    () => parsePrivacyNotice(`${valid}\nSee [the policy](https://example.invalid).\n`),
    /markdown links|external URLs/,
  );
  assert.throws(
    () => parsePrivacyNotice(`${valid}\nVisit https://example.invalid\n`),
    /external URLs/,
  );
  assert.throws(
    () => parsePrivacyNotice(`${valid}\n<p>html</p>\n`),
    /HTML/,
  );
  assert.throws(
    () => parsePrivacyNotice(`${valid}\n### Deeper\n\nNo.\n`),
    /deeper than level 2/,
  );
  assert.throws(
    () => parsePrivacyNotice(`${valid}\n- a list\n`),
    /lists/,
  );
});

test('the Vite embed plugin inlines the privacy-notice document bytes at build time', async () => {
  const { createPrivacyNoticeEmbed } = await import('../vite.config.js');
  const markdown = await readNotice();
  const plugin = createPrivacyNoticeEmbed();
  const resolved = plugin.resolveId('virtual:privacy-notice');
  assert.equal(resolved, '\0virtual:privacy-notice');
  assert.equal(
    plugin.load(resolved),
    `export default ${JSON.stringify(markdown)};\n`,
  );
});

test('ParentArea mounts PrivacyNoticeCard and does not hand-duplicate the notice', async () => {
  const [productApp, card] = await Promise.all([
    readFile(join(ROOT, 'src/app/ProductApp.jsx'), 'utf8'),
    readFile(join(ROOT, 'src/app/PrivacyNoticeCard.jsx'), 'utf8'),
  ]);
  assert.match(productApp, /<PrivacyNoticeCard\s*\/>/);
  assert.doesNotMatch(productApp, /No advertising, analytics or tracking/);
  assert.doesNotMatch(
    productApp,
    /Learner nicknames, year groups, spelling progress and Parent/,
  );
  assert.match(card, /from 'virtual:privacy-notice'/);
  assert.doesNotMatch(card, /https?:\/\//i);
  const viteConfig = await readFile(join(ROOT, 'vite.config.js'), 'utf8');
  assert.match(viteConfig, /createPrivacyNoticeEmbed/);
  assert.match(viteConfig, /docs\/legal\/privacy-notice\.md/);
});

test('the rendered in-app privacy card matches the privacy-notice document in full', async (t) => {
  const markdown = await readNotice();
  const prose = privacyNoticeProse(parsePrivacyNotice(markdown));
  const React = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { createServer } = await import('vite');
  const vite = await createServer({
    configFile: join(ROOT, 'vite.config.js'),
    server: { middlewareMode: true, hmr: false },
    appType: 'custom',
  });
  t.after(() => vite.close());
  const { PrivacyNoticeCard } = await vite.ssrLoadModule('/src/app/PrivacyNoticeCard.jsx');
  const html = renderToStaticMarkup(React.createElement(PrivacyNoticeCard));
  const rendered = decodeRenderedText(html);

  assert.equal(prose.length > 8, true, 'the document must contribute more than a summary');
  for (const block of prose) {
    assert.ok(
      rendered.includes(block),
      `rendered in-app text is missing document prose: ${block}`,
    );
  }
  assert.doesNotMatch(html, /href\s*=/i);
  assert.doesNotMatch(html, /https?:\/\//i);
  assert.match(html, /Third-party notices/);
});
