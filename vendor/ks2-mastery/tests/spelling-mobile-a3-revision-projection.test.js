import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  applySpellingCommand,
  projectSpellingRevisionMission,
} from '../shared/spelling/mobile/a3/index.js';

const fullCatalogue = JSON.parse(await readFile(
  new URL('../content/spelling.mobile-runtime-full.json', import.meta.url),
  'utf8',
));
const starterCatalogue = JSON.parse(await readFile(
  new URL('../content/spelling.mobile-runtime-starter.json', import.meta.url),
  'utf8',
));

const NOW = 1_768_478_400_000;
const TODAY = Math.floor(NOW / 86_400_000);

function snapshot(catalogue = fullCatalogue, {
  fullMega = false,
  grantedEntitlementIds = catalogue.catalogueId === 'ks2-core:full' ? ['full-ks2'] : [],
  guardianMap = {},
  campState = null,
} = {}) {
  const progress = fullMega
    ? Object.fromEntries(catalogue.items.map((item) => [item.runtimeItemId, {
        legacySlug: item.legacySlug,
        stage: 4,
        attempts: 4,
        correct: 4,
        wrong: 0,
        dueDay: TODAY,
        lastDay: TODAY - 7,
        lastResult: 'correct',
      }]))
    : {};
  return {
    schemaVersion: 1,
    learnerId: 'learner-a',
    revision: 3,
    packId: catalogue.packId,
    catalogueId: catalogue.catalogueId,
    grantedEntitlementIds,
    subjectState: {
      ui: {},
      data: {
        prefs: { autoSpeak: false },
        progress,
        guardianMap,
        pattern: { wobblingByRuntimeItemId: {} },
        postMega: fullMega ? {
          unlockedAt: NOW - 86_400_000,
          unlockedContentReleaseId: 'spelling-r7',
          unlockedPublishedCoreCount: catalogue.items.length,
          unlockedBy: 'all-core-stage-4',
        } : null,
        achievements: {},
        persistenceWarning: null,
      },
    },
    practiceSession: null,
    eventLog: [],
    monsterStateByRewardTrackId: {},
    campStateByPackId: campState ? { 'ks2-core': campState } : {},
  };
}

function guardianRecord({ dueDay = TODAY, wobbling = false } = {}) {
  return {
    legacySlug: 'answer',
    reviewLevel: 2,
    nextDueDay: dueDay,
    lastReviewedDay: TODAY - 1,
    streak: 1,
    lapses: wobbling ? 1 : 0,
    renewals: 1,
    wobbling,
  };
}

function currentCampState(day = TODAY) {
  return {
    packId: 'ks2-core',
    campHighWater: 1,
    lastCreditedGuardianDay: day,
    lastCreditedEventId: 'spelling.guardian.mission-completed:learner-a:credited-session',
    acknowledgements: [],
  };
}

function fullCatalogueWithSecureExtension() {
  const catalogue = structuredClone(fullCatalogue);
  const source = catalogue.items[0];
  catalogue.items.push({
    ...structuredClone(source),
    runtimeItemId: 'ks2-core:extension-example',
    itemId: 'extension-example',
    legacySlug: 'extension-example',
    target: 'extensionexample',
    accepted: ['extensionexample'],
    family: 'extension example',
    familyWords: ['extensionexample'],
    sentencePrompts: [{ sentenceId: 'sentence-1', text: 'The extension example is deliberately outside statutory core.' }],
    patternIds: [],
    coverageTier: 'secure-extension',
  });
  catalogue.audio.requiredAssetCount += 6;
  return catalogue;
}

function apply(current, command, catalogue = fullCatalogue, { random = () => 0.25 } = {}) {
  return applySpellingCommand({
    snapshot: current,
    command,
    contentSnapshot: catalogue,
    now: () => NOW,
    random,
  });
}

function advance(current, plan) {
  return {
    ...current,
    revision: plan.nextRevision,
    subjectState: plan.nextSubjectState,
    practiceSession: plan.nextPracticeSession,
    eventLog: plan.nextEventLog,
    monsterStateByRewardTrackId: plan.nextMonsterStateByRewardTrackId,
    campStateByPackId: plan.nextCampStateByPackId,
  };
}

function assertStrictNoChange(plan, before) {
  assert.equal(plan.changed, false);
  assert.equal(plan.nextRevision, before.revision);
  assert.deepEqual(plan.nextSubjectState, before.subjectState);
  assert.deepEqual(plan.nextPracticeSession, before.practiceSession);
  assert.deepEqual(plan.nextEventLog, before.eventLog);
  assert.deepEqual(plan.nextMonsterStateByRewardTrackId, before.monsterStateByRewardTrackId);
  assert.deepEqual(plan.nextCampStateByPackId, before.campStateByPackId);
  assert.deepEqual(plan.appendedEvents, []);
  assert.deepEqual(plan.transientEffects, []);
}

test('revision projection covers locked, first patrol, wobbling, due and rested without optional patrol', () => {
  const locked = projectSpellingRevisionMission({
    snapshot: snapshot(), contentSnapshot: fullCatalogue, nowMs: NOW,
  });
  assert.deepEqual(locked, {
    missionState: 'locked',
    eligibleMissionKind: null,
    guardianDueCount: 0,
    wobblingDueCount: 0,
    nextGuardianDueDay: null,
    todayGuardianDay: TODAY,
    canStartRewardBearing: false,
    canContinueUnrewarded: false,
    campCreditState: 'available',
  });

  const firstPatrol = projectSpellingRevisionMission({
    snapshot: snapshot(fullCatalogue, { fullMega: true }), contentSnapshot: fullCatalogue, nowMs: NOW,
  });
  assert.equal(firstPatrol.missionState, 'first-patrol');
  assert.equal(firstPatrol.eligibleMissionKind, 'first-patrol');
  assert.equal(firstPatrol.canStartRewardBearing, true);

  const wobblingInput = snapshot(fullCatalogue, {
    fullMega: true,
    guardianMap: { 'ks2-core:answer': guardianRecord({ wobbling: true }) },
  });
  const wobbling = projectSpellingRevisionMission({
    snapshot: wobblingInput, contentSnapshot: fullCatalogue, nowMs: NOW,
  });
  assert.equal(wobbling.missionState, 'wobbling');
  assert.equal(wobbling.guardianDueCount, 1);
  assert.equal(wobbling.wobblingDueCount, 1);

  const dueInput = snapshot(fullCatalogue, {
    fullMega: true,
    guardianMap: { 'ks2-core:answer': guardianRecord() },
  });
  const due = projectSpellingRevisionMission({
    snapshot: dueInput, contentSnapshot: fullCatalogue, nowMs: NOW,
  });
  assert.equal(due.missionState, 'due');
  assert.equal(due.eligibleMissionKind, 'due');
  assert.equal(due.guardianDueCount, 1);

  const restedInput = snapshot(fullCatalogue, {
    fullMega: true,
    guardianMap: { 'ks2-core:answer': guardianRecord({ dueDay: TODAY + 4 }) },
  });
  const rested = projectSpellingRevisionMission({
    snapshot: restedInput, contentSnapshot: fullCatalogue, nowMs: NOW,
  });
  assert.equal(rested.missionState, 'rested');
  assert.equal(rested.eligibleMissionKind, null);
  assert.equal(rested.nextGuardianDueDay, TODAY + 4);
  assert.equal(rested.canStartRewardBearing, false);
});

test('revision and A1 post-Mastery gates ignore valid secure-extension items outside statutory core', () => {
  const catalogue = fullCatalogueWithSecureExtension();
  const current = snapshot(catalogue, { fullMega: true });
  delete current.subjectState.data.progress['ks2-core:extension-example'];

  const projection = projectSpellingRevisionMission({ snapshot: current, contentSnapshot: catalogue, nowMs: NOW });
  assert.equal(projection.missionState, 'first-patrol');
  assert.equal(projection.eligibleMissionKind, 'first-patrol');

  const guardian = apply(current, {
    type: 'start-session', payload: { mode: 'guardian', yearFilter: 'core', length: 5, practiceOnly: false, words: [] },
  }, catalogue);
  assert.equal(guardian.result.state.session.mode, 'guardian');
  assert.ok(!guardian.result.state.session.uniqueItemIds.includes('ks2-core:extension-example'));

  const boss = apply(current, {
    type: 'start-session', payload: { mode: 'boss', yearFilter: 'core', length: 8, practiceOnly: false, words: [] },
  }, catalogue);
  assert.equal(boss.result.state.session.mode, 'boss');
  assert.ok(!boss.result.state.session.uniqueItemIds.includes('ks2-core:extension-example'));
});

test('Starter and missing Full entitlement project unavailable and gate all post-Mastery modes before A1 or random', () => {
  const deniedInputs = [
    [snapshot(starterCatalogue, { fullMega: true }), starterCatalogue],
    [snapshot(fullCatalogue, { fullMega: true, grantedEntitlementIds: [] }), fullCatalogue],
  ];
  for (const [current, catalogue] of deniedInputs) {
    const projection = projectSpellingRevisionMission({ snapshot: current, contentSnapshot: catalogue, nowMs: NOW });
    assert.deepEqual(projection, {
      missionState: 'locked', eligibleMissionKind: null, guardianDueCount: 0, wobblingDueCount: 0,
      nextGuardianDueDay: null, canStartRewardBearing: false, canContinueUnrewarded: false,
      todayGuardianDay: TODAY,
      campCreditState: 'unavailable',
    });
    for (const [mode, patternId] of [['guardian'], ['boss'], ['pattern-quest', 'double-consonant']]) {
      let draws = 0;
      const plan = apply(current, {
        type: 'start-session',
        payload: { mode, yearFilter: 'core', length: 5, practiceOnly: false, words: [], ...(patternId ? { patternId } : {}) },
      }, catalogue, { random: () => { draws += 1; return 0.25; } });
      assertStrictNoChange(plan, current);
      assert.equal(draws, 0);
    }
  }
});

test('Full access reaches existing A1 post-Mastery prerequisites after access admission', () => {
  const notGraduated = snapshot();
  const boss = apply(notGraduated, {
    type: 'start-session', payload: { mode: 'boss', yearFilter: 'core', length: 8, practiceOnly: false, words: [] },
  });
  assert.equal(boss.ok, false);
  assert.equal(boss.changed, true);
  assert.match(boss.result.state.feedback.headline, /unlocks after every core word/i);

  const pattern = apply(notGraduated, {
    type: 'start-session', payload: { mode: 'pattern-quest', yearFilter: 'core', length: 5, practiceOnly: false, words: [], patternId: 'double-consonant' },
  });
  assert.equal(pattern.ok, false);
  assert.equal(pattern.changed, true);
  assert.match(pattern.result.state.feedback.headline, /unlocks after every core word/i);

  const graduated = snapshot(fullCatalogue, { fullMega: true });
  assert.equal(apply(graduated, {
    type: 'start-session', payload: { mode: 'boss', yearFilter: 'core', length: 8, practiceOnly: false, words: [] },
  }).result.state.session.mode, 'boss');
  assert.equal(apply(graduated, {
    type: 'start-session', payload: { mode: 'pattern-quest', yearFilter: 'core', length: 5, practiceOnly: false, words: [], patternId: 'double-consonant' },
  }).result.state.session.mode, 'pattern-quest');
});

test('reward-bearing Guardian start stamps immutable session origin after A1 chooses the session ID', () => {
  const current = snapshot(fullCatalogue, { fullMega: true });
  const plan = apply(current, {
    type: 'start-session',
    payload: { mode: 'guardian', yearFilter: 'core', length: 5, practiceOnly: false, words: [] },
  });
  const session = plan.nextSubjectState.ui.session;
  const expected = {
    sessionId: session.id,
    learnerId: 'learner-a',
    packId: 'ks2-core',
    kind: 'first-patrol',
    startedGuardianDay: TODAY,
    campEligible: true,
  };
  assert.deepEqual(session.revisionMission, expected);
  assert.deepEqual(plan.nextPracticeSession.state.session.revisionMission, expected);
  assert.deepEqual(plan.result.state.session.revisionMission, expected);
  assert.equal(plan.projections.revisionMission.missionState, 'first-patrol');
  assert.equal(plan.projections.revisionMission.canStartRewardBearing, true);
  assert.equal(plan.nextCampStateByPackId['ks2-core'], undefined);

  const active = advance(current, plan);
  const item = fullCatalogue.items.find(({ runtimeItemId }) => runtimeItemId === active.subjectState.ui.session.currentRuntimeItemId);
  const submitted = apply(active, { type: 'submit-answer', payload: { typed: item.target } });
  assert.deepEqual(submitted.nextSubjectState.ui.session.revisionMission, expected);
  assert.deepEqual(submitted.nextPracticeSession.state.session.revisionMission, expected);
});

test('non-Guardian sessions never receive a revision mission stamp', () => {
  const current = snapshot(fullCatalogue, { fullMega: true });
  for (const mode of ['smart', 'boss', 'pattern-quest']) {
    const plan = apply(current, {
      type: 'start-session',
      payload: {
        mode, yearFilter: 'core', length: mode === 'boss' ? 8 : 5, practiceOnly: false, words: [],
        ...(mode === 'pattern-quest' ? { patternId: 'double-consonant' } : {}),
      },
    });
    assert.equal(plan.result.state.session.mode, mode);
    assert.equal(plan.nextSubjectState.ui.session.revisionMission, undefined);
    assert.equal(plan.projections.revisionMission.missionState, 'first-patrol');
  }
});

test('today credit blocks implicit or reward-bearing Guardian replay but admits explicit unrewarded eligible work', () => {
  const current = snapshot(fullCatalogue, {
    fullMega: true,
    guardianMap: { 'ks2-core:answer': guardianRecord() },
    campState: currentCampState(),
  });
  const projection = projectSpellingRevisionMission({ snapshot: current, contentSnapshot: fullCatalogue, nowMs: NOW });
  assert.equal(projection.missionState, 'due');
  assert.equal(projection.campCreditState, 'complete-for-today');
  assert.equal(projection.canStartRewardBearing, false);
  assert.equal(projection.canContinueUnrewarded, true);

  for (const revisionIntent of [undefined, 'reward-bearing']) {
    let draws = 0;
    const plan = apply(current, {
      type: 'start-session',
      payload: {
        mode: 'guardian', yearFilter: 'core', length: 5, practiceOnly: false, words: [],
        ...(revisionIntent ? { revisionIntent } : {}),
      },
    }, fullCatalogue, { random: () => { draws += 1; return 0.25; } });
    assertStrictNoChange(plan, current);
    assert.equal(plan.projections.revisionMission.campCreditState, 'complete-for-today');
    assert.equal(draws, 0);
  }

  const unrewarded = apply(current, {
    type: 'start-session',
    payload: { mode: 'guardian', yearFilter: 'core', length: 5, practiceOnly: false, words: [], revisionIntent: 'unrewarded' },
  });
  assert.equal(unrewarded.changed, true);
  assert.equal(unrewarded.nextSubjectState.ui.session.revisionMission.kind, 'due');
  assert.equal(unrewarded.nextSubjectState.ui.session.revisionMission.campEligible, false);
});

test('locked and rested Guardian starts are strict no-change and consume no random draw', () => {
  const inputs = [
    snapshot(),
    snapshot(fullCatalogue, {
      fullMega: true,
      guardianMap: { 'ks2-core:answer': guardianRecord({ dueDay: TODAY + 2 }) },
    }),
  ];
  for (const current of inputs) {
    let draws = 0;
    const plan = apply(current, {
      type: 'start-session', payload: { mode: 'guardian', yearFilter: 'core', length: 5, practiceOnly: false, words: [] },
    }, fullCatalogue, { random: () => { draws += 1; return 0.25; } });
    assertStrictNoChange(plan, current);
    assert.equal(draws, 0);
  }
});

test('conflicting persisted revision stamps fail closed before random', () => {
  const current = snapshot(fullCatalogue, { fullMega: true });
  const started = apply(current, {
    type: 'start-session', payload: { mode: 'guardian', yearFilter: 'core', length: 5, practiceOnly: false, words: [] },
  });
  const active = advance(current, started);
  active.subjectState.ui.session.revisionMission.packId = 'another-pack';
  active.practiceSession.state.session.revisionMission.packId = 'another-pack';
  let draws = 0;
  assert.throws(() => apply(active, { type: 'continue-session', payload: {} }, fullCatalogue, {
    random: () => { draws += 1; return 0.25; },
  }), /revisionMission.*packId/i);
  assert.equal(draws, 0);
});

test('valid-shaped mission kind and start-day tampering fail integrity before random', () => {
  const current = snapshot(fullCatalogue, { fullMega: true });
  const started = apply(current, {
    type: 'start-session', payload: { mode: 'guardian', yearFilter: 'core', length: 5, practiceOnly: false, words: [] },
  });
  for (const mutate of [
    (mission) => { mission.kind = 'due'; },
    (mission) => { mission.startedGuardianDay += 1; },
  ]) {
    const active = advance(current, started);
    mutate(active.subjectState.ui.session.revisionMission);
    mutate(active.practiceSession.state.session.revisionMission);
    let draws = 0;
    assert.throws(() => apply(active, { type: 'continue-session', payload: {} }, fullCatalogue, {
      random: () => { draws += 1; return 0.25; },
    }), /revision mission.*integrity/i);
    assert.equal(draws, 0);
  }
});

test('explicit unrewarded mission campEligible false-to-true tampering fails integrity before random', () => {
  const current = snapshot(fullCatalogue, {
    fullMega: true,
    guardianMap: { 'ks2-core:answer': guardianRecord() },
    campState: currentCampState(),
  });
  const started = apply(current, {
    type: 'start-session',
    payload: { mode: 'guardian', yearFilter: 'core', length: 5, practiceOnly: false, words: [], revisionIntent: 'unrewarded' },
  });
  assert.equal(started.nextSubjectState.ui.session.revisionMission.campEligible, false);
  const active = advance(current, started);
  active.subjectState.ui.session.revisionMission.campEligible = true;
  active.practiceSession.state.session.revisionMission.campEligible = true;
  let draws = 0;
  assert.throws(() => apply(active, { type: 'continue-session', payload: {} }, fullCatalogue, {
    random: () => { draws += 1; return 0.25; },
  }), /revision mission.*integrity/i);
  assert.equal(draws, 0);
});
