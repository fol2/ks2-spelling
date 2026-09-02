import {
  applySpellingCommand,
  validateSpellingCommandPlanV1,
  validateSpellingCommandSnapshotV1,
} from '../domain/spelling/index.js';
import {
  assignedMonsterBranch,
  companionCanSwitchBranch,
  derivedMonsterStage,
  monsterCatchThreshold,
  monsterIsFound,
  projectMonstersFromWordSecurity,
} from './monster-progress-model.js';

function clone(value) {
  return structuredClone(value);
}

function nonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

export function assignedBranchState(entry) {
  return assignedMonsterBranch(entry);
}

function overlayMonsters(snapshot, catalogue) {
  return projectMonstersFromWordSecurity({
    rewardTracks: catalogue.rewardTracks,
    items: catalogue.items,
    progress: snapshot?.subjectState?.data?.progress ?? {},
    currentState: snapshot?.monsterStateByRewardTrackId ?? {},
  });
}

function durableMonsterEntry({ track, overlay, branch, current }) {
  const secureCount = nonNegativeInteger(overlay?.secureCount);
  const derivedStage = derivedMonsterStage(secureCount, track.thresholds);
  const earnedStageHighWater = Math.max(
    derivedStage,
    nonNegativeInteger(current?.earnedStageHighWater),
  );
  return {
    rewardTrackId: track.rewardTrackId,
    packId: track.packId,
    monsterId: track.monsterId,
    branch,
    secureCount,
    caught: secureCount >= monsterCatchThreshold(track)
      || current?.caught === true
      || earnedStageHighWater > 0,
    derivedStage,
    earnedStageHighWater,
  };
}

/**
 * Gate A still RNG-assigns missing tracks in memory. Product snapshots must
 * not keep those rolls: persist a track only after the child has chosen.
 */
export function holdUnassignedMonsterBranches(plan, snapshot) {
  const previous = snapshot?.monsterStateByRewardTrackId ?? {};
  const next = {};
  for (const [rewardTrackId, entry] of Object.entries(
    plan.nextMonsterStateByRewardTrackId ?? {},
  )) {
    if (assignedBranchState(previous[rewardTrackId])) next[rewardTrackId] = entry;
  }
  const engineIds = Object.keys(plan.nextMonsterStateByRewardTrackId ?? {});
  const keptIds = Object.keys(next);
  if (engineIds.length === keptIds.length) return plan;
  return {
    ...plan,
    nextMonsterStateByRewardTrackId: next,
    projections: {
      ...plan.projections,
      monsters: (plan.projections?.monsters ?? []).filter(
        (entry) => Object.hasOwn(next, entry.rewardTrackId),
      ),
    },
  };
}

export function applyProductSpellingCommand(args) {
  const plan = applySpellingCommand(args);
  const held = holdUnassignedMonsterBranches(plan, args.snapshot);
  if (held === plan) return plan;
  const expectedNowMs = held.appendedEvents[0]?.createdAt
    ?? held.nextPracticeSession?.updatedAt
    ?? held.nextPracticeSession?.startedAt
    ?? args.now();
  return validateSpellingCommandPlanV1(
    held,
    args.contentSnapshot,
    args.snapshot,
    { expectedNowMs },
  );
}

function projectionBaseline(snapshot, catalogue, nowMs) {
  const warning = snapshot.subjectState?.data?.persistenceWarning;
  const acknowledged = warning == null || warning.acknowledged === true;
  const planningSnapshot = acknowledged
    ? snapshot
    : {
      ...snapshot,
      subjectState: {
        ...snapshot.subjectState,
        data: {
          ...snapshot.subjectState.data,
          persistenceWarning: { ...warning, acknowledged: true },
        },
      },
    };
  const baseline = applySpellingCommand({
    snapshot: planningSnapshot,
    command: { type: 'acknowledge-persistence-warning', payload: {} },
    contentSnapshot: catalogue,
    now: () => nowMs,
    random() {
      throw new TypeError('Companion branch choice must not draw randomness.');
    },
  });
  if (baseline.changed) {
    throw new TypeError(
      'Companion branch choice cannot run while a persistence warning is pending.',
    );
  }
  if (acknowledged) return baseline;
  return {
    ...baseline,
    nextSubjectState: clone(snapshot.subjectState),
  };
}

/**
 * Persist one chosen branch on the learner snapshot. Missing tracks stay
 * absent until chosen so Gate A never stores a silent RNG roll.
 */
export function planChooseCompanionBranch({
  snapshot: rawSnapshot,
  catalogue,
  rewardTrackId,
  branch,
  nowMs,
} = {}) {
  if (branch !== 'b1' && branch !== 'b2') {
    throw new TypeError('Companion branch must be b1 or b2.');
  }
  if (typeof rewardTrackId !== 'string' || rewardTrackId.length === 0) {
    throw new TypeError('Companion branch requires a reward track.');
  }
  if (typeof nowMs !== 'number' || !Number.isFinite(nowMs) || nowMs < 0) {
    throw new TypeError('Companion branch choice requires a frozen command clock.');
  }
  const snapshot = validateSpellingCommandSnapshotV1(rawSnapshot, catalogue);
  const track = catalogue.rewardTracks.find(
    (entry) => entry.rewardTrackId === rewardTrackId,
  );
  if (!track) {
    throw new TypeError('Companion branch requires a catalogue reward track.');
  }
  const overlay = overlayMonsters(snapshot, catalogue).find(
    (entry) => entry.rewardTrackId === rewardTrackId,
  );
  if (!overlay || !monsterIsFound(overlay)) {
    throw new TypeError('Companion branch can only be chosen after the egg is found.');
  }
  const current = snapshot.monsterStateByRewardTrackId[rewardTrackId];
  const already = assignedBranchState(current);
  if (already && !companionCanSwitchBranch(overlay)) {
    return projectionBaseline(snapshot, catalogue, nowMs);
  }
  if (already === branch) {
    return projectionBaseline(snapshot, catalogue, nowMs);
  }
  const baseline = projectionBaseline(snapshot, catalogue, nowMs);
  const nextMonsterStateByRewardTrackId = {
    ...clone(snapshot.monsterStateByRewardTrackId),
    [rewardTrackId]: durableMonsterEntry({
      track,
      overlay,
      branch,
      current,
    }),
  };
  return validateSpellingCommandPlanV1({
    ...baseline,
    changed: true,
    nextRevision: snapshot.revision + 1,
    nextMonsterStateByRewardTrackId,
    projections: {
      ...baseline.projections,
      monsters: Object.values(nextMonsterStateByRewardTrackId),
    },
    result: {
      ...baseline.result,
      changed: true,
    },
  }, catalogue, snapshot, { expectedNowMs: nowMs });
}
