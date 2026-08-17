import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  HELP_PRIVACY_URL,
  HELP_PUBLIC_DIR,
  HELP_SITE_EXECUTE_ENV,
  HELP_SITE_FILE_NAMES,
  HELP_SITE_HOST,
  HELP_SUPPORT_EMAIL,
  HELP_SUPPORT_URL,
  HELP_WORKER_NAME,
  HELP_WRANGLER_CONFIG,
  HELP_WRANGLER_RELATIVE,
  PRODUCT_DISPLAY_NAME,
  assertHelpSiteCurrent,
  assertHelpSiteExecuteAllowed,
  buildHelpSiteFiles,
  decodeHelpPageText,
  findHelpPageViolations,
  runHelpSiteWizard,
  wranglerBinPath,
  writeHelpSiteFiles,
} from '../scripts/lib/help-site.mjs';
import { main as generateHelpSite } from '../scripts/generate-help-site.mjs';
import { main as deployHelpSite } from '../scripts/deploy-help-site.mjs';
import { EXIT_CODES } from '../scripts/lib/run-command.mjs';
import {
  PRIVACY_NOTICE_RELATIVE_PATH,
  parsePrivacyNotice,
  privacyNoticeProse,
} from '../src/app/privacy-notice-document.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

async function readUtf8(relative) {
  return readFile(join(ROOT, relative), 'utf8');
}

test('the help Worker config is assets-only with the Custom Domain declared in-config', () => {
  assert.equal(Object.hasOwn(HELP_WRANGLER_CONFIG, 'main'), false);
  assert.equal(HELP_WRANGLER_CONFIG.name, HELP_WORKER_NAME);
  assert.equal(HELP_WRANGLER_CONFIG.workers_dev, false);
  assert.equal(HELP_WRANGLER_CONFIG.assets.directory, './public');
  assert.equal(HELP_WRANGLER_CONFIG.assets.not_found_handling, '404-page');
  assert.equal(HELP_WRANGLER_CONFIG.assets.html_handling, 'drop-trailing-slash');
  assert.equal(Object.hasOwn(HELP_WRANGLER_CONFIG.assets, 'binding'), false);
  assert.deepEqual(HELP_WRANGLER_CONFIG.routes, [
    { pattern: HELP_SITE_HOST, custom_domain: true },
  ]);
});

test('committed help-site files match the privacy-notice source and admit no external requests', async () => {
  const files = await assertHelpSiteCurrent(ROOT);
  assert.deepEqual([...files.keys()], [...HELP_SITE_FILE_NAMES]);

  const markdown = await readUtf8(PRIVACY_NOTICE_RELATIVE_PATH);
  const notice = parsePrivacyNotice(markdown);
  const privacyHtml = files.get('public/privacy.html');
  const rendered = decodeHelpPageText(privacyHtml);
  for (const block of privacyNoticeProse(notice)) {
    assert.ok(rendered.includes(block), `hosted privacy page is missing: ${block}`);
  }
  assert.doesNotMatch(privacyHtml, /A Parent may explicitly export a learning backup/);
  assert.doesNotMatch(privacyHtml, /backup copies previously exported elsewhere/);

  const support = files.get('public/index.html');
  assert.match(support, new RegExp(PRODUCT_DISPLAY_NAME));
  assert.match(support, new RegExp(HELP_SUPPORT_EMAIL));
  assert.match(support, /href="\/privacy"/);
  assert.doesNotMatch(support, /£9\.99|Buy|Restore/);

  for (const [relative, content] of files) {
    assert.deepEqual(
      findHelpPageViolations(content),
      [],
      `${relative} must not make an external request`,
    );
    assert.doesNotMatch(content, /http/i);
  }
});

test('grep for http in the generated HTML finds no absolute URLs', async () => {
  const files = await buildHelpSiteFiles(ROOT);
  for (const name of ['public/index.html', 'public/privacy.html', 'public/404.html', 'public/styles.css']) {
    assert.equal(files.get(name).includes('http'), false, name);
  }
});

test('the product display name on the support page matches CONCEPTS.md', async () => {
  const concepts = await readUtf8('CONCEPTS.md');
  assert.match(concepts, new RegExp(`Home Screen: ${PRODUCT_DISPLAY_NAME}`));
  assert.match(await readUtf8('docs/product/store-listing.md'), /Privacy Policy URL \| `https:\/\/help\.eugnel\.uk\/privacy`/);
});

test('generate --check is green on the committed tree and --write is a no-op when current', async () => {
  assert.equal(await generateHelpSite([]), EXIT_CODES.success);
  assert.equal(await generateHelpSite(['--write']), EXIT_CODES.success);
  await assertHelpSiteCurrent(ROOT);
});

test('a stale privacy page fails the generator check', async () => {
  const sandbox = await mkdtemp(join(tmpdir(), 'help-site-'));
  await mkdir(join(sandbox, dirname(PRIVACY_NOTICE_RELATIVE_PATH)), { recursive: true });
  await writeFile(
    join(sandbox, PRIVACY_NOTICE_RELATIVE_PATH),
    await readUtf8(PRIVACY_NOTICE_RELATIVE_PATH),
  );
  await writeHelpSiteFiles(sandbox);
  await writeFile(join(sandbox, HELP_PUBLIC_DIR, 'privacy.html'), '<!DOCTYPE html>\n', 'utf8');
  await assert.rejects(() => assertHelpSiteCurrent(sandbox), { code: 'help_site_stale' });
});

test('the owner wizard dry-run rehearses deploy, Email Routing, curl and ASC without contacting Cloudflare', async () => {
  const result = await runHelpSiteWizard({
    root: ROOT,
    args: ['--dry-run'],
    wranglerDeploy: async () => {
      throw new Error('dry-run must not deploy');
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.mode, 'dry-run');
  assert.equal(result.plan.supportUrl, HELP_SUPPORT_URL);
  assert.equal(result.plan.privacyUrl, HELP_PRIVACY_URL);
  assert.equal(result.plan.appStoreConnectAppId, '6798866142');
  assert.deepEqual(
    result.plan.steps.map((step) => step.id),
    ['generate', 'deploy', 'email-routing', 'curl', 'test-mail', 'asc'],
  );
  assert.match(result.plan.wranglerCommand, new RegExp(HELP_WRANGLER_RELATIVE));
  assert.equal(result.plan.steps.find((step) => step.id === 'deploy').actor, 'owner');
  assert.match(result.plan.steps.find((step) => step.id === 'asc').action, /privacyPolicyUrl/);
  assert.match(result.plan.steps.find((step) => step.id === 'asc').action, /supportUrl/);
});

test('live execute is refused unless the owner-visible HELP_SITE_EXECUTE gate is set', async () => {
  assert.throws(() => assertHelpSiteExecuteAllowed({}), { code: 'help_site_execute_refused' });
  const code = await deployHelpSite(['--execute'], { root: ROOT, env: {} });
  assert.equal(code, EXIT_CODES.usage);
});

test('execute with the owner gate deploys via the gateway-pinned wrangler and leaves Email Routing to the owner', async () => {
  const calls = [];
  const result = await runHelpSiteWizard({
    root: ROOT,
    args: ['--execute'],
    env: { [HELP_SITE_EXECUTE_ENV]: 'owner' },
    wranglerDeploy: async (request) => {
      calls.push(request);
      return { ok: true };
    },
  });
  assert.equal(result.mode, 'execute');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].bin, wranglerBinPath(ROOT));
  assert.deepEqual(calls[0].args, ['deploy', '--config', join(ROOT, HELP_WRANGLER_RELATIVE)]);
  assert.deepEqual(
    result.remaining.map((step) => step.id),
    ['email-routing', 'curl', 'test-mail', 'asc'],
  );
});

test('the help site does not add a root npm dependency or touch gateway source', async () => {
  const [rootPackage, gatewayPackage, gatewayWrangler] = await Promise.all([
    readUtf8('package.json').then(JSON.parse),
    readUtf8('gateway/package.json').then(JSON.parse),
    readUtf8('gateway/wrangler.jsonc'),
  ]);
  assert.equal(rootPackage.dependencies.wrangler, undefined);
  assert.equal(rootPackage.devDependencies.wrangler, undefined);
  assert.equal(typeof gatewayPackage.devDependencies.wrangler, 'string');
  assert.match(gatewayWrangler, /"name": "ks2-spelling-b3-sandbox"/);
  const listing = await readUtf8('docs/product/store-listing.md');
  assert.match(listing, new RegExp(HELP_SUPPORT_EMAIL));
  assert.match(
    await readUtf8('docs/operations/2026-08-15-submission-day-runbook.md'),
    /scripts\/deploy-help-site\.mjs/,
  );
});
