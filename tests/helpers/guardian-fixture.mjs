import {
  loadFullSpellingCatalogue,
  validateSpellingCommandSnapshotV1,
} from '../../src/domain/spelling/index.js';

import { expectedB2Snapshot } from './b2-database-harness.mjs';

export function expectedGuardianSnapshot(learnerId = 'learner-a') {
  const catalogue = loadFullSpellingCatalogue();
  const snapshot = structuredClone(expectedB2Snapshot(learnerId));
  snapshot.catalogueId = catalogue.catalogueId;
  snapshot.grantedEntitlementIds = ['full-ks2'];
  snapshot.subjectState.data.progress = Object.fromEntries(
    catalogue.items.map(({ runtimeItemId }) => [runtimeItemId, { stage: 4 }]),
  );
  snapshot.subjectState.data.guardianMap = {};
  return validateSpellingCommandSnapshotV1(snapshot, catalogue);
}
