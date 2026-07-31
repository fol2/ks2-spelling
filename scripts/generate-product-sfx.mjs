/**
 * Deterministic offline generator for product SFX WAV assets and provenance.
 * Pure Node — no dependencies, no network.
 *
 * Usage: node scripts/generate-product-sfx.mjs
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  PRODUCT_SFX_NAMES,
  buildProductSfxProvenance,
  renderProductSfxBytes,
} from './lib/product-sfx-synthesis.mjs';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const sfxDir = join(repoRoot, 'public', 'sfx');
const provenancePath = join(repoRoot, 'provenance', 'product-sfx.json');

async function main() {
  const rendered = renderProductSfxBytes();
  const provenance = buildProductSfxProvenance(rendered);

  await mkdir(sfxDir, { recursive: true });

  for (const name of PRODUCT_SFX_NAMES) {
    await writeFile(join(sfxDir, `${name}.wav`), rendered.files[name]);
  }

  const provenanceJson = `${JSON.stringify(provenance, null, 2)}\n`;
  await writeFile(provenancePath, provenanceJson);

  const lines = PRODUCT_SFX_NAMES.map((name) => {
    const record = provenance.files.find((entry) => entry.name === name);
    return `  ${name}: ${record.byteSize} bytes  sha256=${record.sha256}`;
  });

  process.stdout.write(
    [
      `Generated ${PRODUCT_SFX_NAMES.length} product SFX files (${provenance.totalBytes} bytes total).`,
      ...lines,
      `Provenance: ${provenancePath}`,
      `synthesisParameterDigest: ${provenance.synthesisParameterDigest}`,
      '',
    ].join('\n'),
  );
}

main().catch((error) => {
  process.stderr.write(`${error?.stack ?? error}\n`);
  process.exitCode = 1;
});
