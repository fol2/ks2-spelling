import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const RUNBOOK_RELATIVE = 'docs/operations/2026-08-15-submission-day-runbook.md';
const RUNBOOK_PATH = join(ROOT, RUNBOOK_RELATIVE);

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

test('the submission-day runbook is tracked and forbids a second ExportOptions.plist', async () => {
  execFileSync('git', ['ls-files', '--error-unmatch', '--', RUNBOOK_RELATIVE], { cwd: ROOT });
  const runbook = await readFile(RUNBOOK_PATH, 'utf8');
  const trackedPlists = execFileSync('git', ['ls-files', '*ExportOptions.plist'], {
    cwd: ROOT,
    encoding: 'utf8',
  }).trim();

  assert.equal(trackedPlists, '', 'a tracked ExportOptions.plist recreates the 14 August defect');
  assert.match(runbook, /Do not track a second\s+`ExportOptions\.plist`/);
  assert.match(runbook, /Identity of a build is the pairing\s+of the store's `uploadedDate` against the local archive's mtime/);
  assert.match(runbook, /scripts\/testflight-upload\.sh/);
});

test('the submission-day go/no-go table treats backup removal as a hard stop and the iCloud replica as not', async () => {
  const runbook = await readFile(RUNBOOK_PATH, 'utf8');
  const hardStopRows = tableDataRows(headingBlock(runbook, '### Hard stops'));
  const backupRow = hardStopRows.find((row) => row[0] === 'Learning backup gone from the RC');
  const notHardStop = headingBlock(runbook, '### Not a hard stop');

  assert.ok(backupRow, 'hard-stop table must include the backup-removal gate');
  assert.match(backupRow[1], /https:\/\/github\.com\/fol2\/ks2-spelling\/issues\/198/);
  assert.match(backupRow[1], /https:\/\/github\.com\/fol2\/ks2-spelling\/issues\/187/);
  assert.equal(
    hardStopRows.some((row) => row.join(' ').includes('issues/199')),
    false,
  );

  assert.match(
    notHardStop,
    /^- \[#199\]\(https:\/\/github\.com\/fol2\/ks2-spelling\/issues\/199\)/m,
  );
  assert.doesNotMatch(notHardStop, /issues\/198/);
  assert.doesNotMatch(notHardStop, /issues\/187/);
  assert.doesNotMatch(runbook, /notes adapt/i);
});
