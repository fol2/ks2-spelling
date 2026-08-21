import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const RUNBOOK_RELATIVE =
  'docs/operations/2026-08-21-icloud-learning-replica-physical-acceptance-runbook.md';
const SUBMISSION_RELATIVE = 'docs/operations/2026-08-15-submission-day-runbook.md';
const PARENT_DATA_RELATIVE = 'docs/operations/parent-data-and-backup.md';
const CONCEPTS_RELATIVE = 'CONCEPTS.md';
const RECORDS_DIR = 'docs/records';
const EVIDENCE_RECORD_SLUG = 'icloud-learning-replica-physical-acceptance';
const ISSUE_199 = 'https://github.com/fol2/ks2-spelling/issues/199';
const ISSUE_201 = 'https://github.com/fol2/ks2-spelling/issues/201';
const OWNER_SEQUENCING_COMMENT =
  'https://github.com/fol2/ks2-spelling/issues/199#issuecomment-5364970037';

const ACCEPTANCE_CELLS = Object.freeze([
  'Same-iCloud-account two-device convergence',
  'StoreKit entitlement separate from iCloud identity',
  'Never-entitled device receiving Full history stays on Starter and parks preserved-full-learning-v1:{learnerId}',
  'Two devices practise offline concurrently and reconnect without losing a secured word',
  'Relaunch/pull visibility',
  'iCloud sign-out degrades local-only with no child-facing nag',
  'Signed RC contains named-container entitlement',
  'ASC App Privacy Data Not Collected read-back',
]);

const DISTINCTION_LANES = Object.freeze([
  'unsigned Simulator build',
  'signed physical RC',
  'CloudKit container configuration',
  'runtime convergence',
  'ASC label confirmation',
]);

const EVIDENCE_FIELDS = Object.freeze([
  'Status:',
  'git SHA',
  'MARKETING_VERSION',
  'CURRENT_PROJECT_VERSION',
  'archive path',
  'store uploadedDate',
  'ASC build id',
  'scheme KS2Spelling',
  'configuration Release',
  'Device A',
  'Device B',
  'iOS version',
  'same iCloud account',
  'StoreKit entitlement state',
  'named-container entitlement',
  'iCloud.uk.eugnel.ks2spelling',
  'codesign --display --entitlements',
  'ASC App Privacy',
  'Data Not Collected',
  'Remaining gates',
  'does not grant',
]);

function headingBlock(markdown, heading) {
  const match = markdown.match(new RegExp(`^${heading}\\n`, 'm'));
  assert.ok(match, `missing ${heading}`);
  const start = match.index + match[0].length;
  const rest = markdown.slice(start);
  const next = rest.search(/^#{2,3} /m);
  return (next === -1 ? rest : rest.slice(0, next)).trim();
}

function tableDataRows(block) {
  return block
    .split('\n')
    .filter((line) => line.startsWith('| ') && !line.startsWith('| Gate ') && !line.startsWith('|---'))
    .map((line) => line.split('|').slice(1, -1).map((cell) => cell.trim()));
}

async function readUtf8(relative) {
  return readFile(join(ROOT, relative), 'utf8');
}

function assertTracked(relative) {
  execFileSync('git', ['ls-files', '--error-unmatch', '--', relative], { cwd: ROOT });
}

test('the iCloud physical-acceptance runbook source names every required signed-RC cell', async () => {
  assertTracked(RUNBOOK_RELATIVE);
  const runbook = await readUtf8(RUNBOOK_RELATIVE);

  for (const cell of ACCEPTANCE_CELLS) {
    assert.match(
      runbook,
      new RegExp(cell.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')),
      `runbook source must name the acceptance cell: ${cell}`,
    );
  }
  assert.match(runbook, /KS2Spelling/);
  assert.match(runbook, /Release/);
  assert.match(runbook, /owner-gated/);
  assert.doesNotMatch(
    runbook,
    /Status:\s*GREEN/i,
    'the runbook source must not fabricate a GREEN physical-acceptance verdict',
  );
});

test('the iCloud physical-acceptance runbook source distinguishes Simulator, signed RC, container, runtime and ASC lanes', async () => {
  const runbook = await readUtf8(RUNBOOK_RELATIVE);
  for (const lane of DISTINCTION_LANES) {
    assert.match(
      runbook,
      new RegExp(lane.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')),
      `runbook source must name the evidence lane: ${lane}`,
    );
  }
  assert.match(
    runbook,
    /Unsigned Simulator compile is not signed-RC named-container evidence/,
  );
  assert.match(
    runbook,
    /Portal CloudKit container configuration is not runtime convergence/,
  );
  assert.match(
    runbook,
    /Runtime convergence is not an ASC App Privacy label confirmation/,
  );
  assert.match(
    runbook,
    /A signed physical RC is not an unsigned Simulator build/,
  );
});

test('the iCloud physical-acceptance runbook source defines the dated evidence-record fields without a success record', async () => {
  const runbook = await readUtf8(RUNBOOK_RELATIVE);
  assert.match(
    runbook,
    /docs\/records\/<YYYY-MM-DD>-icloud-learning-replica-physical-acceptance\.md/,
  );
  for (const field of EVIDENCE_FIELDS) {
    assert.match(
      runbook,
      new RegExp(field.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')),
      `runbook source must name the evidence field: ${field}`,
    );
  }
  assert.match(runbook, /Do not fabricate or pre-create a success record/);
  assert.match(
    runbook,
    /This document is the checklist, not the walk evidence/,
  );

  const recordFiles = (await readdir(join(ROOT, RECORDS_DIR)))
    .filter((name) => name.includes(EVIDENCE_RECORD_SLUG));
  assert.deepEqual(
    recordFiles,
    [],
    'source control must not ship a fabricated iCloud physical-acceptance success record',
  );
});

test('the submission-day runbook source treats iCloud replica physical/store evidence as a hard stop before #201', async () => {
  assertTracked(SUBMISSION_RELATIVE);
  const runbook = await readUtf8(SUBMISSION_RELATIVE);
  const hardStopRows = tableDataRows(headingBlock(runbook, '### Hard stops'));
  const replicaRow = hardStopRows.find((row) => /iCloud learning replica/i.test(row[0]));
  const backupRow = hardStopRows.find((row) => row[0] === 'Learning backup gone from the RC');
  const notHardStop = headingBlock(runbook, '### Not a hard stop');

  assert.ok(backupRow, 'hard-stop table source must still include the backup-removal gate');
  assert.ok(replicaRow, 'hard-stop table source must include the iCloud replica physical/store gate');
  assert.match(replicaRow[1], new RegExp(ISSUE_199.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')));
  assert.match(replicaRow[1], new RegExp(ISSUE_201.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')));
  assert.match(replicaRow[1], /physical/);
  assert.match(replicaRow[1], /store/);
  assert.match(
    replicaRow[1],
    /2026-08-21-icloud-learning-replica-physical-acceptance-runbook/,
  );
  assert.match(
    replicaRow[1],
    /native runtime already composes the private-CloudKit replica/i,
  );
  assert.match(
    replicaRow[1],
    /unsigned Simulator compile is not this gate/i,
  );
  assert.doesNotMatch(replicaRow[1], /GREEN|passed|complete(?! before)/i);

  assert.equal(
    /issues\/199/.test(notHardStop),
    false,
    'Not a hard stop source must not list #199',
  );
  assert.doesNotMatch(
    runbook,
    /v1 ships neither the backup file nor the replica/,
  );
  assert.doesNotMatch(
    runbook,
    /the replica does not block 1\.0\.0/,
  );
  assert.match(runbook, /#199 complete before #201/);
});

test('CONCEPTS source keeps a timeless replica definition and omits release sequencing', async () => {
  const [concepts, runbook, submission] = await Promise.all([
    readUtf8(CONCEPTS_RELATIVE),
    readUtf8(RUNBOOK_RELATIVE),
    readUtf8(SUBMISSION_RELATIVE),
  ]);

  assert.match(concepts, /### iCloud learning replica/);
  assert.match(concepts, /CloudKit private-database copy of learner profiles and learner snapshots/);
  assert.doesNotMatch(concepts, /It is post-listing, not part of v1/);
  assert.doesNotMatch(concepts, /#199|#201|hard stop|post-listing/i);
  assert.doesNotMatch(
    concepts,
    /Native iOS product composition already starts this replica/,
  );

  assert.match(runbook, new RegExp(OWNER_SEQUENCING_COMMENT.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')));
  assert.match(submission, new RegExp(OWNER_SEQUENCING_COMMENT.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')));
  assert.match(runbook, new RegExp(ISSUE_199.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')));
  assert.match(runbook, new RegExp(ISSUE_201.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')));
});

test('the iCloud physical-acceptance runbook source confines purchase and restore to TestFlight StoreKit Sandbox with no charge', async () => {
  const runbook = await readUtf8(RUNBOOK_RELATIVE);
  assert.match(runbook, /TestFlight StoreKit Sandbox/);
  assert.match(runbook, /no-charge tester/);
  assert.match(runbook, /never-entitled StoreKit account/);
  assert.match(
    runbook,
    /Stop if the sheet or account is production or would charge money/,
  );
  assert.match(
    runbook,
    /A live App Store purchase is out of scope absent fresh owner authority/,
  );
  assert.match(runbook, /paired TestFlight signed RC/);
  assert.doesNotMatch(
    runbook,
    /Physical install is that TestFlight\/App Store build/,
  );
});

test('parent-data source still points at the unrecorded physical-acceptance runbook', async () => {
  const parentData = await readUtf8(PARENT_DATA_RELATIVE);
  assert.match(parentData, /2026-08-21-icloud-learning-replica-physical-acceptance-runbook/);
  assert.match(parentData, /Physical proof is owner-gated and unrecorded/);
  assert.doesNotMatch(parentData, /post-listing/);
});
