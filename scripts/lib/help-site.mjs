import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  PRIVACY_NOTICE_RELATIVE_PATH,
  parsePrivacyNotice,
} from '../../src/app/privacy-notice-document.js';
import { resolveExecutable, runCommand } from './run-command.mjs';

export const HELP_SITE_HOST = 'help.eugnel.uk';
export const HELP_SUPPORT_EMAIL = 'support@eugnel.uk';
export const HELP_WORKER_NAME = 'ks2-spelling-help';
export const HELP_SITE_DIR = 'site';
export const HELP_WRANGLER_RELATIVE = 'site/wrangler.jsonc';
export const HELP_PUBLIC_DIR = 'site/public';
export const HELP_SUPPORT_URL = 'https://help.eugnel.uk/';
export const HELP_PRIVACY_URL = 'https://help.eugnel.uk/privacy';
export const HELP_SITE_EXECUTE_ENV = 'HELP_SITE_EXECUTE';
export const HELP_SITE_EXECUTE_VALUE = 'owner';
export const PRODUCT_DISPLAY_NAME = 'Spelling Camp';
export const WRANGLER_PIN_PACKAGE = 'gateway/package.json';

export const HELP_WRANGLER_CONFIG = Object.freeze({
  name: HELP_WORKER_NAME,
  compatibility_date: '2026-08-17',
  workers_dev: false,
  assets: Object.freeze({
    directory: './public',
    html_handling: 'drop-trailing-slash',
    not_found_handling: '404-page',
  }),
  routes: Object.freeze([
    Object.freeze({ pattern: HELP_SITE_HOST, custom_domain: true }),
  ]),
});

export const HELP_SITE_FILE_NAMES = Object.freeze([
  'wrangler.jsonc',
  'public/styles.css',
  'public/index.html',
  'public/privacy.html',
  'public/404.html',
]);

const ALLOWED_HREFS = Object.freeze([
  '/styles.css',
  '/',
  '/privacy',
  `mailto:${HELP_SUPPORT_EMAIL}`,
]);

export const HELP_SITE_CSS = `:root {
  --paper: #f8f5ec;
  --ink: #1d2b3a;
  --ink-soft: rgb(29 43 58 / 78%);
}

html {
  background: var(--paper);
  color: var(--ink);
}

body {
  margin: 0 auto;
  max-width: 40rem;
  padding: 1.5rem;
  font-family: ui-sans-serif, system-ui, sans-serif;
  line-height: 1.5;
}

a {
  color: var(--ink);
}

.kicker {
  margin: 0 0 0.5rem;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  font-size: 0.8rem;
  color: var(--ink-soft);
}

nav {
  margin: 0.75rem 0 1.5rem;
}

footer {
  margin-top: 2.5rem;
  color: var(--ink-soft);
}
`;

function helpSiteError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export function escapeHtml(text) {
  return String(text)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function renderPage({ title, heading, nav, main }) {
  return `<!DOCTYPE html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<link rel="stylesheet" href="/styles.css">
</head>
<body>
<header>
<p class="kicker"><a href="/">${escapeHtml(PRODUCT_DISPLAY_NAME)}</a></p>
<h1>${escapeHtml(heading)}</h1>
<nav>${nav}</nav>
</header>
<main>
${main}
</main>
<footer>
<p>Contact <a href="mailto:${HELP_SUPPORT_EMAIL}">${HELP_SUPPORT_EMAIL}</a></p>
</footer>
</body>
</html>
`;
}

export function renderSupportPage() {
  return renderPage({
    title: `${PRODUCT_DISPLAY_NAME} support`,
    heading: PRODUCT_DISPLAY_NAME,
    nav: '<a href="/privacy">Privacy notice</a>',
    main: `<p>Offline KS2 spelling practice for Years 3–6. Hear the word, type it, and keep progress on this device. No child accounts, advertising, analytics or tracking.</p>
<p>Email <a href="mailto:${HELP_SUPPORT_EMAIL}">${HELP_SUPPORT_EMAIL}</a> for support and data enquiries.</p>
<p>The privacy notice lives on this site at <a href="/privacy">/privacy</a>. It is the same source the app renders in the Parent area.</p>
`,
  });
}

export function renderPrivacyPage(notice) {
  const body = [
    `<p>Effective date: ${escapeHtml(notice.effectiveDate)}</p>`,
    ...notice.preamble.map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`),
    ...notice.sections.flatMap((section) => [
      `<h2>${escapeHtml(section.heading)}</h2>`,
      ...section.paragraphs.map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`),
    ]),
  ].join('\n');
  return renderPage({
    title: notice.title,
    heading: notice.title,
    nav: '<a href="/">Support</a>',
    main: `${body}\n`,
  });
}

export function renderNotFoundPage() {
  return renderPage({
    title: 'Page not found',
    heading: 'Page not found',
    nav: '<a href="/">Support</a>',
    main: `<p>That address is not a page on this site. The support page is <a href="/">the home page</a>.</p>
`,
  });
}

export async function buildHelpSiteFiles(root) {
  const markdown = await readFile(join(root, PRIVACY_NOTICE_RELATIVE_PATH), 'utf8');
  const notice = parsePrivacyNotice(markdown);
  return new Map([
    ['wrangler.jsonc', `${JSON.stringify(HELP_WRANGLER_CONFIG, null, 2)}\n`],
    ['public/styles.css', HELP_SITE_CSS],
    ['public/index.html', renderSupportPage()],
    ['public/privacy.html', renderPrivacyPage(notice)],
    ['public/404.html', renderNotFoundPage()],
  ]);
}

export function findHelpPageViolations(text) {
  const violations = [];
  if (/http/iu.test(text)) violations.push('http');
  if (/<(?:script|iframe|object|embed|form)\b/iu.test(text)) {
    violations.push('active-content');
  }
  for (const match of text.matchAll(/\bhref\s*=\s*"([^"]*)"/gu)) {
    if (!ALLOWED_HREFS.includes(match[1])) violations.push(`href:${match[1]}`);
  }
  for (const match of text.matchAll(/\bsrc\s*=\s*"([^"]*)"/gu)) {
    violations.push(`src:${match[1]}`);
  }
  return violations;
}

export function decodeHelpPageText(html) {
  return html
    .replace(/<[^>]+>/gu, ' ')
    .replace(/&amp;/gu, '&')
    .replace(/&quot;/gu, '"')
    .replace(/&lt;/gu, '<')
    .replace(/&gt;/gu, '>')
    .replace(/\s+/gu, ' ')
    .trim();
}

export async function assertHelpSiteCurrent(root) {
  const expected = await buildHelpSiteFiles(root);
  const missing = HELP_SITE_FILE_NAMES.filter((name) => !expected.has(name));
  if (missing.length > 0) {
    throw helpSiteError('help_site_inventory_invalid', `Help site inventory is incomplete: ${missing.join(', ')}`);
  }
  for (const [relative, content] of expected) {
    let actual;
    try {
      actual = await readFile(join(root, HELP_SITE_DIR, relative), 'utf8');
    } catch {
      throw helpSiteError(
        'help_site_stale',
        `Missing ${HELP_SITE_DIR}/${relative}; rerun with --write`,
      );
    }
    if (actual !== content) {
      throw helpSiteError(
        'help_site_stale',
        `Committed ${HELP_SITE_DIR}/${relative} is stale; rerun with --write`,
      );
    }
    for (const violation of findHelpPageViolations(content)) {
      throw helpSiteError(
        'help_site_external_request',
        `${relative} contains a forbidden external request: ${violation}`,
      );
    }
  }
  const publicDir = join(root, HELP_PUBLIC_DIR);
  const publicNames = (await readdir(publicDir)).filter((name) => name !== '.' && name !== '..');
  const expectedPublic = new Set(
    HELP_SITE_FILE_NAMES.filter((name) => name.startsWith('public/')).map((name) => name.slice('public/'.length)),
  );
  const extra = publicNames.filter((name) => !expectedPublic.has(name));
  if (extra.length > 0) {
    throw helpSiteError('help_site_inventory_invalid', `Unexpected help-site public files: ${extra.join(', ')}`);
  }
  return expected;
}

export async function writeHelpSiteFiles(root) {
  const files = await buildHelpSiteFiles(root);
  for (const [relative, content] of files) {
    const path = join(root, HELP_SITE_DIR, relative);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, 'utf8');
  }
  return files;
}

export function readPinnedWranglerVersion(packageJson) {
  const wrangler = packageJson?.devDependencies?.wrangler;
  if (typeof wrangler !== 'string' || wrangler.length === 0) {
    throw helpSiteError(
      'help_site_wrangler_pin_missing',
      `${WRANGLER_PIN_PACKAGE} must pin wrangler so the help site adds no new dependency.`,
    );
  }
  return wrangler;
}

export async function loadPinnedWranglerVersion(root) {
  const packageJson = JSON.parse(await readFile(join(root, WRANGLER_PIN_PACKAGE), 'utf8'));
  return readPinnedWranglerVersion(packageJson);
}

export function wranglerBinPath(root) {
  return join(root, 'gateway/node_modules/.bin/wrangler');
}

export function buildHelpSiteWizardPlan({ wranglerVersion }) {
  return Object.freeze({
    host: HELP_SITE_HOST,
    worker: HELP_WORKER_NAME,
    wranglerVersion,
    wranglerCommand: `gateway/node_modules/.bin/wrangler deploy --config ${HELP_WRANGLER_RELATIVE}`,
    supportUrl: HELP_SUPPORT_URL,
    privacyUrl: HELP_PRIVACY_URL,
    supportEmail: HELP_SUPPORT_EMAIL,
    appStoreConnectAppId: '6798866142',
    steps: Object.freeze([
      Object.freeze({
        id: 'generate',
        actor: 'agent',
        action: 'Confirm site/public is generated from docs/legal/privacy-notice.md',
      }),
      Object.freeze({
        id: 'deploy',
        actor: 'owner',
        action: 'Live Cloudflare: wrangler deploy of the assets-only Worker, which creates the Custom Domain',
      }),
      Object.freeze({
        id: 'email-routing',
        actor: 'owner',
        action: `Live Cloudflare Email Routing: verify a destination inbox, then route ${HELP_SUPPORT_EMAIL} to it`,
      }),
      Object.freeze({
        id: 'curl',
        actor: 'owner',
        action: `curl -fsS ${HELP_SUPPORT_URL} and ${HELP_PRIVACY_URL}`,
      }),
      Object.freeze({
        id: 'test-mail',
        actor: 'owner',
        action: `Send and receive one test message to ${HELP_SUPPORT_EMAIL}`,
      }),
      Object.freeze({
        id: 'asc',
        actor: 'agent',
        action: `After the site is live, set App Store Connect app 6798866142 privacyPolicyUrl to ${HELP_PRIVACY_URL} and supportUrl to ${HELP_SUPPORT_URL}`,
      }),
    ]),
  });
}

export function assertHelpSiteExecuteAllowed(env = process.env) {
  if (env[HELP_SITE_EXECUTE_ENV] === HELP_SITE_EXECUTE_VALUE) return;
  throw helpSiteError(
    'help_site_execute_refused',
    'Live Cloudflare deploy is owner-gated. Re-run with --dry-run, or set HELP_SITE_EXECUTE=owner with --execute.',
  );
}

async function spawnPinnedWrangler({
  bin,
  args,
  cwd,
  env,
  wranglerVersion,
  resolveBin,
  run,
}) {
  const resolved = await resolveBin(bin, env);
  if (!resolved) {
    throw helpSiteError(
      'help_site_wrangler_missing',
      `Install gateway dependencies to use the pinned wrangler ${wranglerVersion} at ${bin}.`,
    );
  }
  const result = await run(resolved, args, { cwd, env });
  if (result.spawnError || result.exitCode !== 0) {
    throw helpSiteError(
      'help_site_wrangler_failed',
      result.stderr?.trim() || result.spawnError?.message || 'wrangler deploy failed.',
    );
  }
  return result;
}

function assertWranglerDeploySucceeded(deploy) {
  if (deploy?.spawnError || (Number.isInteger(deploy?.exitCode) && deploy.exitCode !== 0)) {
    throw helpSiteError(
      'help_site_wrangler_failed',
      deploy.stderr?.trim() || deploy.spawnError?.message || 'wrangler deploy failed.',
    );
  }
}

export async function runHelpSiteWizard({
  root,
  args = [],
  env = process.env,
  wranglerDeploy,
  resolveBin = resolveExecutable,
  run = runCommand,
} = {}) {
  const execute = args.includes('--execute') && !args.includes('--dry-run');
  await assertHelpSiteCurrent(root);
  const wranglerVersion = await loadPinnedWranglerVersion(root);
  const plan = buildHelpSiteWizardPlan({ wranglerVersion });
  if (!execute) {
    return Object.freeze({ ok: true, mode: 'dry-run', plan });
  }
  assertHelpSiteExecuteAllowed(env);
  const request = {
    bin: wranglerBinPath(root),
    args: ['deploy', '--config', join(root, HELP_WRANGLER_RELATIVE)],
    cwd: root,
    env,
  };
  const deployFn =
    typeof wranglerDeploy === 'function'
      ? wranglerDeploy
      : (next) => spawnPinnedWrangler({ ...next, wranglerVersion, resolveBin, run });
  const deploy = await deployFn(request);
  assertWranglerDeploySucceeded(deploy);
  return Object.freeze({
    ok: true,
    mode: 'execute',
    plan,
    deploy,
    remaining: plan.steps.filter((step) => step.id !== 'generate' && step.id !== 'deploy'),
  });
}

