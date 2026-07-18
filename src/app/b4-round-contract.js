import {
  applySpellingCommand,
  loadStarterSpellingCatalogue,
  validateSpellingCommandSnapshotV1,
} from '../domain/spelling/index.js';
import audioAuthority from '../../config/b4-audio-authority.json' with { type: 'json' };

export const B4_PRODUCT_IDENTIFIER = 'b4-starter-product';
export const B4_SEED = 42;
export const B4_START_TIMESTAMP = 1_768_478_400_000;
export const B4_RUNTIME_ITEM_IDS = Object.freeze([
  'ks2-core:answer',
  'ks2-core:appear',
  'ks2-core:arrive',
  'ks2-core:bicycle',
  'ks2-core:build',
]);

export const B4_START_COMMAND = Object.freeze({
  type: 'start-session',
  payload: Object.freeze({
    mode: 'smart',
    yearFilter: 'core',
    length: 5,
    practiceOnly: false,
    words: B4_RUNTIME_ITEM_IDS,
  }),
});

function submit(typed) {
  return Object.freeze({
    type: 'submit-answer',
    payload: Object.freeze({ typed }),
  });
}

const CONTINUE_COMMAND = Object.freeze({
  type: 'continue-session',
  payload: Object.freeze({}),
});

export const B4_COMMAND_TRACE = Object.freeze([
  B4_START_COMMAND,
  submit('arrive'), CONTINUE_COMMAND,
  submit('answer'), CONTINUE_COMMAND,
  submit('arrive'), CONTINUE_COMMAND,
  submit('appear'), CONTINUE_COMMAND,
  submit('bicycle'), CONTINUE_COMMAND,
  submit('appear'), CONTINUE_COMMAND,
  submit('build'), CONTINUE_COMMAND,
  submit('bicycle'), CONTINUE_COMMAND,
  submit('build'), CONTINUE_COMMAND,
  submit('answer'), CONTINUE_COMMAND,
]);

export const B4_RANDOM_DRAWS_BEFORE_COMMAND = Object.freeze([
  0, 11, 13, 24, 26, 28, 29, 40, 42, 53, 55,
  57, 58, 69, 71, 73, 74, 76, 77, 79, 80,
]);

export const B4_SENTENCE_PROMPTS = Object.freeze([
  Object.freeze({ runtimeItemId: 'ks2-core:arrive', sentence: 'The parcel should arrive tomorrow.' }),
  Object.freeze({ runtimeItemId: 'ks2-core:answer', sentence: 'The answer matched the question exactly.' }),
  Object.freeze({ runtimeItemId: 'ks2-core:arrive', sentence: 'We will arrive before lunch.' }),
  Object.freeze({ runtimeItemId: 'ks2-core:appear', sentence: 'A smile started to appear on her face.' }),
  Object.freeze({ runtimeItemId: 'ks2-core:bicycle', sentence: 'I fixed the tyre on my bicycle.' }),
  Object.freeze({ runtimeItemId: 'ks2-core:appear', sentence: 'The chalk marks appear after we draw.' }),
  Object.freeze({ runtimeItemId: 'ks2-core:build', sentence: 'The school will build a small library.' }),
  Object.freeze({ runtimeItemId: 'ks2-core:bicycle', sentence: 'He parked his bicycle outside the shop.' }),
  Object.freeze({ runtimeItemId: 'ks2-core:build', sentence: 'Engineers build strong roads for lorries.' }),
  Object.freeze({ runtimeItemId: 'ks2-core:answer', sentence: 'I checked the answer with my partner.' }),
]);

export const B4_SUMMARY = Object.freeze({
  mode: 'smart',
  label: 'Smart review',
  message: 'Excellent. Every selected word was correct without needing a correction step.',
  cards: Object.freeze([
    Object.freeze({ label: 'Words in round', value: 5, sub: 'Unique words selected' }),
    Object.freeze({ label: 'Clean first attempts', value: 5, sub: 'Strong on the first go' }),
    Object.freeze({ label: 'Needed correction', value: 0, sub: 'These words came back again' }),
    Object.freeze({ label: 'Prompts heard', value: 10, sub: 'Includes repeats of weak words' }),
  ]),
  elapsedMs: 20,
  totalWords: 5,
  correct: 5,
  accuracy: 100,
  heroContext: null,
  sessionId: 'sess-1768478400000-99e1ef7c',
  mistakes: Object.freeze([]),
});

function freezeContract(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeContract(child);
    Object.freeze(value);
  }
  return value;
}

export const B4_AUDIO_AUTHORITY = freezeContract(audioAuthority);

export function randomFrom(seed = B4_SEED) {
  let value = seed >>> 0;
  return () => {
    value += 0x6D2B79F5;
    let result = Math.imul(value ^ (value >>> 15), 1 | value);
    result ^= result + Math.imul(result ^ (result >>> 7), 61 | result);
    return ((result ^ (result >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function initialSnapshot(catalogue) {
  return validateSpellingCommandSnapshotV1({
    schemaVersion: 1,
    learnerId: 'learner-a',
    revision: 0,
    packId: 'ks2-core',
    catalogueId: 'ks2-core:starter',
    grantedEntitlementIds: [],
    subjectState: {
      ui: {},
      data: {
        prefs: { autoSpeak: false },
        progress: {},
        guardianMap: {},
        pattern: { wobblingByRuntimeItemId: {} },
        postMega: null,
        achievements: {},
        persistenceWarning: null,
      },
    },
    practiceSession: null,
    eventLog: [],
    monsterStateByRewardTrackId: {},
    campStateByPackId: {},
  }, catalogue);
}

function committedSnapshot(snapshot, plan, catalogue) {
  return validateSpellingCommandSnapshotV1({
    ...structuredClone(snapshot),
    revision: plan.nextRevision,
    subjectState: structuredClone(plan.nextSubjectState),
    practiceSession: structuredClone(plan.nextPracticeSession),
    eventLog: structuredClone(plan.nextEventLog),
    monsterStateByRewardTrackId: structuredClone(plan.nextMonsterStateByRewardTrackId),
    campStateByPackId: structuredClone(plan.nextCampStateByPackId),
  }, catalogue);
}

export function characteriseB4Round({ randomFrom: createRandom = randomFrom } = {}) {
  const catalogue = loadStarterSpellingCatalogue();
  const random = createRandom(B4_SEED);
  let snapshot = initialSnapshot(catalogue);
  const commands = [];
  const sentencePrompts = [];
  while (snapshot.subjectState.ui.phase !== 'summary') {
    const ui = snapshot.subjectState.ui;
    let command = B4_START_COMMAND;
    if (commands.length > 0 && ui.awaitingAdvance === true) {
      command = CONTINUE_COMMAND;
    } else if (commands.length > 0) {
      const runtimeItemId = ui.session?.currentRuntimeItemId;
      const item = catalogue.items.find(
        (candidate) => candidate.runtimeItemId === runtimeItemId,
      );
      if (!item) throw new Error('b4_round_current_item_missing');
      command = submit(item.target);
    }
    if (commands.length >= B4_COMMAND_TRACE.length) {
      throw new Error('b4_round_did_not_reach_summary');
    }
    const plan = applySpellingCommand({
      snapshot,
      command,
      contentSnapshot: catalogue,
      now: () => B4_START_TIMESTAMP + commands.length,
      random,
    });
    commands.push(structuredClone(command));
    const prompt = plan.nextSubjectState.ui.session?.currentPrompt;
    if (prompt?.sentence) {
      const candidate = {
        runtimeItemId: prompt.runtimeItemId,
        sentence: prompt.sentence,
      };
      const previous = sentencePrompts.at(-1);
      if (!previous || previous.sentence !== candidate.sentence) {
        sentencePrompts.push(candidate);
      }
    }
    snapshot = committedSnapshot(snapshot, plan, catalogue);
  }
  return Object.freeze({
    commandTrace: commands,
    sentencePrompts,
    summary: structuredClone(snapshot.subjectState.ui.summary),
  });
}

function audioAsset({ runtimeItemId, sentence = null, kind, input, sequence }) {
  const lengthScale = kind === 'dictation-slow' ? 1.35 : 1;
  return Object.freeze({
    assetId: `b4-${String(sequence).padStart(2, '0')}`,
    runtimeItemId,
    sentence,
    kind,
    path: `audio/b4/b4-${String(sequence).padStart(2, '0')}.wav`,
    input,
    generationSpec: Object.freeze({
      engine: B4_AUDIO_AUTHORITY.engine,
      engineVersion: B4_AUDIO_AUTHORITY.engineVersion,
      voice: B4_AUDIO_AUTHORITY.voice,
      modelSha256: B4_AUDIO_AUTHORITY.modelSha256,
      configSha256: B4_AUDIO_AUTHORITY.configSha256,
      noiseScale: 0,
      noiseWScale: 0,
      lengthScale,
      outputFormat: B4_AUDIO_AUTHORITY.outputFormat,
    }),
  });
}

export function createB4AudioInventory() {
  const catalogue = loadStarterSpellingCatalogue();
  const assets = [];
  for (const runtimeItemId of B4_RUNTIME_ITEM_IDS) {
    const item = catalogue.items.find((candidate) => candidate.runtimeItemId === runtimeItemId);
    assets.push(audioAsset({
      runtimeItemId,
      kind: 'word-natural',
      input: `${item.target}.`,
      sequence: assets.length + 1,
    }));
  }
  for (const prompt of B4_SENTENCE_PROMPTS) {
    for (const kind of ['dictation-normal', 'dictation-slow']) {
      const input = kind === 'dictation-slow' &&
        prompt.sentence === 'We will arrive before lunch.'
        ? 'We will... arrive before lunch.'
        : prompt.sentence;
      assets.push(audioAsset({
        ...prompt,
        kind,
        input,
        sequence: assets.length + 1,
      }));
    }
  }
  return Object.freeze(assets);
}

export function validateB4AudioManifest(value) {
  const expected = createB4AudioInventory();
  const rootKeys = [
    'schemaVersion', 'productIdentifier', 'authority', 'authoritySha256',
    'traceSha256', 'assetCount', 'assets',
  ];
  const assetKeys = [
    'assetId', 'runtimeItemId', 'sentence', 'kind', 'path', 'byteSize',
    'input', 'inputSha256', 'generationSpecSha256', 'generationSpec', 'assetSha256',
  ];
  const complete = value?.schemaVersion === 1 &&
    Object.keys(value).sort().join('|') === [...rootKeys].sort().join('|') &&
    value.productIdentifier === B4_PRODUCT_IDENTIFIER &&
    JSON.stringify(value.authority) === JSON.stringify(B4_AUDIO_AUTHORITY) &&
    /^[a-f0-9]{64}$/u.test(value.authoritySha256) &&
    /^[a-f0-9]{64}$/u.test(value.traceSha256) &&
    value.assetCount === expected.length &&
    Array.isArray(value.assets) && value.assets.length === expected.length &&
    value.assets.every((asset, index) => {
      const frozen = expected[index];
      return asset && Object.keys(asset).sort().join('|') === [...assetKeys].sort().join('|') &&
        asset.assetId === frozen.assetId &&
        asset.runtimeItemId === frozen.runtimeItemId &&
        asset.sentence === frozen.sentence &&
        asset.kind === frozen.kind &&
        asset.path === frozen.path &&
        asset.input === frozen.input &&
        Number.isSafeInteger(asset.byteSize) && asset.byteSize > 0 &&
        /^[a-f0-9]{64}$/u.test(asset.inputSha256) &&
        /^[a-f0-9]{64}$/u.test(asset.generationSpecSha256) &&
        JSON.stringify(asset.generationSpec) === JSON.stringify(frozen.generationSpec) &&
        /^[a-f0-9]{64}$/u.test(asset.assetSha256);
    });
  if (!complete) {
    const error = new Error('B4 audio source, voice, redistribution authority and hashes must be complete.');
    error.code = 'b4_audio_authority_incomplete';
    throw error;
  }
  return structuredClone(value);
}
