import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { basename, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { monsterCelebrationArtUrl } from '../src/app/celebrations/celebration-model.js';
import { stageArtUrl } from '../src/app/monster-stage/monster-stage-model.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const MONSTERS_ROOT = join(ROOT, 'content', 'mastery-art', 'monsters');
const INVENTORY_FILE = /^([^/]+)\/(b\d+)\/\1-\2-(\d+)\.640\.webp$/u;

async function loadInventory() {
  const entries = await readdir(MONSTERS_ROOT, {
    recursive: true,
    withFileTypes: true,
  });

  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => relative(MONSTERS_ROOT, join(entry.parentPath, entry.name)))
    .map((relativePath) => {
      const match = INVENTORY_FILE.exec(relativePath);
      return match
        ? {
          path: relativePath,
          monsterId: match[1],
          branch: match[2],
          stage: Number(match[3]),
        }
        : null;
    })
    .filter(Boolean)
    .sort((left, right) => left.path.localeCompare(right.path));
}

function diskPath(publicPath) {
  assert.match(publicPath, /^\/mastery-art\//u);
  return join(
    ROOT,
    'content',
    'mastery-art',
    publicPath.slice('/mastery-art/'.length),
  );
}

function assertAgreement(resolvers, monsterId, branch, stage) {
  const masteryUrl = resolvers.monsterArt(monsterId, stage, branch);
  const stageUrl = stageArtUrl(monsterId, branch, stage);
  const celebrationUrl = monsterCelebrationArtUrl(monsterId, branch, stage);

  assert.ok(masteryUrl, `monsterArt returned no URL for ${monsterId}/${branch}/${stage}`);
  assert.equal(basename(masteryUrl), basename(stageUrl));
  assert.equal(basename(masteryUrl), basename(celebrationUrl));
  assert.ok(
    existsSync(diskPath(stageUrl)),
    `stageArtUrl points to missing art: ${stageUrl}`,
  );
  assert.ok(
    existsSync(diskPath(celebrationUrl)),
    `monsterCelebrationArtUrl points to missing art: ${celebrationUrl}`,
  );
}

test('all on-disk monster art files agree across the three resolvers', async (t) => {
  const { createServer } = await import('vite');
  const vite = await createServer({
    configFile: join(ROOT, 'vite.config.js'),
    server: { middlewareMode: true },
    appType: 'custom',
  });
  t.after(() => vite.close());

  const { monsterArt } = await vite.ssrLoadModule('/src/app/mastery-art.js');
  const inventory = await loadInventory();

  assert.ok(inventory.length > 0, 'monster art inventory must not be empty');
  for (const { monsterId, branch, stage, path } of inventory) {
    assertAgreement({ monsterArt }, monsterId, branch, stage);
    assert.equal(
      basename(stageArtUrl(monsterId, branch, stage)),
      basename(path),
      `stageArtUrl did not resolve the inventory file: ${path}`,
    );
  }
});

test('edge-case inputs preserve resolver parity and resolve to committed art', async (t) => {
  const { createServer } = await import('vite');
  const vite = await createServer({
    configFile: join(ROOT, 'vite.config.js'),
    server: { middlewareMode: true },
    appType: 'custom',
  });
  t.after(() => vite.close());

  const { monsterArt } = await vite.ssrLoadModule('/src/app/mastery-art.js');
  const inventory = await loadInventory();
  const monsterIds = [...new Set(inventory.map(({ monsterId }) => monsterId))];
  const cases = [
    { branch: 'b1', stage: 9 },
    { branch: 'b2', stage: 9 },
    { branch: 'b9', stage: 2 },
    { branch: null, stage: 2 },
  ];

  for (const monsterId of monsterIds) {
    for (const { branch, stage } of cases) {
      assertAgreement({ monsterArt }, monsterId, branch, stage);
    }
  }
});
