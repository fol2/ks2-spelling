import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const ROOT = new URL('../', import.meta.url);

test('native pack inspection keeps per-manifest ceilings inside the reviewed production bounds', async () => {
  const [iosInspector, iosPlugin, androidInspector, androidPlugin] = await Promise.all([
    readFile(new URL('ios/App/App/ZipCentralDirectoryInspector.swift', ROOT), 'utf8'),
    readFile(new URL('ios/App/App/PackTransferPlugin.swift', ROOT), 'utf8'),
    readFile(
      new URL(
        'android/app/src/main/java/uk/eugnel/ks2spelling/ZipCentralDirectoryInspector.java',
        ROOT,
      ),
      'utf8',
    ),
    readFile(
      new URL(
        'android/app/src/main/java/uk/eugnel/ks2spelling/PackTransferPlugin.java',
        ROOT,
      ),
      'utf8',
    ),
  ]);

  assert.match(iosInspector, /maximumFileCount\s*=\s*1_024/);
  assert.match(iosInspector, /maximumCompressedBytes\s*=\s*32 \* 1_024 \* 1_024/);
  assert.match(iosInspector, /maximumExtractedBytes\s*=\s*32 \* 1_024 \* 1_024/);
  assert.match(androidInspector, /MAXIMUM_FILE_COUNT\s*=\s*1_024/);
  assert.match(androidInspector, /MAXIMUM_COMPRESSED_BYTES\s*=\s*32 \* 1_024 \* 1_024/);
  assert.match(androidInspector, /MAXIMUM_EXTRACTED_BYTES\s*=\s*32 \* 1_024 \* 1_024/);
  assert.match(iosInspector, /requiredEntitlementId:\s*String\?/);
  assert.match(iosPlugin, /requiredEntitlementId == nil/);
  assert.match(androidPlugin, /JSONObject\.NULL/);
  assert.match(iosPlugin, /freeStarterPackId\s*=\s*"ks2-core"/);
  assert.match(
    iosPlugin,
    /requiredEntitlementId == nil\s*\?\s*manifest\.packId == Self\.freeStarterPackId/,
  );
  assert.match(androidPlugin, /FREE_STARTER_PACK_ID\s*=\s*"ks2-core"/);
  assert.match(
    androidPlugin,
    /requiredEntitlementId == JSONObject\.NULL\s*\?\s*FREE_STARTER_PACK_ID\.equals\(packId\)/,
  );
  assert.match(iosPlugin, /#if B3_SANDBOX_PROOF[\s\S]*"sandbox"[\s\S]*"production"/);
  assert.match(
    androidPlugin,
    /BuildConfig\.B3_SANDBOX_PROOF\s*\?\s*"sandbox"\s*:\s*"production"/,
  );
  assert.match(iosPlugin, /allowedEnvironments\.contains\(Self\.packEnvironment\)/);
  assert.match(androidPlugin, /allowedEnvironments[\s\S]*contains\(PACK_ENVIRONMENT\)/);

  assert.ok(
    iosPlugin.indexOf('validateManifestCeilings') < iosPlugin.indexOf('Data(contentsOf: archiveURL'),
    'iOS must reject an oversized signed manifest before reading its archive',
  );
  assert.ok(
    androidPlugin.indexOf('validateManifestCeilings') <
      androidPlugin.indexOf('readRegularFile(archive, verified.archiveBytes)'),
    'Android must reject an oversized signed manifest before reading its archive',
  );
});
