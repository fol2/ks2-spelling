import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../', import.meta.url);

test('iOS screenshot target launches the exact installed B3 app without rebuilding it', async () => {
  const [project, scheme, source] = await Promise.all([
    readFile(new URL('ios/App/App.xcodeproj/project.pbxproj', root), 'utf8'),
    readFile(
      new URL('ios/App/App.xcodeproj/xcshareddata/xcschemes/B3ProofUITests.xcscheme', root),
      'utf8',
    ),
    readFile(new URL('ios/App/B3ProofUITests/B3ProofScreenshotTests.swift', root), 'utf8'),
  ]);

  const target = project.match(
    /D31900000000000000000041 \/\* B3ProofUITests \*\/ = \{(?<body>[\s\S]*?)\n\t\t\};/u,
  )?.groups.body;
  assert.ok(target, 'B3ProofUITests target must exist');
  assert.match(target, /productType = "com\.apple\.product-type\.bundle\.ui-testing"/u);
  assert.match(target, /dependencies = \(\s*\);/u);
  assert.doesNotMatch(target, /PBXTargetDependency|504EC3031FED79650016851F/u);

  const targetConfigurations = ['61', '62', '63'].map((suffix) => project.match(
    new RegExp(`D319000000000000000000${suffix} \/\\* [^*]+ \\*\/ = \\{(?<body>[\\s\\S]*?)\\n\\t\\t\\};`, 'u'),
  )?.groups.body);
  assert.equal(targetConfigurations.every(Boolean), true);
  for (const configuration of targetConfigurations) {
    assert.doesNotMatch(configuration, /TEST_HOST|TEST_TARGET_NAME|BUNDLE_LOADER/u);
  }

  assert.match(scheme, /BlueprintIdentifier = "D31900000000000000000041"/u);
  assert.doesNotMatch(scheme, /BlueprintIdentifier = "504EC3031FED79650016851F"/u);
  assert.doesNotMatch(scheme, /BuildableName = "App\.app"/u);
  assert.match(scheme, /buildImplicitDependencies = "NO"/u);
  assert.match(scheme, /buildConfiguration = "B3SandboxProof"/u);

  assert.match(source, /XCUIApplication\(\s*bundleIdentifier: "uk\.eugnel\.ks2spelling"/u);
  assert.match(source, /XCUIScreen\.main\.screenshot\(\)/u);
  assert.match(source, /attachment\.lifetime = \.keepAlways/u);
});
