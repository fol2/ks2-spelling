import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CI_PATH = join(ROOT, '.github/workflows/ci.yml');
const CERTIFY_PATH = join(ROOT, '.github/workflows/certify.yml');
const PACKAGE_PATH = join(ROOT, 'package.json');

const SHA_PINNED_USE = /^\s*uses:\s*[^\s@]+@[0-9a-f]{40}(?:\s+#.*)?$/u;

function extractJob(workflow, jobName) {
  const marker = `  ${jobName}:\n`;
  const start = workflow.indexOf(marker);
  assert.notEqual(start, -1, `missing CI job: ${jobName}`);
  const remainder = workflow.slice(start + marker.length);
  const next = remainder.search(/^  [a-z][a-z-]+:\n/m);
  return next === -1
    ? workflow.slice(start)
    : workflow.slice(start, start + marker.length + next);
}

function extractStep(job, stepName) {
  const marker = `      - name: ${stepName}\n`;
  const start = job.indexOf(marker);
  assert.notEqual(start, -1, `missing step: ${stepName}`);
  const remainder = job.slice(start + marker.length);
  const next = remainder.search(/^      - name: /m);
  return next === -1
    ? job.slice(start)
    : job.slice(start, start + marker.length + next);
}

test('CI pins the B4 Node engine and every third-party action', async () => {
  const workflow = await readFile(CI_PATH, 'utf8');

  assert.doesNotMatch(workflow, /node-version:\s*["']?22/u);
  assert.doesNotMatch(workflow, /uses:\s*[^\n]+@(?:main|master|v\d+(?:\.\d+){0,2})\b/u);

  const usesLines = workflow
    .split('\n')
    .filter((line) => /^\s*uses:/u.test(line));
  assert.ok(usesLines.length > 0);
  for (const line of usesLines) {
    assert.match(line, SHA_PINNED_USE, `unpinned action: ${line.trim()}`);
  }

  const nodeSetupCount = (workflow.match(/node-version:\s*["']24\.18\.0["']/gu) ?? []).length;
  assert.equal(nodeSetupCount, 3);
});

test('CI keeps exactly three jobs and the frozen native runner contract', async () => {
  const workflow = await readFile(CI_PATH, 'utf8');

  const jobs = workflow
    .split('\n')
    .filter((line) => /^  [a-z][a-z-]+:$/u.test(line))
    .map((line) => line.trim().slice(0, -1));
  assert.deepEqual(jobs, ['domain-web', 'android-compile', 'ios-compile']);

  assert.match(workflow, /push:\n    branches:\n      - main\n      - jamesto\/mobile-b3-billing-download\n      - jamesto\/mobile-b4-vertical-slice\n  schedule:/u);
  assert.match(workflow, /cron:\s*["']0 6 \* \* \*["']/u);
  assert.match(workflow, /group: b4-ci-\$\{\{ github\.workflow \}\}-\$\{\{ github\.ref \}\}/u);
  assert.match(workflow, /cancel-in-progress: true/u);
  assert.match(workflow, /runs-on: macos-26/u);
  assert.match(workflow, /Require Xcode 26 or newer/u);
  assert.match(workflow, /test "\$xcode_major" -ge 26/u);
  assert.match(workflow, /distribution: temurin/u);
  assert.match(workflow, /java-version:\s*["']21["']/u);
  assert.match(workflow, /platforms;android-36/u);
  assert.match(workflow, /build-tools;36\.0\.0/u);
  assert.match(workflow, /gradle\/actions\/setup-gradle@[0-9a-f]{40}/u);
  assert.match(workflow, /validate-wrappers: true/u);

  const android = extractJob(workflow, 'android-compile');
  assert.match(android, /npm run test:android/u);
  assert.match(android, /npm run build -- --mode sandbox/u);
  assert.match(android, /:app:assembleSandbox/u);
  assert.match(android, /npm run sync:b4-development/u);
  assert.match(android, /:app:assembleDebug :app:assembleDebugAndroidTest/u);
  assert.match(android, /:app:assembleRelease/u);
  assert.match(android, /npm run report:b4-development:check/u);
  assert.match(android, /bundleB3SandboxProofRelease/u);
  assert.match(android, /npm run certify:android/u);
  assert.match(android, /npm run test:android-resolved-policy/u);

  const ios = extractJob(workflow, 'ios-compile');
  assert.match(ios, /npm run test:ios/u);
  assert.match(ios, /npm run verify:ios-release-artefacts/u);
  assert.match(ios, /npm run sync:b4-development/u);
  assert.match(ios, /-scheme B4DevelopmentUITests/u);
  assert.match(ios, /-configuration Debug/u);
  assert.match(ios, /-configuration Release/u);
  assert.match(ios, /npm run report:b4-development:check/u);
  assert.match(ios, /-scheme B3SandboxProof/u);
  assert.match(ios, /npm run prove:b3:ios-storekit-test/u);
  assert.match(ios, /node scripts\/test-ios-pack-inspector\.mjs/u);
  assert.match(ios, /node scripts\/audit-dependencies\.mjs --require-fresh-ios-privacy-manifests/u);
});

test('CI classifies native inputs before installing platform toolchains', async () => {
  const workflow = await readFile(CI_PATH, 'utf8');

  for (const jobName of ['android-compile', 'ios-compile']) {
    const job = extractJob(workflow, jobName);
    assert.match(job, /- name: Detect native-affecting changes\n\s+id: filter/u);
    assert.match(job, /run: node scripts\/detect-native-ci-changes\.mjs/u);
    assert.match(job, /MERGE_GROUP_BASE_SHA: \$\{\{ github\.event\.merge_group\.base_sha \}\}/u);
    assert.match(job, /PUSH_BEFORE_SHA: \$\{\{ github\.event\.before \}\}/u);
    assert.match(job, /CERTIFICATION: \$\{\{ inputs\.certification \}\}/u);
    assert.doesNotMatch(job, /grep -qE/u);
    const detector = job.indexOf('- name: Detect native-affecting changes');
    const install = job.indexOf('- name: Install exact JavaScript dependencies');
    assert.ok(detector >= 0 && install > detector);
  }
});

test('all lanes enforce the B3 evidence topology while the domain lane owns gateway checks', async () => {
  const workflow = await readFile(CI_PATH, 'utf8');

  const exitChecks = workflow.match(
    /node scripts\/build-b3-exit-report\.mjs --check-ci/gu,
  );
  assert.equal(exitChecks?.length, 3);

  const domain = extractJob(workflow, 'domain-web');
  assert.match(domain, /npm run verify:b2-authority/u);
  assert.match(domain, /npm run verify:vendor/u);
  assert.match(domain, /npm run test:upstream:a3/u);
  assert.match(domain, /npm run build:b3-proof-pack/u);
  assert.match(domain, /npm --prefix gateway test/u);
  assert.match(domain, /npm --prefix gateway run lint/u);
  assert.match(domain, /npm --prefix gateway run deploy:dry-run/u);
  assert.match(domain, /node scripts\/rehearse-b3-deploy-config\.mjs/u);
  assert.match(domain, /npm --prefix gateway audit --audit-level=high/u);
  assert.match(domain, /npm run prove:b3:deterministic/u);
  assert.match(domain, /npm run lint/u);
  assert.match(domain, /npm run build/u);
  assert.match(domain, /npm run build:b4-development/u);
  assert.match(domain, /npm run report:b4-development:check/u);
  assert.match(domain, /node scripts\/prove-b4-evidence-successor\.mjs/u);
});

test('CI keeps zero live deployment, store mutation or physical-device work', async () => {
  const workflow = await readFile(CI_PATH, 'utf8');

  assert.doesNotMatch(workflow, /deploy:b3:sandbox/u);
  assert.doesNotMatch(workflow, /prove:b3:cloudflare/u);
  assert.doesNotMatch(workflow, /prove:b3:ios(?:\s|$)/u);
  assert.doesNotMatch(workflow, /prove:b3:android/u);
  assert.doesNotMatch(workflow, /launch:ios/u);
  assert.doesNotMatch(workflow, /launch:android/u);
  assert.doesNotMatch(workflow, /security-events:\s*write/u);
});

test('certification reuses the complete B4 gate and packages its exact outputs', async () => {
  const [ci, certify] = await Promise.all([
    readFile(CI_PATH, 'utf8'),
    readFile(CERTIFY_PATH, 'utf8'),
  ]);

  assert.match(ci, /workflow_call:\n    inputs:\n      certification:/u);
  assert.match(ci, /Package the verified domain and web build bytes/u);
  assert.match(ci, /Package the verified Android build bytes/u);
  assert.match(ci, /Compile the B4 unsigned iOS release for certification/u);
  assert.match(ci, /Package the verified iOS build bytes/u);
  assert.match(ci, /certification-domain-web/u);
  assert.match(ci, /certification-android-compile/u);
  assert.match(ci, /certification-ios-compile/u);

  assert.match(certify, /tags:\n      - "cert-\*"/u);
  assert.match(certify, /uses: \.\/\.github\/workflows\/ci\.yml/u);
  assert.match(certify, /certification: true/u);
  assert.match(certify, /needs: verify/u);
  assert.match(certify, /pattern: certification-\*/u);
  assert.match(certify, /scripts\/build-certification-bundle\.mjs/u);
  assert.doesNotMatch(certify, /npm ci/u);
});

test('the package exposes the real merge gate commands separately from deterministic verification', async () => {
  const packageJson = JSON.parse(await readFile(PACKAGE_PATH, 'utf8'));

  assert.equal(packageJson.scripts['verify:b3'].includes('npm --prefix gateway test'), false);
  assert.equal(packageJson.scripts['verify:b3'].includes('npm run test:android'), true);
  assert.equal(packageJson.scripts['verify:b3'].includes('npm run test:ios'), true);
  assert.equal(packageJson.scripts['verify:b3'].includes('npm run prove:b3:deterministic'), true);
  assert.equal(packageJson.scripts['verify:b3'].includes('build-b3-exit-report.mjs --check-ci'), true);
});

test('tiered CI runs fast PR checks and full integration only at merge time', async () => {
  const workflow = await readFile(CI_PATH, 'utf8');
  const domain = extractJob(workflow, 'domain-web');
  const android = extractJob(workflow, 'android-compile');
  const ios = extractJob(workflow, 'ios-compile');

  assert.match(
    domain,
    /if: github\.event_name == 'pull_request' && steps\.focus\.outputs\.product == 'true'\n\s+run: npm run test:fast/u,
  );
  assert.match(
    domain,
    /if: github\.event_name != 'pull_request'\n\s+run: >-\n\s+node --test\n\s+--test-skip-pattern=/u,
  );
  assert.match(domain, /if: github\.event_name != 'pull_request'\n\s+run: \|\n\s+npm --prefix gateway test/u);
  assert.match(domain, /if: github\.event_name != 'pull_request'\n\s+run: npm run build/u);
  assert.match(
    domain,
    /if: github\.event_name != 'pull_request'\n\s+run: \|\n\s+npm run build:b4-development/u,
  );
  assert.doesNotMatch(domain, /npm test/u);
  assert.match(android, /if: github\.event_name != 'pull_request'/u);
  assert.match(ios, /if: github\.event_name != 'pull_request'/u);
});

test('branch evidence contract cannot skip without inspecting the candidate range', async () => {
  const workflow = await readFile(CI_PATH, 'utf8');
  const domain = extractJob(workflow, 'domain-web');
  const evidenceStep = extractStep(
    domain,
    'Prove B4 evidence commits are evidence-only successors',
  );

  assert.doesNotMatch(evidenceStep, /^\s+if:/mu);
  assert.match(evidenceStep, /EVENT_NAME: \$\{\{ github\.event_name \}\}/u);
  assert.match(
    evidenceStep,
    /MERGE_GROUP_BASE_SHA: \$\{\{ github\.event\.merge_group\.base_sha \}\}/u,
  );
  assert.match(
    evidenceStep,
    /PULL_REQUEST_BASE_SHA: \$\{\{ github\.event\.pull_request\.base\.sha \}\}/u,
  );
  assert.match(evidenceStep, /PUSH_BEFORE_SHA: \$\{\{ github\.event\.before \}\}/u);
  assert.match(evidenceStep, /run: node scripts\/prove-b4-evidence-successor\.mjs/u);
});
