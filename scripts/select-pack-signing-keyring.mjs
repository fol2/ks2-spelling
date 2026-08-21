import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import fullKeyring from '../config/pack-signing-public-keys.json' with { type: 'json' };
import productionKeyring from '../config/production/pack-signing-public-keys.json' with { type: 'json' };
import {
  assertPackKeyring,
  assertProductionPackKeyring,
} from '../src/domain/commerce/commerce-contracts.js';

export function selectPackSigningKeyring(releaseChannel) {
  if (releaseChannel === 'production') {
    return assertProductionPackKeyring(productionKeyring);
  }
  if (releaseChannel === 'sandbox') {
    return assertPackKeyring(fullKeyring);
  }
  throw new TypeError('Pack signing keyring release channel is invalid.');
}

export async function writeSelectedPackSigningKeyring(releaseChannel, outputPath) {
  if (typeof outputPath !== 'string' || outputPath.length === 0) {
    throw new TypeError('Pack signing keyring output path is required.');
  }
  const keyring = selectPackSigningKeyring(releaseChannel);
  await writeFile(outputPath, `${JSON.stringify(keyring, null, 2)}\n`);
  return keyring;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await writeSelectedPackSigningKeyring(process.argv[2], process.argv[3]);
}
