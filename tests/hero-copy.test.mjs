import assert from 'node:assert/strict';
import test from 'node:test';

const { heroWelcomeLine, dueCopy } = await import('../src/app/hero-copy.js');

test('the hero welcome line matches the upstream contract', () => {
  assert.equal(heroWelcomeLine('Amelia'), 'Hi Amelia — ready for a short round?');
  assert.equal(heroWelcomeLine('  Amelia  '), 'Hi Amelia — ready for a short round?');
  // Collapsed rather than rendering an orphan "Hi  — ready for a short round?".
  assert.equal(heroWelcomeLine('   '), '');
  assert.equal(heroWelcomeLine(null), '');
});

test('the due line matches the upstream contract at each count', () => {
  assert.equal(dueCopy(0), 'Nothing due today — explore for fun.');
  assert.equal(dueCopy(1), 'One word due — one careful try.');
  assert.equal(dueCopy(4), '4 due — you can do this.');
  assert.equal(dueCopy(undefined), 'Nothing due today — explore for fun.');
});
