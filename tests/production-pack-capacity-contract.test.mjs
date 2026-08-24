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
  assert.match(iosInspector, /maximumCompressedBytes\s*=\s*48 \* 1_024 \* 1_024/);
  assert.match(iosInspector, /maximumExtractedBytes\s*=\s*48 \* 1_024 \* 1_024/);
  assert.match(androidInspector, /MAXIMUM_FILE_COUNT\s*=\s*1_024/);
  assert.match(androidInspector, /MAXIMUM_COMPRESSED_BYTES\s*=\s*48 \* 1_024 \* 1_024/);
  assert.match(androidInspector, /MAXIMUM_EXTRACTED_BYTES\s*=\s*48 \* 1_024 \* 1_024/);
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

  // E2.2: a non-null requiredEntitlementId is a shape-checked identity, not a
  // compiled-in entitlement literal; the registry pairing lives in the app layer.
  assert.match(iosPlugin, /func isApprovedEntitlementIdentity\(_ value: String\) -> Bool/);
  assert.match(
    iosPlugin,
    /:\s*Self\.isApprovedEntitlementIdentity\(manifest\.requiredEntitlementId \?\? ""\)/,
  );
  assert.doesNotMatch(iosPlugin, /"full-ks2"/);
  assert.match(
    androidPlugin,
    /ENTITLEMENT_IDENTITY\s*=[\s\S]{0,40}Pattern\.compile\("\^\[a-z0-9\]\+\(\?:-\[a-z0-9\]\+\)\*\$"\)/,
  );
  assert.match(androidPlugin, /:\s*requiredEntitlementId instanceof String/);
  assert.match(
    androidPlugin,
    /ENTITLEMENT_IDENTITY\.matcher\(\(String\) requiredEntitlementId\)\.matches\(\)/,
  );
  assert.doesNotMatch(androidPlugin, /"full-ks2"/);
  assert.match(iosPlugin, /KS2ReleaseChannel[\s\S]*"sandbox", "production"/);
  assert.match(androidPlugin, /BuildConfig\.KS2_RELEASE_CHANNEL/);
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
