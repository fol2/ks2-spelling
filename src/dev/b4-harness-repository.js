// In-memory B4 repository for the desktop measurement harness. Kept DOM-free
// so the composition test can drive controller.start() without a browser.
import {
  B4_START_TIMESTAMP,
  commitB4CommandPlan,
  createB4LearnerSnapshot,
} from '../app/b4-round-contract.js';

const wait = (ms) => (ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : null);

export function createB4HarnessRepository({ bridgeMs = 0 } = {}) {
  let snapshot = createB4LearnerSnapshot();

  function commitPlan(plan) {
    snapshot = commitB4CommandPlan(snapshot, plan);
  }

  return Object.freeze({
    repository: Object.freeze({
      async runCommandTransaction(_learnerId, planner) {
        await wait(bridgeMs);
        const plan = planner(structuredClone(snapshot), {
          nowMs: B4_START_TIMESTAMP + snapshot.revision,
        });
        commitPlan(plan);
        return plan;
      },
    }),
    snapshotStore: Object.freeze({
      async read() {
        await wait(bridgeMs);
        return structuredClone(snapshot);
      },
    }),
  });
}
