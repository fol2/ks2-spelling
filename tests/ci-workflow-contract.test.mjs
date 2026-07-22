import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const WORKFLOW_PATH = join(ROOT, '.github/workflows/ci.yml');
const PACKAGE_PATH = join(ROOT, 'package.json');

const VERIFY_B3_COMMAND =
  'npm run verify:b2-authority && npm run verify:vendor && npm run test:upstream:a3 && npm test && npm run lint && npm run build && npm run native:sync:check && npm run test:ios && node scripts/test-ios-pack-inspector.mjs && npm run prove:b3:ios-storekit-test && npm run test:android && npm run certify:android && npm run test:android-resolved-policy && npm run report:b3-native && npm run prove:b3:deterministic && npm run audit:dependencies && node scripts/build-b3-exit-report.mjs --check-ci';

async function readWorkflow() {
  return readFile(WORKFLOW_PATH, 'utf8');
}

function extractJob(workflow, jobName) {
  const startMarker = `  ${jobName}:\n`;
  const start = workflow.indexOf(startMarker);
  assert.notEqual(start, -1, `missing CI job: ${jobName}`);
  const nextJob = workflow.slice(start + startMarker.length).search(/^  [a-z][a-z-]+:\n/m);
  return nextJob === -1
    ? workflow.slice(start)
    : workflow.slice(start, start + startMarker.length + nextJob);
}

test('every B4 CI lane checks out the exact pull-request head with full history', async () => {
  const workflow = await readWorkflow();
  const checkoutUses = workflow.match(
    /uses: actions\/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10 # v6/g,
  );
  const fullHistoryCheckouts = workflow.match(
    /uses: actions\/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10 # v6\n\s+with:\n\s+fetch-depth: 0\n\s+ref: \$\{\{ github\.event_name == 'pull_request' && github\.event\.pull_request\.head\.sha \|\| github\.sha \}\}/g,
  );
  assert.equal(checkoutUses?.length, 3);
  assert.equal(fullHistoryCheckouts?.length, checkoutUses.length);
});

test('B4 CI keeps exactly three jobs on Node 24.18.0 and preserves native boundaries', async () => {
  const workflow = await readWorkflow();
  assert.match(workflow, /^name: B4 continuous integration$/m);
  assert.equal((workflow.match(/^  [a-z][a-z-]+:\n    name:/gm) ?? []).length, 3);
  assert.equal((workflow.match(/node-version: "24\.18\.0"/g) ?? []).length, 3);
  assert.doesNotMatch(workflow, /node-version-file:/);
  assert.match(
    workflow,
    /branches:\n\s+- main\n\s+- jamesto\/mobile-b3-billing-download\n\s+- jamesto\/mobile-b4-vertical-slice/,
  );
  assert.match(workflow, /group: b4-ci-/);
  assert.match(workflow, /xcode_major.*-ge 26/);
  assert.match(workflow, /"platforms;android-36" "build-tools;36\.0\.0"/);
});

test('all lanes accept only pending or complete B3 evidence topology', async () => {
  const workflow = await readWorkflow();
  assert.equal(
    (workflow.match(/node scripts\/build-b3-exit-report\.mjs --check-ci/g) ?? []).length,
    3,
  );
  assert.doesNotMatch(workflow, /build-b2-exit-report\.mjs/);
  assert.doesNotMatch(
    workflow,
    /(?:deploy:b3:sandbox|prove:b3:(?:cloudflare|ios|android)(?:\s|$)|prepare:b3:distribution|verify:b3:installed-distribution|launch:(?:ios|android))/,
  );
});

test('Domain/Web proves host-neutral and gateway contracts without claiming native hosts', async () => {
  const workflow = await readWorkflow();
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
    'npm --prefix gateway audit --audit-level=high',
    'npm run prove:b3:deterministic',
    'npm run lint',
    'npm run build',
  ]) assert.match(domain, new RegExp(command.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(domain, /^\s+run: npm test$/m);
  assert.ok(
    domain.indexOf('npm run build:b3-proof-pack') < domain.indexOf('--test-skip-pattern='),
    'the proof pack must exist before the host-neutral suite',
  );
  assert.ok(
    domain.indexOf('npm run native:sync:check') < domain.indexOf('--test-skip-pattern='),
    'native bundle inputs must exist before the host-neutral suite',
  );
  assert.doesNotMatch(
    domain,
    /setup-java|setup-gradle|sdkmanager|test:ios|test:android|certify:android|test:android-resolved-policy|xcodebuild/,
  );
});

test('iOS runs normal and B3 unsigned builds, the pack inspector and StoreKit Test', async () => {
  const ios = extractJob(await readWorkflow(), 'ios-compile');
  const nodeSetupIndex = ios.indexOf('node-version: "24.18.0"');
  const topologyIndex = ios.indexOf('node scripts/build-b3-exit-report.mjs --check-ci');
  assert.notEqual(nodeSetupIndex, -1, 'the iOS Node setup is missing');
  assert.notEqual(topologyIndex, -1, 'the iOS topology check is missing');
  assert.match(
    ios,
    /- name: Set up Node\.js\n\s+uses: actions\/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e # v6\n\s+with:\n\s+node-version: "24\.18\.0"\n\s+cache: npm\n\s+- name: Validate B3 pending or complete evidence topology\n\s+run: node scripts\/build-b3-exit-report\.mjs --check-ci/u,
    'the iOS topology check must immediately follow Node setup',
  );
  for (const workload of [
    'xcodebuild',
    'npm run native:sync:check',
    'npm run test:ios',
    '-scheme B3SandboxProof',
    'node scripts/test-ios-pack-inspector.mjs',
    'npm run prove:b3:ios-storekit-test',
  ]) {
    const workloadIndex = ios.indexOf(workload);
    assert.notEqual(workloadIndex, -1, `the iOS workload is missing: ${workload}`);
    assert.ok(topologyIndex < workloadIndex, `topology must precede the iOS workload: ${workload}`);
  }
  assert.match(ios, /run: npm run native:sync:check/);
  assert.match(ios, /run: npm run test:ios/);
  assert.match(ios, /-scheme B3SandboxProof/);
  assert.match(ios, /-configuration B3SandboxProof/);
  assert.match(ios, /CODE_SIGNING_ALLOWED=NO/);
  assert.match(ios, /node scripts\/test-ios-pack-inspector\.mjs/);
  assert.match(ios, /npm run prove:b3:ios-storekit-test/);
});

test('branch evidence contract self-gates to evidence commits and stays a non-empty subset', async () => {
  const domain = extractJob(await readWorkflow(), 'domain-web');
  const step = domain.slice(
    domain.indexOf('Prove B4 evidence commits are evidence-only successors'),
  );
  // The contract no longer taxes ordinary commits: it enforces only when the
  // commit actually changes the B4 development report (self-gating), and it
  // does not run inside the merge queue.
  assert.match(
    step,
    /if: github\.event_name != 'merge_group' && github\.ref != 'refs\/heads\/main'/,
  );
  assert.match(
    step,
    /if git diff --name-only HEAD\^ HEAD \| grep -qx "reports\/b4\/b4-development-report\.json"; then/,
  );
  // When it does apply, the full subset contract is unchanged.
  assert.match(step, /test "\$\(git rev-parse HEAD\^\)" = "\$checkpoint"/);
  assert.match(step, /test -s \/tmp\/b4-actual-paths/);
  assert.match(step, /grep -qx "reports\/b4\/b4-development-report\.json" \/tmp\/b4-actual-paths/);
  assert.match(
    step,
    /test -z "\$\(comm -13 \/tmp\/b4-expected-paths <\(sort \/tmp\/b4-actual-paths\)\)"/,
  );
  assert.doesNotMatch(step, /diff -u \/tmp\/b4-expected-paths/);
});

test('CI is tiered: pull requests run only the fast lane, native compiles are merge-gated', async () => {
  const workflow = await readWorkflow();
  // New triggers: the merge queue is the heavy gate, plus a nightly cold sweep.
  assert.match(workflow, /^  merge_group:$/m);
  assert.match(workflow, /^  schedule:\n\s+- cron: "0 6 \* \* \*"$/m);
  // Both native jobs are skipped entirely on a pull request (keeps PR < 1m),
  // and run as a fail-closed gate on merge_group / push / schedule.
  const android = extractJob(workflow, 'android-compile');
  const ios = extractJob(workflow, 'ios-compile');
  assert.match(android, /^    if: github\.event_name != 'pull_request'$/m);
  assert.match(ios, /^    if: github\.event_name != 'pull_request'$/m);
  // The native compile steps are behind a fail-safe path filter that always
  // runs on the nightly schedule.
  assert.match(
    android,
    /if: steps\.filter\.outputs\.native == 'true' \|\| github\.event_name == 'schedule' \|\| github\.event_name == 'workflow_dispatch'/,
  );
  assert.match(ios, /id: filter/);
  // domain-web splits the fast PR lane from the full merge lane.
  const domain = extractJob(workflow, 'domain-web');
  assert.match(domain, /if: github\.event_name == 'pull_request'\n\s+run: npm run test:fast/);
  assert.match(
    domain,
    /if: github\.event_name != 'pull_request'\n\s+run: >-\n\s+node --test/,
  );
});

test('Android runs normal and B3 unsigned builds before certification', async () => {
  const android = extractJob(await readWorkflow(), 'android-compile');

  const testAndroidIndex = android.indexOf('run: npm run test:android\n');
  const b3BuildIndex = android.indexOf('bundleB3SandboxProofRelease');
  const certifyAndroidIndex = android.indexOf('run: npm run certify:android\n');
  const resolvedPolicyIndex = android.indexOf(
    'run: npm run test:android-resolved-policy\n',
  );
  assert.notEqual(testAndroidIndex, -1, 'Android build and test command is missing');
  assert.notEqual(b3BuildIndex, -1, 'B3 Android unsigned build is missing');
  assert.notEqual(certifyAndroidIndex, -1, 'Android certification command is missing');
  assert.notEqual(resolvedPolicyIndex, -1, 'resolved Android policy command is missing');
  assert.ok(testAndroidIndex < b3BuildIndex, 'B3 build must follow normal Android tests');
  assert.ok(b3BuildIndex < certifyAndroidIndex, 'certification must follow B3 builds');
  assert.ok(
    certifyAndroidIndex < resolvedPolicyIndex,
    'resolved policy tests must follow fresh dependency certification',
  );
});

test('Android CI uses the exact installed sdkmanager path', async () => {
  const workflow = await readWorkflow();
  const executable = '$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager';
  const executableCheck = `test -x "${executable}"`;
  const install =
    `"${executable}" --install ` +
    '"platform-tools" "platforms;android-36" "build-tools;36.0.0"';
  assert.ok(workflow.indexOf(executableCheck) >= 0);
  assert.ok(workflow.indexOf(install) > workflow.indexOf(executableCheck));
  assert.doesNotMatch(workflow, /^\s*sdkmanager\b/m);
});

test('package exposes only the frozen B3 verification chain', async () => {
  const packageJson = JSON.parse(await readFile(PACKAGE_PATH, 'utf8'));
  assert.equal(packageJson.scripts['verify:b3'], VERIFY_B3_COMMAND);
});

test('package exposes the fast-tier daily-loop scripts', async () => {
  const pkg = JSON.parse(await readFile(PACKAGE_PATH, 'utf8'));
  for (const key of ['test:fast', 'test:watch', 'test:changed', 'hooks:install']) {
    assert.equal(typeof pkg.scripts[key], 'string', `missing script: ${key}`);
  }
});
