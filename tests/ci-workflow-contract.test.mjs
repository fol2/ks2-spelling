import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CI_PATH = join(ROOT, '.github/workflows/ci.yml');
const CERTIFY_PATH = join(ROOT, '.github/workflows/certify.yml');
const PACKAGE_PATH = join(ROOT, 'package.json');

const VERIFY_B3_COMMAND =
  'npm run verify:b2-authority && npm run verify:vendor && npm run test:upstream:a3 && npm test && npm run lint && npm run build && npm run native:sync:check && npm run test:ios && node scripts/test-ios-pack-inspector.mjs && npm run prove:b3:ios-storekit-test && npm run test:android && npm run certify:android && npm run test:android-resolved-policy && npm run report:b3-native && npm run prove:b3:deterministic && npm run audit:dependencies && node scripts/build-b3-exit-report.mjs --check-ci';
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
  assert.equal((workflow.match(/node-version:\s*["']24\.18\.0["']/gu) ?? []).length, 3);
});

test('every B4 CI lane checks out the exact pull-request head with full history', async () => {
  const workflow = await readFile(CI_PATH, 'utf8');
  const checkoutUses = workflow.match(
    /uses: actions\/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10 # v6/gu,
  );
  const fullHistoryCheckouts = workflow.match(
    /uses: actions\/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10 # v6\n\s+with:\n\s+fetch-depth: 0\n\s+ref: \$\{\{ github\.event_name == 'pull_request' && github\.event\.pull_request\.head\.sha \|\| github\.sha \}\}/gu,
  );
  assert.equal(checkoutUses?.length, 3);
  assert.equal(fullHistoryCheckouts?.length, checkoutUses.length);
});

test('CI keeps exactly three jobs and the frozen native runner contract', async () => {
  const workflow = await readFile(CI_PATH, 'utf8');
  const jobs = [...workflow.matchAll(/^  ([a-z][a-z-]+):\n    name:/gmu)].map(
    (match) => match[1],
  );
  assert.deepEqual(jobs, ['domain-web', 'android-compile', 'ios-compile']);

  assert.match(workflow, /^name: B4 continuous integration$/mu);
  assert.match(
    workflow,
    /push:\n    branches:\n      - main\n      - jamesto\/mobile-b3-billing-download\n      - jamesto\/mobile-b4-vertical-slice\n  schedule:/u,
  );
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

test('all lanes retain B3 topology while Domain/Web owns ordered host-neutral and gateway proof', async () => {
  const workflow = await readFile(CI_PATH, 'utf8');
  assert.equal(
    (workflow.match(/node scripts\/build-b3-exit-report\.mjs --check-ci/gu) ?? []).length,
    3,
  );
  assert.doesNotMatch(workflow, /build-b2-exit-report\.mjs/u);
  assert.doesNotMatch(
    workflow,
    /(?:deploy:b3:sandbox|prove:b3:(?:cloudflare|ios|android)(?:\s|$)|prepare:b3:distribution|verify:b3:installed-distribution|launch:(?:ios|android))/u,
  );

  const domain = extractJob(workflow, 'domain-web');
  for (const command of [
    'npm ci',
    'npm --prefix gateway ci',
    'npm run verify:b2-authority',
    'npm run verify:vendor',
    'npm run test:upstream:a3',
    'npm run build:b3-proof-pack',
    'npm run native:sync:check',
    '--test-skip-pattern=',
    'B3 native audit is rebuilt from closed fresh inputs without weakening B2',
    'compiled owned Swift inspector accepts the proof pack and rejects the full hostile corpus',
    'npm --prefix gateway test',
    'npm --prefix gateway run lint',
    'npm --prefix gateway run deploy:dry-run',
    'node scripts/rehearse-b3-deploy-config.mjs',
    'npm --prefix gateway audit --audit-level=high',
    'npm run prove:b3:deterministic',
    'npm run lint',
    'npm run build',
    'npm run build:b4-development',
    'npm run report:b4-development:check',
    'node scripts/prove-b4-evidence-successor.mjs',
  ]) {
    assert.ok(domain.includes(command), `missing Domain/Web command: ${command}`);
  }
  assert.doesNotMatch(domain, /^\s+run: npm test$/mu);
  assert.ok(domain.indexOf('npm run build:b3-proof-pack') < domain.indexOf('--test-skip-pattern='));
  assert.ok(domain.indexOf('npm run native:sync:check') < domain.indexOf('--test-skip-pattern='));
  assert.ok(
    domain.indexOf('npm --prefix gateway ci') <
      domain.indexOf('node scripts/rehearse-b3-deploy-config.mjs'),
  );
  assert.doesNotMatch(
    domain,
    /setup-java|setup-gradle|sdkmanager|test:ios|test:android|certify:android|test:android-resolved-policy|xcodebuild/u,
  );
});

test('iOS topology precedes normal, B4 and B3 unsigned proof in the required order', async () => {
  const ios = extractJob(await readFile(CI_PATH, 'utf8'), 'ios-compile');
  const nodeSetupIndex = ios.indexOf('node-version: "24.18.0"');
  const topologyIndex = ios.indexOf('node scripts/build-b3-exit-report.mjs --check-ci');
  assert.notEqual(nodeSetupIndex, -1);
  assert.notEqual(topologyIndex, -1);
  assert.match(
    ios,
    /- name: Set up Node\.js\n\s+uses: actions\/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e # v6\n\s+with:\n\s+node-version: "24\.18\.0"\n\s+cache: npm\n\s+- name: Validate B3 pending or complete evidence topology\n\s+run: node scripts\/build-b3-exit-report\.mjs --check-ci/u,
  );
  for (const workload of [
    'xcodebuild',
    'npm run native:sync:check',
    'npm run test:ios',
    'node scripts/audit-dependencies.mjs --require-fresh-ios-privacy-manifests',
    'npm run verify:ios-release-artefacts',
    '-scheme B4DevelopmentUITests',
    '-scheme B3SandboxProof',
    'node scripts/test-ios-pack-inspector.mjs',
    'npm run prove:b3:ios-storekit-test',
  ]) {
    const workloadIndex = ios.indexOf(workload);
    assert.notEqual(workloadIndex, -1, `missing iOS workload: ${workload}`);
    assert.ok(topologyIndex < workloadIndex, `topology must precede ${workload}`);
  }
  assert.ok(ios.indexOf('npm run test:ios') < ios.indexOf('--require-fresh-ios-privacy-manifests'));
  assert.match(ios, /-configuration B3SandboxProof/u);
  assert.match(ios, /CODE_SIGNING_ALLOWED=NO/u);
});

test('tiered CI uses Focus Gate feedback on PRs and full integration only after the PR boundary', async () => {
  const workflow = await readFile(CI_PATH, 'utf8');
  const domain = extractJob(workflow, 'domain-web');
  const android = extractJob(workflow, 'android-compile');
  const ios = extractJob(workflow, 'ios-compile');

  assert.match(workflow, /^  merge_group:$/mu);
  assert.match(workflow, /^  schedule:\n\s+- cron: "0 6 \* \* \*"$/mu);
  assert.match(
    domain,
    /- name: Run F0 documentation and CI contracts\n\s+if: steps\.focus\.outputs\.product == 'false'/u,
  );
  assert.match(
    domain,
    /- name: Install exact root dependencies\n\s+if: steps\.focus\.outputs\.product == 'true'\n\s+run: npm ci/u,
  );
  assert.match(
    domain,
    /if: github\.event_name == 'pull_request' && steps\.focus\.outputs\.product == 'true'\n\s+run: npm run test:fast/u,
  );
  assert.match(
    domain,
    /if: github\.event_name != 'pull_request'\n\s+run: >-\n\s+node --test/u,
  );
  assert.match(android, /^    if: github\.event_name != 'pull_request'$/mu);
  assert.match(ios, /^    if: github\.event_name != 'pull_request'$/mu);
  assert.match(
    android,
    /if: steps\.filter\.outputs\.native == 'true' \|\| github\.event_name == 'schedule' \|\| github\.event_name == 'workflow_dispatch'/u,
  );
});

test('branch evidence contract cannot skip without inspecting the truthful candidate range', async () => {
  const domain = extractJob(await readFile(CI_PATH, 'utf8'), 'domain-web');
  const evidenceStep = extractStep(
    domain,
    'Prove B4 evidence commits are evidence-only successors',
  );

  assert.doesNotMatch(evidenceStep, /^\s+if:/mu);
  assert.match(evidenceStep, /EVENT_NAME: \$\{\{ github\.event_name \}\}/u);
  assert.match(evidenceStep, /MERGE_GROUP_BASE_SHA: \$\{\{ github\.event\.merge_group\.base_sha \}\}/u);
  assert.match(evidenceStep, /PULL_REQUEST_BASE_SHA: \$\{\{ github\.event\.pull_request\.base\.sha \}\}/u);
  assert.match(evidenceStep, /PUSH_BEFORE_SHA: \$\{\{ github\.event\.before \}\}/u);
  assert.match(evidenceStep, /run: node scripts\/prove-b4-evidence-successor\.mjs/u);
  assert.doesNotMatch(evidenceStep, /HEAD\^/u);
});

test('certification reuses the exact heavy gate before deriving one immutable bundle', async () => {
  const [ci, certify] = await Promise.all([
    readFile(CI_PATH, 'utf8'),
    readFile(CERTIFY_PATH, 'utf8'),
  ]);

  assert.match(ci, /^  workflow_call:\n    inputs:\n      certification:\n        required: false\n        type: boolean\n        default: false$/mu);
  for (const [jobName, archive] of [
    ['domain-web', 'domain-web.tar'],
    ['android-compile', 'android-compile.tar'],
    ['ios-compile', 'ios-compile.tar'],
  ]) {
    const job = extractJob(ci, jobName);
    assert.match(job, /if: inputs\.certification == true/u);
    assert.ok(job.includes(`tar -cf .native-build/certification-artifacts/${archive}`));
    assert.match(job, /actions\/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a/u);
    assert.match(job, /if-no-files-found: error/u);
  }
  assert.match(ci, /android\/app\/build\/outputs\/apk\/release\/app-release-unsigned\.apk/u);
  assert.match(ci, /-configuration Release[\s\S]*-derivedDataPath \.native-build\/b4-release-ci/u);
  assert.match(ci, /-derivedDataPath \.native-build\/b3-ci/u);

  assert.match(certify, /^name: B4 milestone certification$/mu);
  assert.match(certify, /^  push:\n    tags:\n      - "cert-\*"$/mu);
  assert.match(certify, /^permissions:\n  contents: read$/mu);
  assert.match(certify, /group: b4-certify-\$\{\{ github\.ref \}\}/u);
  assert.match(certify, /cancel-in-progress: false/u);
  const verify = extractJob(certify, 'verify');
  assert.match(verify, /uses: \.\/\.github\/workflows\/ci\.yml/u);
  assert.match(verify, /with:\n      certification: true/u);
  assert.match(verify, /permissions:\n      contents: read/u);
  assert.doesNotMatch(verify, /secrets:/u);
  const bundle = extractJob(certify, 'bundle');
  assert.match(bundle, /needs: verify/u);
  assert.match(bundle, /runs-on: ubuntu-24\.04/u);
  assert.match(bundle, /actions\/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10/u);
  assert.match(bundle, /fetch-depth: 0\n\s+ref: \$\{\{ github\.sha \}\}/u);
  assert.match(bundle, /actions\/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c/u);
  assert.match(bundle, /pattern: certification-\*/u);
  assert.match(bundle, /merge-multiple: true/u);
  assert.match(bundle, /scripts\/build-certification-bundle\.mjs/u);
  assert.match(bundle, /actions\/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a/u);
  assert.match(bundle, /name: ks2-spelling-\$\{\{ github\.ref_name \}\}-\$\{\{ github\.sha \}\}/u);
  assert.match(bundle, /path: \.native-build\/certification\/\$\{\{ github\.ref_name \}\}/u);
  assert.match(bundle, /if-no-files-found: error/u);
  assert.match(bundle, /retention-days: 90/u);
  assert.doesNotMatch(certify, /(?:gh release|softprops\/action-gh-release|deploy:b3:sandbox)/u);
});

test('Android ordering, sdkmanager path and resolved-policy chain remain exact', async () => {
  const workflow = await readFile(CI_PATH, 'utf8');
  const android = extractJob(workflow, 'android-compile');
  const testAndroidIndex = android.indexOf('run: npm run test:android\n');
  const b3BuildIndex = android.indexOf('bundleB3SandboxProofRelease');
  const certifyAndroidIndex = android.indexOf('run: npm run certify:android\n');
  const resolvedPolicyIndex = android.indexOf('run: npm run test:android-resolved-policy\n');
  assert.ok(testAndroidIndex >= 0 && testAndroidIndex < b3BuildIndex);
  assert.ok(b3BuildIndex < certifyAndroidIndex);
  assert.ok(certifyAndroidIndex < resolvedPolicyIndex);

  const executable = '$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager';
  const executableCheck = `test -x "${executable}"`;
  const install =
    `"${executable}" --install ` +
    '"platform-tools" "platforms;android-36" "build-tools;36.0.0"';
  assert.ok(workflow.indexOf(executableCheck) >= 0);
  assert.ok(workflow.indexOf(install) > workflow.indexOf(executableCheck));
  assert.doesNotMatch(workflow, /^\s*sdkmanager\b/mu);
});

test('package retains the frozen B3 chain and fast local-loop entry points', async () => {
  const packageJson = JSON.parse(await readFile(PACKAGE_PATH, 'utf8'));
  assert.equal(packageJson.scripts['verify:b3'], VERIFY_B3_COMMAND);
  for (const key of ['test:fast', 'test:watch', 'test:changed', 'hooks:install']) {
    assert.equal(typeof packageJson.scripts[key], 'string', `missing script: ${key}`);
  }
});

test('CI keeps zero live deployment, store mutation or physical-device authority', async () => {
  const workflow = await readFile(CI_PATH, 'utf8');
  assert.doesNotMatch(workflow, /deploy:b3:sandbox/u);
  assert.doesNotMatch(workflow, /prove:b3:cloudflare/u);
  assert.doesNotMatch(workflow, /prove:b3:ios(?:\s|$)/u);
  assert.doesNotMatch(workflow, /prove:b3:android/u);
  assert.doesNotMatch(workflow, /launch:ios/u);
  assert.doesNotMatch(workflow, /launch:android/u);
  assert.doesNotMatch(workflow, /security-events:\s*write/u);
});
