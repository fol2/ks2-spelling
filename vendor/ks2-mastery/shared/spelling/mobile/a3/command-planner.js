import { createSpellingService } from '../../core/index.js';
import {
  createLegacyEngineContentSnapshot,
  fromLegacyEngineSnapshot,
  toLegacyEngineSnapshot,
  validateCatalogueV1,
} from '../index.js';
import {
  SPELLING_COMMAND_PLAN_SCHEMA_VERSION,
  canonicalGuardianDay,
  validateSpellingCommandPlanV1,
  validateSpellingCommandSnapshotV1,
  validateSpellingCommandV1,
} from './command-contracts.js';
import { projectSpellingCampTransition } from './camp-projection.js';
import { projectSpellingMonsters } from './monster-projection.js';
import {
  assertSpellingRevisionMissionIntegrity,
  createSpellingRevisionMissionIntegrity,
  hasFullSpellingRevisionAccess,
  projectSpellingRevisionMission,
} from './revision-projection.js';

const STORAGE_PREFIXES = Object.freeze({
  prefs: 'ks2-platform-v2.spelling-prefs.',
  progress: 'ks2-spell-progress-',
  guardianMap: 'ks2-spell-guardian-',
  postMega: 'ks2-spell-post-mega-',
  pattern: 'ks2-spell-pattern-',
  persistenceWarning: 'ks2-spell-persistence-warning-',
  achievements: 'ks2-spell-achievements-',
});

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function storageKey(field, learnerId) {
  return `${STORAGE_PREFIXES[field]}${learnerId}`;
}

function createEphemeralStorage(learnerId, legacyData) {
  const values = new Map([
    [storageKey('prefs', learnerId), JSON.stringify(legacyData.prefs)],
    [storageKey('progress', learnerId), JSON.stringify(legacyData.progress)],
    [storageKey('guardianMap', learnerId), JSON.stringify(legacyData.guardianMap)],
    [storageKey('postMega', learnerId), JSON.stringify(legacyData.postMega)],
    [storageKey('pattern', learnerId), JSON.stringify(legacyData.pattern)],
    [storageKey('persistenceWarning', learnerId), JSON.stringify(legacyData.persistenceWarning)],
    [storageKey('achievements', learnerId), JSON.stringify(legacyData.achievements)],
  ]);
  return {
    getItem(key) {
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      if (values.has(key)) values.set(key, String(value));
    },
    removeItem(key) {
      if (values.has(key)) values.delete(key);
    },
    read(field, fallback) {
      const raw = values.get(storageKey(field, learnerId));
      if (raw === undefined) return clone(fallback);
      try {
        return JSON.parse(raw);
      } catch {
        return clone(fallback);
      }
    },
  };
}

function createPracticeCapture() {
  let operation = null;
  return {
    repository: {
      syncPracticeSession(learnerId, state) {
        operation = { type: 'sync', learnerId, state: clone(state) };
      },
      abandonPracticeSession(learnerId, state) {
        operation = { type: 'abandon', learnerId, state: clone(state) };
      },
      resetLearner() {
        throw new TypeError('The mobile command planner does not expose learner reset.');
      },
    },
    read() {
      return clone(operation);
    },
  };
}

function legacySubject(snapshot, catalogue) {
  const { ui, data } = snapshot.subjectState;
  const bridge = toLegacyEngineSnapshot({
    ...data,
    session: Object.hasOwn(ui, 'session') ? ui.session : null,
    summary: Object.hasOwn(ui, 'summary') ? ui.summary : null,
    events: [],
  }, catalogue);
  return {
    ui: {
      ...clone(ui),
      ...(Object.hasOwn(ui, 'session') ? { session: bridge.session } : {}),
      ...(Object.hasOwn(ui, 'summary') ? { summary: bridge.summary } : {}),
    },
    data: {
      prefs: clone(data.prefs),
      progress: bridge.progress,
      guardianMap: bridge.guardianMap,
      pattern: bridge.pattern,
      postMega: clone(data.postMega),
      achievements: clone(data.achievements),
      persistenceWarning: clone(data.persistenceWarning),
    },
  };
}

function canonicaliseTransitionState(state, catalogue) {
  const raw = state && typeof state === 'object' && !Array.isArray(state) ? state : {};
  const bridge = fromLegacyEngineSnapshot({
    progress: {},
    guardianMap: {},
    pattern: { wobbling: {} },
    session: Object.hasOwn(raw, 'session') ? raw.session : null,
    summary: Object.hasOwn(raw, 'summary') ? raw.summary : null,
    events: [],
  }, catalogue);
  return {
    ...clone(raw),
    ...(Object.hasOwn(raw, 'session') ? { session: bridge.session } : {}),
    ...(Object.hasOwn(raw, 'summary') ? { summary: bridge.summary } : {}),
  };
}

function canonicaliseEvents(events, catalogue) {
  if (!Array.isArray(events) || events.length === 0) return [];
  return fromLegacyEngineSnapshot({
    progress: {},
    guardianMap: {},
    pattern: { wobbling: {} },
    session: null,
    summary: null,
    events,
  }, catalogue).events;
}

function buildNextData(storage, catalogue) {
  const bridge = fromLegacyEngineSnapshot({
    progress: storage.read('progress', {}),
    guardianMap: storage.read('guardianMap', {}),
    pattern: storage.read('pattern', { wobbling: {} }),
    session: null,
    summary: null,
    events: [],
  }, catalogue);
  return {
    prefs: storage.read('prefs', {}),
    progress: bridge.progress,
    guardianMap: bridge.guardianMap,
    pattern: bridge.pattern,
    postMega: storage.read('postMega', null),
    achievements: storage.read('achievements', {}),
    persistenceWarning: storage.read('persistenceWarning', null),
  };
}

function buildPracticeSession({ previous, operation, nextUi, frozenNowMs }) {
  if (!operation) return clone(previous);
  if (operation.type === 'abandon') {
    if (!previous) return null;
    return {
      ...clone(previous),
      status: 'abandoned',
      state: clone(nextUi),
      summary: null,
      updatedAt: frozenNowMs,
      completedAt: null,
    };
  }
  if (nextUi.phase === 'session' && nextUi.session) {
    const session = nextUi.session;
    return {
      id: session.id,
      learnerId: operation.learnerId,
      subjectId: 'spelling',
      status: 'active',
      mode: session.mode,
      state: clone(nextUi),
      summary: null,
      startedAt: previous?.id === session.id ? previous.startedAt : (session.startedAt ?? frozenNowMs),
      updatedAt: frozenNowMs,
      completedAt: null,
    };
  }
  if (nextUi.phase === 'summary' && nextUi.summary) {
    const id = previous?.id || nextUi.summary.sessionId;
    if (!id) throw new TypeError('A completed Spelling session is missing its session ID.');
    return {
      id,
      learnerId: operation.learnerId,
      subjectId: 'spelling',
      status: 'completed',
      mode: previous?.mode || nextUi.summary.mode,
      state: {
        ...clone(nextUi),
        session: clone(previous?.state?.session ?? null),
      },
      summary: clone(nextUi.summary),
      startedAt: previous?.startedAt ?? frozenNowMs,
      updatedAt: frozenNowMs,
      completedAt: frozenNowMs,
    };
  }
  return null;
}

function campProjectionForSnapshot(snapshot, catalogue, nowMs, revisionMission, {
  creditApplied = 0,
  completedGuardianDay = null,
} = {}) {
  const state = snapshot.campStateByPackId[catalogue.packId] || {
    packId: catalogue.packId,
    campHighWater: 0,
    lastCreditedGuardianDay: null,
    lastCreditedEventId: null,
    acknowledgements: [],
  };
  const todayDay = canonicalGuardianDay(nowMs);
  return {
    ...clone(state),
    creditApplied,
    completedGuardianDay,
    canEarnToday: hasFullSpellingRevisionAccess(snapshot, catalogue)
      && revisionMission.eligibleMissionKind !== null
      && (state.lastCreditedGuardianDay === null || todayDay > state.lastCreditedGuardianDay),
  };
}

function buildUnchangedPlan(snapshot, catalogue, revisionMission = {}, camp = {}, expectedNowMs) {
  return validateSpellingCommandPlanV1({
    schemaVersion: SPELLING_COMMAND_PLAN_SCHEMA_VERSION,
    learnerId: snapshot.learnerId,
    expectedRevision: snapshot.revision,
    nextRevision: snapshot.revision,
    changed: false,
    ok: true,
    nextSubjectState: clone(snapshot.subjectState),
    nextPracticeSession: clone(snapshot.practiceSession),
    nextEventLog: clone(snapshot.eventLog),
    appendedEvents: [],
    nextMonsterStateByRewardTrackId: clone(snapshot.monsterStateByRewardTrackId),
    nextCampStateByPackId: clone(snapshot.campStateByPackId),
    projections: {
      monsters: Object.values(clone(snapshot.monsterStateByRewardTrackId)),
      revisionMission: clone(revisionMission),
      camp: clone(camp),
    },
    transientEffects: [],
    result: { ok: true, changed: false, state: clone(snapshot.subjectState.ui), events: [] },
  }, catalogue, snapshot, { expectedNowMs });
}

function isKnownNoOp(snapshot, command) {
  const ui = snapshot.subjectState.ui;
  if (command.type === 'submit-answer' && ui.phase === 'session' && ui.session && ui.awaitingAdvance === true) return true;
  if (command.type === 'skip-word' && ui.phase === 'session' && ui.session && ui.awaitingAdvance === true) return true;
  if (command.type === 'continue-session' && ui.phase === 'session' && ui.session && ui.awaitingAdvance !== true) return true;
  if (command.type === 'acknowledge-persistence-warning' && (!snapshot.subjectState.data.persistenceWarning || snapshot.subjectState.data.persistenceWarning.acknowledged === true)) return true;
  return false;
}

function commandOptions(payload, catalogue) {
  const byRuntimeId = new Map(catalogue.items.map((item) => [item.runtimeItemId, item.legacySlug]));
  return {
    mode: payload.mode,
    yearFilter: payload.yearFilter,
    length: payload.length,
    practiceOnly: payload.practiceOnly,
    words: payload.words?.map((runtimeItemId) => byRuntimeId.get(runtimeItemId)),
    patternId: payload.patternId,
  };
}

function audioEffects(audio, catalogue) {
  if (!audio) return [];
  const runtimeItemId = audio.word?.runtimeItemId
    || catalogue.items.find((item) => item.legacySlug === audio.word?.slug)?.runtimeItemId
    || null;
  return [{
    type: 'audio-cue',
    payload: {
      runtimeItemId,
      sentence: typeof audio.sentence === 'string' ? audio.sentence : null,
      slow: audio.slow === true,
    },
  }];
}

function dispatch(service, learnerId, currentUi, command, catalogue) {
  switch (command.type) {
    case 'start-session':
      return service.startSession(learnerId, commandOptions(command.payload, catalogue));
    case 'submit-answer':
      return service.submitAnswer(learnerId, currentUi, command.payload.typed);
    case 'continue-session':
      return service.continueSession(learnerId, currentUi);
    case 'skip-word':
      return service.skipWord(learnerId, currentUi);
    case 'end-session':
      return service.endSession(learnerId, currentUi);
    case 'save-prefs': {
      const prefs = service.savePrefs(learnerId, command.payload.prefs);
      return { ok: true, changed: true, state: currentUi, events: [], audio: null, prefs };
    }
    case 'acknowledge-persistence-warning': {
      const result = service.acknowledgePersistenceWarning(learnerId);
      return { ...result, changed: true, state: currentUi, events: [], audio: null };
    }
    default:
      throw new TypeError(`Unsupported Spelling command: ${command.type}.`);
  }
}

function appendEvents(existingEvents, emittedEvents) {
  const byId = new Map(existingEvents.map((event) => [event.id, event]));
  const appendedEvents = [];
  for (const event of emittedEvents) {
    const existing = byId.get(event.id);
    if (existing) {
      if (canonicalJson(existing) !== canonicalJson(event)) throw new TypeError('spelling_event_id_collision');
      continue;
    }
    byId.set(event.id, event);
    appendedEvents.push(event);
  }
  return { appendedEvents, nextEventLog: [...clone(existingEvents), ...clone(appendedEvents)] };
}

export function applySpellingCommand({ snapshot: rawSnapshot, command: rawCommand, contentSnapshot, now, random } = {}) {
  const catalogue = validateCatalogueV1(contentSnapshot);
  const snapshot = validateSpellingCommandSnapshotV1(rawSnapshot, catalogue);
  const command = validateSpellingCommandV1(rawCommand);
  assertSpellingRevisionMissionIntegrity(snapshot);
  if (typeof now !== 'function') throw new TypeError('Spelling command planner requires now().');
  if (typeof random !== 'function') throw new TypeError('Spelling command planner requires random().');
  const frozenNowMs = now();
  if (typeof frozenNowMs !== 'number' || !Number.isFinite(frozenNowMs) || frozenNowMs < 0) {
    throw new TypeError('Spelling command planner now() must return a finite non-negative timestamp.');
  }
  const revisionProjection = projectSpellingRevisionMission({
    snapshot,
    contentSnapshot: catalogue,
    nowMs: frozenNowMs,
  });
  const currentCampProjection = campProjectionForSnapshot(
    snapshot,
    catalogue,
    frozenNowMs,
    revisionProjection,
  );
  if (isKnownNoOp(snapshot, command)) {
    return buildUnchangedPlan(snapshot, catalogue, revisionProjection, currentCampProjection, frozenNowMs);
  }
  const postMasteryMode = command.type === 'start-session'
    && ['guardian', 'boss', 'pattern-quest'].includes(command.payload.mode);
  if (postMasteryMode && !hasFullSpellingRevisionAccess(snapshot, catalogue)) {
    return buildUnchangedPlan(snapshot, catalogue, revisionProjection, currentCampProjection, frozenNowMs);
  }
  let guardianCampEligible = null;
  if (command.type === 'start-session' && command.payload.mode === 'guardian') {
    if (revisionProjection.eligibleMissionKind === null) {
      return buildUnchangedPlan(snapshot, catalogue, revisionProjection, currentCampProjection, frozenNowMs);
    }
    const intent = command.payload.revisionIntent;
    if (intent === 'unrewarded') {
      if (!revisionProjection.canContinueUnrewarded) {
        return buildUnchangedPlan(snapshot, catalogue, revisionProjection, currentCampProjection, frozenNowMs);
      }
      guardianCampEligible = false;
    } else {
      if (!revisionProjection.canStartRewardBearing) {
        return buildUnchangedPlan(snapshot, catalogue, revisionProjection, currentCampProjection, frozenNowMs);
      }
      guardianCampEligible = true;
    }
  }
  const sampledRandomValues = [];
  const randomPort = () => {
    const value = random();
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value >= 1) {
      throw new TypeError('Spelling command planner random() must return a finite value from zero inclusive to one exclusive.');
    }
    sampledRandomValues.push(value);
    return value;
  };

  const legacy = legacySubject(snapshot, catalogue);
  const storage = createEphemeralStorage(snapshot.learnerId, legacy.data);
  const practice = createPracticeCapture();
  const service = createSpellingService({
    repository: { ...practice.repository, storage },
    storage,
    now: () => frozenNowMs,
    random: randomPort,
    audio: { speak() {}, warmup() {} },
    context: { extractSummaryContext: () => null },
    diagnostics: { warn() {} },
    contentSnapshot: createLegacyEngineContentSnapshot(catalogue),
    cloneContentSnapshot: false,
  });
  const transition = dispatch(service, snapshot.learnerId, legacy.ui, command, catalogue);
  const nextUi = canonicaliseTransitionState(transition.state, catalogue);
  if (guardianCampEligible !== null && nextUi.phase === 'session' && nextUi.session) {
    const revisionMission = {
      sessionId: nextUi.session.id,
      learnerId: snapshot.learnerId,
      packId: catalogue.packId,
      kind: revisionProjection.eligibleMissionKind,
      startedGuardianDay: canonicalGuardianDay(frozenNowMs),
      campEligible: guardianCampEligible,
    };
    nextUi.session = {
      ...nextUi.session,
      revisionMission,
      revisionMissionIntegrity: createSpellingRevisionMissionIntegrity({
        session: nextUi.session,
        mission: revisionMission,
        startedAt: nextUi.session.startedAt,
      }),
    };
  }
  const previousRevisionMission = snapshot.practiceSession?.state?.session?.revisionMission;
  const previousRevisionMissionIntegrity = snapshot.practiceSession?.state?.session?.revisionMissionIntegrity;
  if (nextUi.phase === 'session' && nextUi.session && previousRevisionMission
      && nextUi.session.id === previousRevisionMission.sessionId) {
    nextUi.session = {
      ...nextUi.session,
      revisionMission: clone(previousRevisionMission),
      revisionMissionIntegrity: previousRevisionMissionIntegrity,
    };
  }
  if (nextUi.phase === 'summary' && nextUi.summary && !nextUi.summary.sessionId) {
    const completedSessionId = snapshot.practiceSession?.id
      || transition.events?.find((event) => event?.sessionId)?.sessionId;
    if (!completedSessionId) throw new TypeError('A completed Spelling summary is missing its session ID.');
    nextUi.summary = { ...nextUi.summary, sessionId: completedSessionId };
  }
  const transitionResultUi = clone(nextUi);
  const nextData = buildNextData(storage, catalogue);
  const emittedEvents = canonicaliseEvents(transition.events, catalogue).map((event) => {
    if (event.type !== 'spelling.guardian.mission-completed' || !previousRevisionMission) return event;
    if (event.createdAt !== frozenNowMs) {
      throw new TypeError('Guardian completion event timestamp does not match the frozen command clock.');
    }
    return { ...event, packId: catalogue.packId };
  });
  const eventChanges = appendEvents(snapshot.eventLog, emittedEvents);
  const candidateSubjectState = { ui: nextUi, data: nextData };
  const candidatePracticeSession = buildPracticeSession({
    previous: snapshot.practiceSession,
    operation: practice.read(),
    nextUi,
    frozenNowMs,
  });
  const candidateEffects = audioEffects(transition.audio, catalogue);
  const durableChanged = canonicalJson(candidateSubjectState) !== canonicalJson(snapshot.subjectState)
    || canonicalJson(candidatePracticeSession) !== canonicalJson(snapshot.practiceSession)
    || eventChanges.appendedEvents.length > 0;
  const changed = transition.changed !== false && durableChanged;
  const resultState = changed ? transitionResultUi : clone(snapshot.subjectState.ui);
  const resultEvents = changed ? emittedEvents : [];
  const result = {
    ok: transition.ok !== false,
    changed,
    state: resultState,
    events: resultEvents,
  };
  if (Object.hasOwn(transition, 'prefs')) result.prefs = clone(transition.prefs);
  if (Object.hasOwn(transition, 'reason')) result.reason = transition.reason;

  const missingMonsterBranchCount = catalogue.rewardTracks
    .filter(({ rewardTrackId }) => !Object.hasOwn(snapshot.monsterStateByRewardTrackId, rewardTrackId))
    .length;
  const canProjectMonsters = changed
    && (missingMonsterBranchCount === 0 || sampledRandomValues.length >= missingMonsterBranchCount);
  let monsterRandomIndex = 0;
  const monsterRandom = () => {
    if (monsterRandomIndex >= sampledRandomValues.length) {
      throw new TypeError('Monster projection cannot draw fresh entropy after the A1 command.');
    }
    const value = sampledRandomValues[monsterRandomIndex];
    monsterRandomIndex += 1;
    return value;
  };
  // Non-learning commands usually sample no A1 entropy. Defer the whole first projection
  // in that case so a later learning command can initialise every missing branch together.
  const monsterProjection = canProjectMonsters
    ? projectSpellingMonsters({
      learnerId: snapshot.learnerId,
      progress: candidateSubjectState.data.progress,
      rewardTracks: catalogue.rewardTracks,
      items: catalogue.items,
      currentState: snapshot.monsterStateByRewardTrackId,
      random: monsterRandom,
    })
    : Object.values(clone(snapshot.monsterStateByRewardTrackId));
  const nextMonsterStateByRewardTrackId = canProjectMonsters
    ? Object.fromEntries(monsterProjection.map((entry) => [entry.rewardTrackId, entry]))
    : clone(snapshot.monsterStateByRewardTrackId);

  const appendedGuardianCompletion = eventChanges.appendedEvents.find(
    ({ type }) => type === 'spelling.guardian.mission-completed',
  );
  let nextCampStateByPackId = clone(snapshot.campStateByPackId);
  let campTransition = null;
  if (changed && appendedGuardianCompletion && previousRevisionMission) {
    campTransition = projectSpellingCampTransition({
      learnerId: snapshot.learnerId,
      packId: catalogue.packId,
      catalogue,
      grantedEntitlementIds: snapshot.grantedEntitlementIds,
      currentState: snapshot.campStateByPackId[catalogue.packId],
      completedEvent: appendedGuardianCompletion,
      revisionMission: previousRevisionMission,
    });
    if (campTransition.creditApplied === 1) {
      const {
        creditApplied: _creditApplied,
        completedGuardianDay: _completedGuardianDay,
        canEarnToday: _canEarnToday,
        ...durableCampState
      } = campTransition;
      nextCampStateByPackId[catalogue.packId] = durableCampState;
    }
  }

  const candidateProjectionSnapshot = {
    ...snapshot,
    revision: snapshot.revision + (changed ? 1 : 0),
    subjectState: changed ? candidateSubjectState : clone(snapshot.subjectState),
    practiceSession: changed ? candidatePracticeSession : clone(snapshot.practiceSession),
    eventLog: changed ? eventChanges.nextEventLog : clone(snapshot.eventLog),
    monsterStateByRewardTrackId: nextMonsterStateByRewardTrackId,
    campStateByPackId: nextCampStateByPackId,
  };
  const nextRevisionProjection = projectSpellingRevisionMission({
    snapshot: candidateProjectionSnapshot,
    contentSnapshot: catalogue,
    nowMs: frozenNowMs,
  });
  const nextCampProjection = campProjectionForSnapshot(
    candidateProjectionSnapshot,
    catalogue,
    frozenNowMs,
    nextRevisionProjection,
    campTransition || {},
  );

  const plan = {
    schemaVersion: SPELLING_COMMAND_PLAN_SCHEMA_VERSION,
    learnerId: snapshot.learnerId,
    expectedRevision: snapshot.revision,
    nextRevision: snapshot.revision + (changed ? 1 : 0),
    changed,
    ok: transition.ok !== false,
    nextSubjectState: changed ? candidateSubjectState : clone(snapshot.subjectState),
    nextPracticeSession: changed ? candidatePracticeSession : clone(snapshot.practiceSession),
    nextEventLog: changed ? eventChanges.nextEventLog : clone(snapshot.eventLog),
    appendedEvents: changed ? eventChanges.appendedEvents : [],
    nextMonsterStateByRewardTrackId,
    nextCampStateByPackId,
    projections: { monsters: monsterProjection, revisionMission: nextRevisionProjection, camp: nextCampProjection },
    transientEffects: changed ? candidateEffects : [],
    result,
  };
  return validateSpellingCommandPlanV1(plan, catalogue, snapshot, {
    expectedNowMs: frozenNowMs,
  });
}
