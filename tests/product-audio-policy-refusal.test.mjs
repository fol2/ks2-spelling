import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('..', import.meta.url));

function roundPlayCatch(productApp) {
  const playStart = productApp.indexOf('async function play(kind) {');
  const catchStart = productApp.indexOf('    } catch', playStart);
  const catchEnd = productApp.indexOf('    } finally {', catchStart);
  assert.ok(playStart >= 0 && catchStart > playStart && catchEnd > catchStart);
  return productApp.slice(catchStart, catchEnd);
}

test('autoplay policy refusal does not mark the listening pack corrupt', async () => {
  const productApp = await readFile(join(root, 'src/app/ProductApp.jsx'), 'utf8');
  const catchBlock = roundPlayCatch(productApp);

  assert.match(catchBlock, /catch \(error\) \{\s*if \(error\?\.name === 'NotAllowedError'\) \{/u);
  assert.match(
    catchBlock,
    /if \(error\?\.name === 'NotAllowedError'\) \{(?:(?!onPlaybackFailure)[\s\S])*setLocalError\('Tap Hear it again to listen\.'\);(?:(?!onPlaybackFailure)[\s\S])*\} else \{/u,
  );
  assert.match(
    catchBlock,
    /\} else \{\s*setLocalError\('Audio needs attention\. Check the listening pack and try again\.'\);\s*onPlaybackFailure\(\);\s*\}\s*$/u,
  );
});
