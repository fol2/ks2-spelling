import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createInMemorySpellingProfileRepository,
  validateSpellingProfileRepository,
} from '../shared/spelling/mobile/a3/index.js';

function profile(learnerId = 'learner-a', overrides = {}) {
  return {
    learnerId,
    nickname: learnerId === 'learner-a' ? 'Ada' : 'Ben',
    yearGroup: learnerId === 'learner-a' ? 'Y3' : 'Y5',
    goal: 10,
    colour: learnerId === 'learner-a' ? '#3366AA' : '#AA6633',
    createdAt: 100,
    updatedAt: 100,
    ...overrides,
  };
}

test('profile repository exposes exactly the narrow plain-object contract', () => {
  const repository = createInMemorySpellingProfileRepository({ profiles: [], now: () => 1 });
  assert.deepEqual(Object.keys(repository), [
    'listProfiles', 'readProfile', 'writeProfile', 'removeProfile',
  ]);
  assert.equal(validateSpellingProfileRepository(repository), repository);

  for (const invalid of [
    null,
    {},
    { listProfiles() {}, readProfile() {}, writeProfile() {}, removeProfile: true },
    { listProfiles() {}, readProfile() {}, writeProfile() {}, removeProfile() {}, readRevision() {} },
    Object.assign(Object.create({ readRevision() {} }), {
      listProfiles() {}, readProfile() {}, writeProfile() {}, removeProfile() {},
    }),
  ]) {
    assert.throws(() => validateSpellingProfileRepository(invalid), /profile|repository|method|plain|unknown/i);
  }

  const nullPrototype = Object.create(null);
  Object.assign(nullPrototype, {
    listProfiles() {}, readProfile() {}, writeProfile() {}, removeProfile() {},
  });
  assert.equal(validateSpellingProfileRepository(nullPrototype), nullPrototype);
});

test('profile repository contract rejects method accessors and hidden methods without invoking them', () => {
  let getterCalls = 0;
  const accessor = {
    listProfiles() {}, readProfile() {}, writeProfile() {}, removeProfile() {},
  };
  Object.defineProperty(accessor, 'readProfile', {
    enumerable: true,
    get() { getterCalls += 1; return () => {}; },
  });
  const hidden = {
    listProfiles() {}, readProfile() {}, writeProfile() {}, removeProfile() {},
  };
  Object.defineProperty(hidden, 'writeProfile', {
    value() {}, enumerable: false,
  });
  assert.throws(() => validateSpellingProfileRepository(accessor), /accessor|descriptor|method|repository/i);
  assert.throws(() => validateSpellingProfileRepository(hidden), /hidden|enumerable|descriptor|repository/i);
  assert.equal(getterCalls, 0);
});

test('seed profiles use exact validated fields, reject duplicates and list deterministically', () => {
  const repository = createInMemorySpellingProfileRepository({
    profiles: [profile('learner-b'), profile('learner-a')],
    now: () => 1,
  });
  assert.deepEqual(repository.listProfiles().map(({ learnerId }) => learnerId), ['learner-a', 'learner-b']);
  assert.deepEqual(Object.keys(repository.readProfile('learner-a')), [
    'learnerId', 'nickname', 'yearGroup', 'goal', 'colour', 'createdAt', 'updatedAt',
  ]);

  assert.throws(() => createInMemorySpellingProfileRepository({
    profiles: [profile(), profile()], now: () => 1,
  }), /duplicate/i);
  for (const mutate of [
    (value) => { value.extra = true; },
    (value) => { value.learnerId = 'Learner A'; },
    (value) => { value.nickname = ''; },
    (value) => { value.nickname = ' Ada '; },
    (value) => { value.yearGroup = 'Y7'; },
    (value) => { value.goal = 0; },
    (value) => { value.goal = 1.5; },
    (value) => { value.colour = 'blue'; },
    (value) => { value.createdAt = -1; },
    (value) => { value.updatedAt = 99; },
  ]) {
    const invalid = profile();
    mutate(invalid);
    assert.throws(
      () => createInMemorySpellingProfileRepository({ profiles: [invalid], now: () => 1 }),
      /profile|learner|nickname|year|goal|colour|timestamp|updated|unknown/i,
    );
  }
});

test('profile validation rejects accessors, hidden fields and symbols before reading dynamic values', () => {
  let getterCalls = 0;
  const accessor = profile();
  Object.defineProperty(accessor, 'nickname', {
    enumerable: true,
    get() { getterCalls += 1; return 'Ada'; },
  });
  const hidden = profile();
  Object.defineProperty(hidden, 'goal', { value: 10, enumerable: false });
  const symbolKeyed = profile();
  symbolKeyed[Symbol('revision')] = 7;

  for (const candidate of [accessor, hidden, symbolKeyed]) {
    assert.throws(
      () => createInMemorySpellingProfileRepository({ profiles: [candidate], now: () => 1 }),
      /profile|accessor|descriptor|hidden|enumerable|unknown/i,
    );
  }
  assert.equal(getterCalls, 0);
});

test('reads and writes are defensive clones while create, update and remove stay deterministic', () => {
  let timestamp = 200;
  const seed = profile();
  const repository = createInMemorySpellingProfileRepository({ profiles: [seed], now: () => timestamp });
  seed.nickname = 'Tampered';

  const firstRead = repository.readProfile('learner-a');
  firstRead.nickname = 'Mutated read';
  assert.equal(repository.readProfile('learner-a').nickname, 'Ada');
  const listed = repository.listProfiles();
  listed[0].nickname = 'Mutated list';
  assert.equal(repository.readProfile('learner-a').nickname, 'Ada');

  const updateInput = profile('learner-a', {
    nickname: 'Ada Updated', createdAt: 0, updatedAt: 0,
  });
  assert.deepEqual(repository.writeProfile(updateInput), profile('learner-a', {
    nickname: 'Ada Updated', createdAt: 100, updatedAt: 200,
  }));
  updateInput.nickname = 'Mutated write';
  assert.equal(repository.readProfile('learner-a').nickname, 'Ada Updated');

  timestamp = 300;
  assert.deepEqual(repository.writeProfile(profile('learner-c', {
    nickname: 'Cleo', yearGroup: 'Y4', colour: '#123ABC', createdAt: 0, updatedAt: 0,
  })), profile('learner-c', {
    nickname: 'Cleo', yearGroup: 'Y4', colour: '#123ABC', createdAt: 300, updatedAt: 300,
  }));
  assert.equal(repository.removeProfile('learner-a'), true);
  assert.equal(repository.readProfile('learner-a'), null);
  assert.equal(repository.removeProfile('learner-a'), false);
});

test('each write samples the required injected clock exactly once and validates it', () => {
  assert.throws(() => createInMemorySpellingProfileRepository({ profiles: [] }), /now|clock/i);
  assert.throws(() => createInMemorySpellingProfileRepository({ profiles: [], now: 1 }), /now|clock/i);

  let samples = 0;
  const repository = createInMemorySpellingProfileRepository({
    profiles: [],
    now() { samples += 1; return samples * 100; },
  });
  assert.equal(samples, 0);
  repository.writeProfile(profile());
  assert.equal(samples, 1);
  repository.writeProfile(profile('learner-a', { nickname: 'Ada Two' }));
  assert.equal(samples, 2);
  repository.removeProfile('learner-a');
  assert.equal(samples, 3);
  repository.removeProfile('learner-a');
  assert.equal(samples, 4);

  for (const value of [NaN, Infinity, -1]) {
    const invalidClock = createInMemorySpellingProfileRepository({ profiles: [], now: () => value });
    assert.throws(() => invalidClock.writeProfile(profile()), /finite|non-negative|timestamp/i);
  }
});

test('rejected profile inputs fail before consuming the write clock', () => {
  let samples = 0;
  const repository = createInMemorySpellingProfileRepository({
    profiles: [], now() { samples += 1; return 100; },
  });
  const invalid = profile();
  invalid.nickname = '';
  assert.throws(() => repository.writeProfile(invalid), /nickname/i);
  assert.throws(() => repository.removeProfile('Learner A'), /learner/i);
  assert.equal(samples, 0);
});

test('profile writes neither observe nor mutate command revisions or ambient time', () => {
  let commandRevision = 7;
  let revisionReads = 0;
  const options = { profiles: [], now: () => 500 };
  Object.defineProperty(options, 'commandRevision', {
    enumerable: false,
    get() { revisionReads += 1; return commandRevision; },
    set(value) { commandRevision = value; },
  });

  const originalDateNow = Date.now;
  Date.now = () => { throw new Error('ambient clock used'); };
  try {
    const repository = createInMemorySpellingProfileRepository(options);
    repository.writeProfile(profile());
    repository.removeProfile('learner-a');
    assert.equal(revisionReads, 0);
    assert.equal(commandRevision, 7);
  } finally {
    Date.now = originalDateNow;
  }
});
