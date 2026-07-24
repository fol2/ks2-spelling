import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = resolve(import.meta.dirname, '..');
const temporary = await mkdtemp(join(tmpdir(), 'ks2-ios-inspector-'));
try {
  const sources = join(temporary, 'Sources');
  const scratch = join(temporary, '.swift-build');
  await mkdir(sources);
  await copyFile(
    join(ROOT, 'ios/App/App/ZipCentralDirectoryInspector.swift'),
    join(sources, 'ZipCentralDirectoryInspector.swift'),
  );
  await copyFile(
    join(ROOT, 'ios/App/App/PackDownloadFlow.swift'),
    join(sources, 'PackDownloadFlow.swift'),
  );
  await copyFile(
    join(ROOT, 'ios/App/App/PackInstallSealer.swift'),
    join(sources, 'PackInstallSealer.swift'),
  );
  await copyFile(
    join(ROOT, 'tests/native/ios/PackInspectorHarness.swift'),
    join(sources, 'PackInspectorHarness.swift'),
  );
  await writeFile(join(temporary, 'Package.swift'), `// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "PackInspectorHarness",
    platforms: [.macOS(.v13)],
    dependencies: [
        .package(url: "https://github.com/weichsel/ZIPFoundation.git", exact: "0.9.20")
    ],
    targets: [
        .executableTarget(
            name: "PackInspectorHarness",
            dependencies: [.product(name: "ZIPFoundation", package: "ZIPFoundation")],
            path: "Sources"
        )
    ]
)
`);
  const compile = spawnSync('swift', [
    'build', '--package-path', temporary, '--scratch-path', scratch,
  ], { cwd: ROOT, encoding: 'utf8', maxBuffer: 50 * 1_024 * 1_024 });
  if (compile.status !== 0) throw new Error(`${compile.stdout}\n${compile.stderr}`);
  const binaryPath = spawnSync('swift', [
    'build', '--package-path', temporary, '--scratch-path', scratch, '--show-bin-path',
  ], { cwd: ROOT, encoding: 'utf8' });
  if (binaryPath.status !== 0) throw new Error(binaryPath.stderr || binaryPath.stdout);
  const executable = join(binaryPath.stdout.trim(), 'PackInspectorHarness');
  const security = spawnSync(executable, ['security'], { encoding: 'utf8' });
  if (security.status !== 0 || !security.stdout.includes('security:pass')) {
    throw new Error(security.stderr || security.stdout || 'security matrix failed');
  }

  const build = spawnSync(process.execPath, [
    'scripts/build-b3-proof-pack.mjs', '--output-directory', temporary,
  ], { cwd: ROOT, encoding: 'utf8' });
  if (build.status !== 0) throw new Error(build.stderr || build.stdout);

  const envelope = join(ROOT, 'tests/fixtures/b3-signed-manifest.json');
  const approved = spawnSync(executable, [
    join(temporary, 'b3-sandbox-proof.zip'), envelope, 'accept',
  ], { encoding: 'utf8' });
  if (approved.status !== 0 || !approved.stdout.includes('accepted:2')) {
    throw new Error(approved.stderr || approved.stdout || 'approved fixture rejected');
  }

  const starterBuild = spawnSync(process.execPath, [
    'scripts/build-starter-pack.mjs',
  ], { cwd: ROOT, encoding: 'utf8' });
  if (starterBuild.status !== 0) {
    throw new Error(starterBuild.stderr || starterBuild.stdout);
  }
  const starterRoot = join(ROOT, '.native-build/c1/starter-pack');
  const starter = spawnSync(executable, [
    join(starterRoot, 'ks2-core-starter-1.0.0.zip'),
    join(starterRoot, 'unsigned-canonical-manifest.json'),
    'accept-unsigned',
  ], { encoding: 'utf8' });
  if (starter.status !== 0 || !starter.stdout.includes('accepted:841')) {
    throw new Error(starter.stderr || starter.stdout || 'Starter payload rejected');
  }

  const hostile = JSON.parse(await readFile(
    join(ROOT, 'tests/fixtures/b3-hostile-zips/manifest.json'), 'utf8',
  ));
  for (const fixture of hostile.fixtures) {
    const result = spawnSync(executable, [
      join(ROOT, 'tests/fixtures/b3-hostile-zips', fixture.file), envelope, 'reject',
    ], { encoding: 'utf8' });
    if (result.status !== 0 || !result.stdout.includes('rejected')) {
      throw new Error(`${fixture.category}: ${result.stderr || result.stdout}`);
    }
  }
  process.stdout.write(`${JSON.stringify({
    ok: true,
    approvedRuntimeSmoke: true,
    starterPayloadFiles: 841,
    securityMatrix: true,
    hostileFixturesRejected: hostile.fixtures.length,
  })}\n`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
