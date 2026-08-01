/* Tap-target floor for shared pills and quiet/warning/destructive buttons.
   2.75rem is the 44px floor; the floor is load-bearing for small hands. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (path) => readFile(join(ROOT, path), 'utf8');

function cssBlock(css, selector) {
  const pattern = new RegExp(
    `${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`,
  );
  const match = css.match(pattern);
  assert.ok(match, `expected CSS block for ${selector}`);
  return match[1];
}

test('.pill declares the 44px tap-target floor', async () => {
  const css = await read('src/app/app.css');
  const block = cssBlock(css, '.pill');
  assert.match(block, /min-height:\s*2\.75rem/);
});

test('.bank-filters .pill keeps the compact font and inherits the floor', async () => {
  const css = await read('src/app/app.css');
  const block = cssBlock(css, '.bank-filters .pill');
  assert.doesNotMatch(block, /min-height/);
  assert.match(block, /font-size:\s*0\.75rem/);
});

test('shared button metric block declares the 44px tap-target floor', async () => {
  const css = await read('src/app/app.css');
  const pattern =
    /\.button-quiet,\s*\n\.button-warning,\s*\n\.button-destructive,\s*\n\.button-danger\s*\{([^}]*)\}/;
  const match = css.match(pattern);
  assert.ok(match, 'expected shared button metric block');
  assert.match(match[1], /min-height:\s*2\.75rem/);
});
