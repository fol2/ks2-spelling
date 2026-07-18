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

test('every B3 CI lane checks out the exact pull-request head with full history', async () => {
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

test('B3 CI keeps exactly three jobs on Node 24.18.0 and preserves native boundaries', async () => {
  const workflow = await readWorkflow();
  assert.match(workflow, /^name: B3 continuous integration$/m);
  assert.equal((workflow.match(/^  [a-z][a-z-]+:\n    name:/gm) ?? []).length, 3);
  assert.equal((workflow.match(/node-version: "24\.18\.0"/g) ?? []).length, 3);
  assert.doesNotMatch(workflow, /node-version-file:/);
  assert.match(workflow, /branches:\n\s+- main\n\s+- jamesto\/mobile-b3-billing-download/);
  assert.match(workflow, /group: b3-ci-/);
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
  assert.match(ios, /run: npm run native:sync:check/);
  assert.match(ios, /run: npm run test:ios/);
  assert.match(ios, /-scheme B3SandboxProof/);
  assert.match(ios, /-configuration B3SandboxProof/);
  assert.match(ios, /CODE_SIGNING_ALLOWED=NO/);
  assert.match(ios, /node scripts\/test-ios-pack-inspector\.mjs/);
  assert.match(ios, /npm run prove:b3:ios-storekit-test/);
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
