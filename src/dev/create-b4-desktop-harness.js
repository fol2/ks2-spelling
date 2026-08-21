// Complete desktop B4 harness composition: grafted catalogue, in-memory
// repository and round controller. Kept DOM-free so the composition test
// can drive start() without a browser, and so the live entry cannot rewire
// the commit path independently of that test.
import audioManifest from '../../config/b4-audio-manifest.json' with { type: 'json' };
import { createB4RoundController } from '../app/b4-round-controller.js';
import {
  B4_START_TIMESTAMP,
  commitB4CommandPlan,
  createB4LearnerSnapshot,
  loadB4SpellingCatalogue,
} from '../app/b4-round-contract.js';

const wait = (ms) => (ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : null);

function createMemoryPorts({ bridgeMs }) {
  let snapshot = createB4LearnerSnapshot();

  function commitPlan(plan) {
    snapshot = commitB4CommandPlan(snapshot, plan);
  }

  return {
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
  };
}

export function createB4DesktopHarness({ bridgeMs = 0, playAudio } = {}) {
  const catalogue = loadB4SpellingCatalogue();
  const { repository, snapshotStore } = createMemoryPorts({ bridgeMs });
  const controller = createB4RoundController({
    catalogue,
    repository,
    snapshotStore,
    audioManifest,
    playAudio,
  });
  return Object.freeze({
    controller,
    targetForCurrentCard() {
      const { currentRuntimeItemId } = controller.getState();
      return catalogue.items
        .find(({ runtimeItemId }) => runtimeItemId === currentRuntimeItemId)?.target ?? null;
    },
  });
}
