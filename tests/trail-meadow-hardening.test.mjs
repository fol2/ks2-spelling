import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';

test('Trail companion interactions expose details without losing the press contract', async () => {
  const source = await readFile(
    resolve(import.meta.dirname, '../src/app/trail/TrailMeadow.jsx'),
    'utf8',
  );
  assert.match(source, /className="trail-companion press-soft press"/u);
  assert.match(source, /aria-expanded=\{poked\}/u);
  assert.match(source, /aria-controls=\{poked \? detailsId : undefined\}/u);
  assert.match(source, /aria-atomic="true"/u);
  assert.match(source, /trail-meadow-hardening\.css/u);
  assert.match(source, /The trail is waiting for its first companion/u);
});

test('foreground depth, Dynamic Type and phone landscape remain usable', async () => {
  const styles = await readFile(
    resolve(import.meta.dirname, '../src/app/trail/trail-meadow-hardening.css'),
    'utf8',
  );
  assert.match(styles, /\.trail-meadow::after\s*\{[^}]*z-index:\s*106;/su);
  assert.match(
    styles,
    /\.trail-companion\[data-poked='true'\],[\s\S]*?z-index:\s*130;/u,
  );
  assert.match(styles, /\.trail-companion-tag\s*\{[^}]*white-space:\s*normal;/su);
  assert.match(
    styles,
    /@media \(max-height:\s*32rem\) and \(orientation:\s*landscape\)/u,
  );
  assert.match(styles, /@media \(prefers-contrast:\s*more\)/u);
});
