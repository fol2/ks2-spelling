import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const NOTICE_RELATIVE = 'docs/legal/privacy-notice.md';
const KIDS_RELATIVE = 'docs/compliance/kids-category-position.md';
const PARENT_DATA_RELATIVE = 'docs/operations/parent-data-and-backup.md';
const HELP_PRIVACY_RELATIVE = 'site/public/privacy.html';

const STALE_CLAIMS = Object.freeze([
  'no learner data leaves the device',
  'used only to provide the application on that device',
  'no analytics or remote learner-profile store',
]);

async function readUtf8(relative) {
  return readFile(join(ROOT, relative), 'utf8');
}

test('privacy notice, kids-category position and parent-data source reject the stale local-only learner claims', async () => {
  const [notice, kids, parentData, hosted] = await Promise.all([
    readUtf8(NOTICE_RELATIVE),
    readUtf8(KIDS_RELATIVE),
    readUtf8(PARENT_DATA_RELATIVE),
    readUtf8(HELP_PRIVACY_RELATIVE),
  ]);

  for (const claim of STALE_CLAIMS) {
    const pattern = new RegExp(claim.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'));
    assert.doesNotMatch(notice, pattern, `privacy notice source must not reintroduce: ${claim}`);
    assert.doesNotMatch(kids, pattern, `kids-category position source must not reintroduce: ${claim}`);
    assert.doesNotMatch(parentData, pattern, `parent-data source must not reintroduce: ${claim}`);
    assert.doesNotMatch(hosted, pattern, `hosted privacy page source must not reintroduce: ${claim}`);
  }

  for (const text of [notice, kids, parentData]) {
    assert.match(text, /collect(?:s| and retain)|retain nothing/i);
    assert.match(text, /private iCloud|CloudKit private/i);
    assert.match(text, /cannot read/i);
    assert.match(text, /Selected learner/);
    assert.match(text, /Parent PIN/);
  }

  assert.match(notice, /may leave the device into the family's private iCloud/);
  assert.match(notice, /does not delete iCloud copies/);
  assert.match(parentData, /publisher-operated/);
  assert.match(kids, /superseded/);
});
