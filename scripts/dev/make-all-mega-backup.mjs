/* Dev-only: writes a learning-backup file holding one learner with every
 * full-catalogue word already Mega and the full entitlement granted, so
 * Guardian mode is startable immediately after importing it through
 * Parent → Import on a device or simulator.
 *
 * Usage: node scripts/dev/make-all-mega-backup.mjs [outPath] [nowMs]
 */

import { writeFile } from 'node:fs/promises';

import { loadFullSpellingCatalogue } from '../../src/domain/spelling/index.js';
import {
  createLearningBackupCodec,
} from '../../src/domain/security/learning-backup-contract.js';
import { learnerColour } from '../../src/app/learner-colour.js';
import {
  expectedGuardianSnapshot,
} from '../../tests/helpers/guardian-fixture.mjs';

const LEARNER_ID = 'mega-tester';

async function main() {
  const outPath = process.argv[2] ?? './all-mega-backup.json';
  const nowMs = Number(process.argv[3] ?? Date.now());
  if (!Number.isSafeInteger(nowMs) || nowMs <= 0) {
    throw new Error('nowMs must be a positive safe integer.');
  }

  const catalogue = await loadFullSpellingCatalogue();
  const snapshot = expectedGuardianSnapshot(LEARNER_ID);
  const profile = {
    learnerId: LEARNER_ID,
    nickname: 'Mega',
    yearGroup: 'Y6',
    goal: 10,
    colour: learnerColour('Mega'),
    createdAt: nowMs - 1_000,
    updatedAt: nowMs - 1_000,
  };

  const codec = createLearningBackupCodec({
    cataloguesById: { [catalogue.catalogueId]: catalogue },
  });
  const bytes = codec.encode({
    exportedAt: nowMs,
    selectedLearnerId: LEARNER_ID,
    learners: [{ profile, snapshot }],
  });
  // Round-trip through decode so the written file is proven importable.
  codec.decode(bytes);
  await writeFile(outPath, bytes, 'utf8');

  const megaCount = Object.values(snapshot.subjectState.data.progress)
    .filter(({ stage }) => stage >= 4).length;
  console.log(
    `Wrote ${outPath}: learner ${LEARNER_ID}, ${megaCount}/${catalogue.items.length} ` +
    `words Mega, entitlements ${JSON.stringify(snapshot.grantedEntitlementIds)}.`,
  );
}

main().catch((error) => {
  console.error(error.message ?? error);
  process.exitCode = 1;
});
