import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CONFIG_PATH = join(ROOT, '.github/dependabot.yml');
const WORKFLOW_PATH = join(ROOT, '.github/workflows/dependabot-native-labels.yml');
const POLICY_PATH = join(ROOT, 'docs/operations/dependabot-policy.md');
const NATIVE_DEVELOPMENT_PATH = join(ROOT, 'docs/operations/native-development.md');

const ACTOR_GATE = "github.event.pull_request.user.login == 'dependabot[bot]'";
const ACTOR_CONJUNCT = `${ACTOR_GATE}\n      && (`;
const TITLE_EXPRESSION = 'github.event.pull_request.title';
const CAPACITOR_TITLE_GATE = "contains(github.event.pull_request.title, '@capacitor/')";
const COMMUNITY_TITLE_GATE = "contains(github.event.pull_request.title, '@capacitor-community/')";
const TRUSTED_TITLE_LINES = Object.freeze([
  CAPACITOR_TITLE_GATE,
  `|| ${COMMUNITY_TITLE_GATE}`,
]);
const PULL_REQUEST_TRIGGER = 'on:\n  pull_request:\n    types: [opened, reopened, synchronize]';
const CONSTANT_RUN_STEP = [
  '        run: |',
  '          gh pr edit "$PR_NUMBER" \\',
  '            --repo "$GITHUB_REPOSITORY" \\',
  '            --add-label native-dependency-review',
].join('\n');
const CANONICAL_JOB_IF = [
  '    if: >-',
  `      ${ACTOR_GATE}`,
  '      && (',
  `        ${CAPACITOR_TITLE_GATE}`,
  `        || ${COMMUNITY_TITLE_GATE}`,
  '      )',
].join('\n');

async function readTracked(path) {
  return readFile(path, 'utf8');
}

function headingBlock(markdown, heading) {
  const match = markdown.match(new RegExp(`^${heading}\\n`, 'm'));
  assert.ok(match, `missing ${heading}`);
  const start = match.index + match[0].length;
  const rest = markdown.slice(start);
  const next = rest.search(/^## /m);
  return (next === -1 ? rest : rest.slice(0, next)).trim();
}

function ecosystemBlock(source, ecosystem) {
  const startMarker = `  - package-ecosystem: ${ecosystem}\n`;
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `missing ${ecosystem} update`);
  const rest = source.slice(start + startMarker.length);
  const next = rest.search(/^  - package-ecosystem: /m);
  return next === -1 ? source.slice(start) : source.slice(start, start + startMarker.length + next);
}

function assertWeeklyBlock(block, { ecosystem, time, labels }) {
  assert.match(block, /\n    directory: \/\n/);
  assert.match(block, /\n    schedule:\n      interval: weekly\n      day: monday\n/);
  assert.match(block, new RegExp(`time: "${time}"\\n      timezone: Europe/London\\n`));
  assert.match(block, /\n    open-pull-requests-limit: 5\n/);
  assert.match(block, new RegExp(`labels:\\n      - ${labels.join('\\n      - ')}\\n`));
  assert.doesNotMatch(block, /^\s+groups:/m);
  assert.doesNotMatch(block, /^\s+ignore:/m);
  assert.doesNotMatch(block, /^\s+auto-merge:/m);
  assert.ok(block.includes(`package-ecosystem: ${ecosystem}`));
}

function assertDependabotConfig(source) {
  assert.match(source, /^version: 2$/m);
  assert.equal((source.match(/^  - package-ecosystem: /gm) ?? []).length, 3);
  const npm = ecosystemBlock(source, 'npm');
  const gradle = ecosystemBlock(source, 'gradle');
  const actions = ecosystemBlock(source, 'github-actions');

  assertWeeklyBlock(npm, {
    ecosystem: 'npm',
    time: '06:00',
    labels: ['dependencies', 'manual-review'],
  });
  assert.doesNotMatch(npm, /native-dependency-review/);

  assert.match(gradle, /\n    directory: \/android\n/);
  assert.match(gradle, /\n    schedule:\n      interval: monthly\n      time: "06:15"\n      timezone: Europe\/London\n/);
  assert.match(gradle, /\n    open-pull-requests-limit: 1\n/);
  assert.match(
    gradle,
    /labels:\n      - dependencies\n      - native-dependency-review\n      - manual-review\n/,
  );
  assert.doesNotMatch(gradle, /^\s+groups:/m);
  assert.doesNotMatch(gradle, /^\s+ignore:/m);
  assert.doesNotMatch(gradle, /^\s+auto-merge:/m);

  assertWeeklyBlock(actions, {
    ecosystem: 'github-actions',
    time: '06:30',
    labels: ['dependencies', 'manual-review'],
  });
  assert.doesNotMatch(actions, /native-dependency-review/);
}

function extractLabelJobIf(workflow) {
  const startMarker = '    if: >-\n';
  const start = workflow.indexOf(startMarker);
  assert.notEqual(start, -1, 'missing label job if');
  const end = workflow.indexOf('\n    runs-on:', start);
  assert.notEqual(end, -1, 'missing runs-on after the label job if');
  return workflow.slice(start, end);
}

function assertNativeLabelWorkflow(workflow) {
  assert.equal(
    workflow.includes(PULL_REQUEST_TRIGGER),
    true,
    'missing pull_request opened, reopened, synchronize trigger',
  );
  assert.match(
    workflow,
    /^on:\n  pull_request:\n    types: \[opened, reopened, synchronize\]\n\npermissions:/m,
    'workflow must use pull_request with exactly opened, reopened, synchronize',
  );
  assert.match(workflow, /^permissions:\n  pull-requests: write$/m);
  assert.doesNotMatch(workflow, /contents:\s*write/);
  assert.doesNotMatch(workflow, /issues:\s*write/);
  assert.doesNotMatch(workflow, /actions\/checkout/);
  assert.doesNotMatch(workflow, /pull_request_target/);
  assert.doesNotMatch(workflow, /gh pr merge|gh pr close|enable-automerge|@dependabot merge/);
  assert.equal(
    workflow.includes(ACTOR_CONJUNCT),
    true,
    'missing dependabot[bot] actor gate as a mandatory job-if conjunct',
  );
  assert.equal(workflow.includes(CAPACITOR_TITLE_GATE), true, 'missing @capacitor/ title gate');
  assert.equal(workflow.includes(COMMUNITY_TITLE_GATE), true, 'missing @capacitor-community/ title gate');
  const titleLines = workflow.split('\n')
    .map((line) => line.trim())
    .filter((line) => line.includes(TITLE_EXPRESSION));
  assert.deepEqual(
    titleLines,
    [...TRUSTED_TITLE_LINES],
    'github.event.pull_request.title must appear only in the job-if contains() predicates',
  );
  assert.equal(
    extractLabelJobIf(workflow),
    CANONICAL_JOB_IF,
    'label job if must be exactly the canonical actor-and-title predicate',
  );
  assert.doesNotMatch(
    workflow,
    /\$\{\{\s*github\.event\.pull_request\.title\s*\}\}/,
    'PR title must not be interpolated as a GitHub expression',
  );
  assert.doesNotMatch(workflow, /PR_TITLE/);
  assert.doesNotMatch(workflow, /\n\s+run:[\s\S]*github\.event\.pull_request\.title/);
  assert.equal(
    workflow.includes(CONSTANT_RUN_STEP),
    true,
    'shell step must stay a constant gh pr edit --add-label command',
  );
  assert.match(workflow, /gh pr edit "\$PR_NUMBER"/);
  assert.match(workflow, /--add-label native-dependency-review/);
  assert.doesNotMatch(workflow, /gh label create/);
  for (const line of workflow.split('\n').filter((entry) => entry.includes('${{'))) {
    assert.match(
      line.trim(),
      /^(?:[A-Z][A-Z0-9_]*|group): [\w-]*\$\{\{ [^}]+ \}\}$/,
      `GitHub expression somewhere it could reach a shell: ${line.trim()}`,
    );
  }
}

test('the tracked Dependabot configuration keeps weekly discovery and a one-at-a-time native queue', async () => {
  const source = await readTracked(CONFIG_PATH);
  assertDependabotConfig(source);
});

test('schedule, limit, label, groups, ignore and auto-merge mutations fail the config contract', async () => {
  const source = await readTracked(CONFIG_PATH);

  const weeklyQueue = source
    .replace('interval: monthly', 'interval: weekly')
    .replace('open-pull-requests-limit: 1', 'open-pull-requests-limit: 5');
  assert.notEqual(weeklyQueue, source);
  assert.throws(() => assertDependabotConfig(weeklyQueue), /monthly|open-pull-requests-limit: 1/);

  const unlabelled = source.replace('\n      - native-dependency-review', '');
  assert.notEqual(unlabelled, source);
  assert.throws(() => assertDependabotConfig(unlabelled), /native-dependency-review/);

  const npmNative = source.replace(
    /package-ecosystem: npm[\s\S]*?labels:\n      - dependencies\n      - manual-review\n/,
    (block) => block.replace(
      '      - manual-review\n',
      '      - native-dependency-review\n      - manual-review\n',
    ),
  );
  assert.notEqual(npmNative, source);
  assert.throws(() => assertDependabotConfig(npmNative), /native-dependency-review/);

  const grouped = source.replace(
    '    open-pull-requests-limit: 1\n',
    '    open-pull-requests-limit: 1\n    groups:\n      toolchain:\n        patterns:\n          - gradle\n',
  );
  assert.notEqual(grouped, source);
  assert.throws(() => assertDependabotConfig(grouped), /groups:/);

  const ignored = source.replace(
    '    open-pull-requests-limit: 1\n',
    '    open-pull-requests-limit: 1\n    ignore:\n      - dependency-name: com.google.gms:google-services\n',
  );
  assert.notEqual(ignored, source);
  assert.throws(() => assertDependabotConfig(ignored), /ignore:/);

  const autoMerged = source.replace(
    '    open-pull-requests-limit: 1\n',
    '    open-pull-requests-limit: 1\n    auto-merge: true\n',
  );
  assert.notEqual(autoMerged, source);
  assert.throws(() => assertDependabotConfig(autoMerged), /auto-merge/);
});

test('the native label workflow is a pull_request opened/reopened/synchronize source contract that gates actor and title in the job if and never shells the title', async () => {
  assertNativeLabelWorkflow(await readTracked(WORKFLOW_PATH));
});

test('actor, actor-bypass, outer-bypass, title, arbitrary-env title-injection and trigger mutations fail the workflow contract', async () => {
  const workflow = await readTracked(WORKFLOW_PATH);

  const noActor = workflow.replace(`${ACTOR_GATE}\n      && (`, '(');
  assert.notEqual(noActor, workflow);
  assert.throws(
    () => assertNativeLabelWorkflow(noActor),
    /dependabot\[bot\] actor gate|canonical|job if/,
  );

  const actorBypass = workflow.replace(ACTOR_GATE, `${ACTOR_GATE} || true`);
  assert.notEqual(actorBypass, workflow);
  assert.equal(actorBypass.includes(ACTOR_GATE), true);
  assert.throws(
    () => assertNativeLabelWorkflow(actorBypass),
    /dependabot\[bot\] actor gate|mandatory conjunct|canonical|job if/,
  );

  const noOfficial = workflow.replace(CAPACITOR_TITLE_GATE, 'contains(github.event.pull_request.title, "@other/")');
  const noCommunity = workflow.replace(COMMUNITY_TITLE_GATE, 'false');
  assert.notEqual(noOfficial, workflow);
  assert.notEqual(noCommunity, workflow);
  assert.throws(() => assertNativeLabelWorkflow(noOfficial), /@capacitor\/ title gate/);
  assert.throws(() => assertNativeLabelWorkflow(noCommunity), /@capacitor-community\/ title gate/);

  const titled = workflow.replace(
    'PR_NUMBER: ${{ github.event.pull_request.number }}',
    'PR_NUMBER: ${{ github.event.pull_request.number }}\n          PR_TITLE: ${{ github.event.pull_request.title }}',
  );
  assert.notEqual(titled, workflow);
  assert.throws(() => assertNativeLabelWorkflow(titled), /PR_TITLE|github\.event\.pull_request\.title|job-if/);

  const arbitraryEnv = workflow
    .replace(
      'PR_NUMBER: ${{ github.event.pull_request.number }}',
      'PR_NUMBER: ${{ github.event.pull_request.number }}\n          UNSAFE: ${{ github.event.pull_request.title }}',
    )
    .replace(
      'gh pr edit "$PR_NUMBER" \\\n',
      'eval "$UNSAFE"\n          gh pr edit "$PR_NUMBER" \\\n',
    );
  assert.notEqual(arbitraryEnv, workflow);
  assert.match(arbitraryEnv, /UNSAFE: \$\{\{ github\.event\.pull_request\.title \}\}/);
  assert.match(arbitraryEnv, /eval "\$UNSAFE"/);
  assert.throws(
    () => assertNativeLabelWorkflow(arbitraryEnv),
    /github\.event\.pull_request\.title|job-if|constant gh pr edit/,
  );

  const closedOnly = workflow.replace(
    'types: [opened, reopened, synchronize]',
    'types: [closed]',
  );
  assert.notEqual(closedOnly, workflow);
  assert.throws(
    () => assertNativeLabelWorkflow(closedOnly),
    /opened, reopened, synchronize|pull_request trigger/,
  );

  const outerBypass = workflow.replace(
    '      )\n    runs-on:',
    '      ) || true\n    runs-on:',
  );
  assert.notEqual(outerBypass, workflow);
  assert.equal(outerBypass.includes(ACTOR_CONJUNCT), true);
  assert.throws(
    () => assertNativeLabelWorkflow(outerBypass),
    /job if|canonical predicate|entire condition/,
  );
});

test('the durable policy keeps issue #74 open for a complete Dependabot cycle and tells Actions SHA re-attestation from native migration and the Capacitor label transition', async () => {
  const policy = await readTracked(POLICY_PATH);
  const nativeDevelopment = await readTracked(NATIVE_DEVELOPMENT_PATH);
  const labels = headingBlock(policy, '## Labels');
  const purpose = headingBlock(policy, '## Purpose');

  assert.match(policy, /^problem_type: operating-policy$/m);
  assert.match(headingBlock(policy, '## GitHub Actions re-attestation'), /one workflow identity at a time/);
  assert.match(headingBlock(policy, '## Android, Gradle and Capacitor re-attestation'), /verification-metadata\.xml/);
  assert.match(headingBlock(policy, '## Android, Gradle and Capacitor re-attestation'), /full merge-tier Android gate/);
  assert.match(headingBlock(policy, '## Compatibility failures'), /not describe it as merely "red by design"/);
  assert.match(headingBlock(policy, '## Google Services'), /remove it if unused/);
  assert.match(headingBlock(policy, '## No dependency is ignored forever'), /Do not add `ignore`/);
  assert.match(purpose, /Issue #74 remains open until the complete next\s+Dependabot cycle/);
  assert.match(purpose, /observed to behave as designed/);
  assert.match(purpose, /weekly GitHub\s+Actions and npm/);
  assert.match(purpose, /monthly Gradle/);
  assert.match(purpose, /open-pull-requests-limit: 1/);
  assert.match(purpose, /no `groups`, `ignore` or auto-merge/);
  assert.match(purpose, /`opened`,\s*`reopened` or `synchronize`/);
  assert.match(purpose, /cannot close\s+issue #74/);
  assert.doesNotMatch(purpose, /event or the next Dependabot/);
  assert.doesNotMatch(policy, /Closing this policy document/);
  assert.doesNotMatch(policy, /Closes #74/i);
  assert.doesNotMatch(policy, /Fixes #74/i);
  assert.doesNotMatch(policy, /Resolves #74/i);
  assert.doesNotMatch(policy, /Dependabot cycle has behaved/i);
  assert.match(labels, /title\s+never reaches the shell/);
  assert.match(labels, /opened.*reopened.*synchronize/s);
  assert.match(labels, /Do not backfill\s+the label/);
  assert.doesNotMatch(labels, /Native dependency proposals also carry/);
  for (const migration of ['Gradle wrapper', 'Android Gradle Plugin', 'UIAutomator', 'Google Services']) {
    assert.match(policy, new RegExp(migration));
  }
  assert.match(nativeDevelopment, /docs\/operations\/dependabot-policy\.md/);
  assert.match(nativeDevelopment, /monthly and one-at-a-time/);
  assert.doesNotMatch(
    nativeDevelopment,
    /Dependabot proposals are weekly and manual-review only/,
  );

  const staleWeeklyClaim = `${nativeDevelopment}\nDependabot proposals are weekly and manual-review only.\n`;
  assert.notEqual(staleWeeklyClaim, nativeDevelopment);
  assert.throws(
    () => assert.doesNotMatch(
      staleWeeklyClaim,
      /Dependabot proposals are weekly and manual-review only/,
    ),
    /weekly and manual-review only/,
  );

  const closingDocument = policy.replace(
    'Issue #74 remains open until the complete next',
    'Closing this policy document is not authorised until the complete next',
  );
  assert.notEqual(closingDocument, policy);
  assert.throws(
    () => assert.doesNotMatch(closingDocument, /Closing this policy document/),
    /Closing this policy document/,
  );

  const droppedAutoMerge = policy.replace(
    'and no `groups`, `ignore` or auto-merge',
    'and no `groups` or `ignore`',
  );
  assert.notEqual(droppedAutoMerge, policy);
  assert.throws(
    () => {
      const weakened = headingBlock(droppedAutoMerge, '## Purpose');
      assert.match(weakened, /no `groups`, `ignore` or auto-merge/);
    },
    /groups.*ignore.*auto-merge|auto-merge/,
  );

  const singleEventOrCycle = policy.replace(
    'Issue #74 remains open until the complete next\nDependabot cycle has been observed to behave as designed',
    'Issue #74 remains open until a qualifying post-merge Dependabot `opened`, `reopened` or `synchronize` event or the next Dependabot cycle behaves as designed',
  );
  assert.notEqual(singleEventOrCycle, policy);
  assert.throws(
    () => {
      const weakened = headingBlock(singleEventOrCycle, '## Purpose');
      assert.match(weakened, /Issue #74 remains open until the complete next\s+Dependabot cycle/);
      assert.match(weakened, /cannot close\s+issue #74/);
      assert.doesNotMatch(weakened, /event or the next Dependabot/);
    },
    /complete next Dependabot cycle|cannot close issue #74|event or the next Dependabot/,
  );

  const claimedCycle = `${policy}\nThe Dependabot cycle has behaved as designed. Closes #74.\n`;
  assert.notEqual(claimedCycle, policy);
  assert.throws(
    () => {
      assert.doesNotMatch(claimedCycle, /Closes #74/i);
      assert.doesNotMatch(claimedCycle, /Fixes #74/i);
      assert.doesNotMatch(claimedCycle, /Resolves #74/i);
      assert.doesNotMatch(claimedCycle, /Dependabot cycle has behaved/i);
    },
    /Closes #74|has behaved/i,
  );
});

test('auto-merge commands stay out of repository workflows', async () => {
  const names = await readdir(join(ROOT, '.github/workflows'));
  assert.equal(names.includes('dependabot-native-labels.yml'), true);
  for (const name of names.filter((entry) => entry.endsWith('.yml'))) {
    const workflow = await readTracked(join(ROOT, '.github/workflows', name));
    assert.doesNotMatch(workflow, /gh pr merge/);
    assert.doesNotMatch(workflow, /enable-automerge/);
    assert.doesNotMatch(workflow, /@dependabot merge/);
  }
});
