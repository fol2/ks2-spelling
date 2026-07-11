import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  EXIT_CODES,
  isMain,
  printJson,
  runCommand,
} from './lib/run-command.mjs';
import { resolveAndroidEnvironment } from './test-android.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const RAW_RESOLUTION_PATH = join(
  ROOT,
  '.native-build/android/resolved-components.json',
);
const VERIFICATION_METADATA_PATH = join(
  ROOT,
  'android/gradle/verification-metadata.xml',
);
const SHA256 = /^[a-f0-9]{64}$/;

function resolutionError(message) {
  const error = new Error(message);
  error.code = 'android_resolution_invalid';
  return error;
}

function verificationMetadataError(message) {
  const error = new Error(message);
  error.code = 'android_verification_metadata_invalid';
  return error;
}

function decodeXmlAttribute(value) {
  return value
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');
}

function requireString(value, field) {
  if (typeof value !== 'string' || value.length === 0) {
    throw resolutionError(`Missing Android resolution field: ${field}`);
  }
  return value;
}

function coordinateOf(entry) {
  return [
    requireString(entry.group, 'group'),
    requireString(entry.name, 'name'),
    requireString(entry.version, 'version'),
  ].join(':');
}

function assertUnique(entries, key, label) {
  const keys = entries.map(key);
  if (new Set(keys).size !== keys.length) {
    throw resolutionError(`Duplicate ${label} in Android resolution`);
  }
}

export function canonicaliseGradleResolution(raw) {
  if (raw?.schemaVersion !== 1 || !Array.isArray(raw.components) || !Array.isArray(raw.poms)) {
    throw resolutionError('Unsupported raw Android resolution schema');
  }
  assertUnique(raw.components, coordinateOf, 'component');
  assertUnique(raw.poms, coordinateOf, 'POM');
  const poms = new Map(raw.poms.map((entry) => [coordinateOf(entry), entry]));
  const components = raw.components.map((entry) => {
    const coordinate = coordinateOf(entry);
    const pom = poms.get(coordinate);
    if (!pom || !SHA256.test(pom.sha256)) {
      throw resolutionError(`Missing or invalid Maven POM for ${coordinate}`);
    }
    if (!Array.isArray(entry.scopes) || entry.scopes.length === 0) {
      throw resolutionError(`Missing dependency scope for ${coordinate}`);
    }
    const scopes = entry.scopes.map((scope) => {
      if (typeof scope?.buildscript !== 'boolean') {
        throw resolutionError(`Invalid buildscript scope for ${coordinate}`);
      }
      return {
        project: requireString(scope.project, `${coordinate} project`),
        configuration: requireString(
          scope.configuration,
          `${coordinate} configuration`,
        ),
        buildscript: scope.buildscript,
      };
    });
    assertUnique(
      scopes,
      ({ project, configuration, buildscript }) =>
        `${project}\0${configuration}\0${buildscript}`,
      `${coordinate} scope`,
    );
    const artifacts = (entry.artifacts ?? []).map((artifact) => {
      if (!SHA256.test(artifact?.sha256)) {
        throw resolutionError(`Invalid artefact checksum for ${coordinate}`);
      }
      return {
        name: requireString(artifact.name, `${coordinate} artefact name`),
        sha256: artifact.sha256,
      };
    });
    assertUnique(
      artifacts,
      ({ name, sha256 }) => `${name}\0${sha256}`,
      `${coordinate} artefact`,
    );
    return {
      coordinate,
      group: entry.group,
      name: entry.name,
      version: entry.version,
      scopes: scopes.sort((left, right) =>
        `${left.project}\0${left.configuration}\0${left.buildscript}`.localeCompare(
          `${right.project}\0${right.configuration}\0${right.buildscript}`,
        ),
      ),
      artifacts: artifacts.sort((left, right) =>
        `${left.name}\0${left.sha256}`.localeCompare(`${right.name}\0${right.sha256}`),
      ),
      pom: { sha256: pom.sha256 },
    };
  });
  if (poms.size !== components.length) {
    throw resolutionError('Android resolution contains a POM without a component');
  }
  components.sort((left, right) => left.coordinate.localeCompare(right.coordinate));
  return {
    schemaVersion: 1,
    componentCount: components.length,
    scopeMembershipCount: components.reduce(
      (count, component) => count + component.scopes.length,
      0,
    ),
    components,
  };
}

export function assertVerificationMetadataCoversResolution(resolution, xml) {
  const inventory = parseVerificationMetadataInventory(xml);
  const verified = new Map(
    inventory.components.map(({ coordinate, artifacts }) => [
      coordinate,
      new Map(artifacts.map(({ name, sha256 }) => [name, sha256])),
    ]),
  );
  for (const component of resolution.components) {
    const artifacts = verified.get(component.coordinate);
    if (!artifacts) {
      throw verificationMetadataError(
        `Missing verification component: ${component.coordinate}`,
      );
    }
    const expected = [
      ...component.artifacts,
      { name: `${component.name}-${component.version}.pom`, sha256: component.pom.sha256 },
    ];
    for (const artifact of expected) {
      if (artifacts.get(artifact.name) !== artifact.sha256) {
        throw verificationMetadataError(
          `Verification checksum mismatch: ${component.coordinate}:${artifact.name}`,
        );
      }
    }
  }
  return inventory;
}

function parseExactXmlAttributes(fragment, requiredKeys, optionalKeys = []) {
  const entries = [];
  const pattern = /([A-Za-z_][A-Za-z0-9_.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let cursor = 0;
  for (const match of fragment.matchAll(pattern)) {
    if (fragment.slice(cursor, match.index).trim()) {
      throw verificationMetadataError('Unparsed Gradle verification attribute content');
    }
    const [, name, doubleQuoted, singleQuoted] = match;
    if (entries.some(([existing]) => existing === name)) {
      throw verificationMetadataError(`Duplicate Gradle verification attribute: ${name}`);
    }
    entries.push([name, decodeXmlAttribute(doubleQuoted ?? singleQuoted)]);
    cursor = match.index + match[0].length;
  }
  if (fragment.slice(cursor).trim()) {
    throw verificationMetadataError('Unparsed Gradle verification attribute content');
  }
  const actualKeys = entries.map(([name]) => name).sort();
  const allowedKeys = [...requiredKeys, ...optionalKeys].sort();
  if (
    requiredKeys.some((key) => !actualKeys.includes(key)) ||
    actualKeys.some((key) => !allowedKeys.includes(key))
  ) {
    throw verificationMetadataError('Invalid Gradle verification attributes');
  }
  return Object.fromEntries(entries.sort(([left], [right]) => left.localeCompare(right)));
}

function parseXmlAttributes(fragment) {
  const names = [
    ...fragment.matchAll(/([A-Za-z_][A-Za-z0-9_.:-]*)\s*=/g),
  ].map(([, name]) => name);
  return parseExactXmlAttributes(fragment, names);
}

function parseMetadataPolicyEntries(xml, section, element) {
  const block = xml.match(new RegExp(`<${section}>([\\s\\S]*?)</${section}>`))?.[1] ?? '';
  return [...block.matchAll(new RegExp(`<${element}\\s+([^>]*)/>`, 'g'))]
    .map(([, attributes]) => parseXmlAttributes(attributes))
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

export function parseVerificationMetadataInventory(xml) {
  const verifyMetadata = xml.match(
    /<verify-metadata>\s*(true|false)\s*<\/verify-metadata>/,
  )?.[1];
  const verifySignatures = xml.match(
    /<verify-signatures>\s*(true|false)\s*<\/verify-signatures>/,
  )?.[1];
  if (verifyMetadata !== 'true' || !verifySignatures) {
    throw verificationMetadataError('Gradle verification configuration is incomplete');
  }
  const componentsBlock = xml.match(/<components>([\s\S]*?)<\/components>/)?.[1];
  if (componentsBlock == null) {
    throw verificationMetadataError('Gradle verification components are missing');
  }
  const componentPattern = /<component\s+([^>]*)>([\s\S]*?)<\/component>/g;
  const componentMatches = [...componentsBlock.matchAll(componentPattern)];
  if (componentsBlock.replace(componentPattern, '').trim()) {
    throw verificationMetadataError('Unparsed Gradle verification component content');
  }
  const components = [];
  for (const componentMatch of componentMatches) {
    const componentAttributes = parseExactXmlAttributes(
      componentMatch[1],
      ['group', 'name', 'version'],
    );
    const { group, name: componentName, version } = componentAttributes;
    const coordinate = `${group}:${componentName}:${version}`;
    if (components.some((entry) => entry.coordinate === coordinate)) {
      throw verificationMetadataError(`Duplicate verification component: ${coordinate}`);
    }
    const artifacts = [];
    const artifactPattern = /<artifact\s+([^>]*)>([\s\S]*?)<\/artifact>/g;
    const artifactMatches = [...componentMatch[2].matchAll(artifactPattern)];
    if (componentMatch[2].replace(artifactPattern, '').trim()) {
      throw verificationMetadataError(
        `Unparsed verification artefact content for ${coordinate}`,
      );
    }
    for (const artifactMatch of artifactMatches) {
      const artifactAttributes = parseExactXmlAttributes(artifactMatch[1], ['name']);
      const name = artifactAttributes.name;
      const checksumPattern = /<sha256\s+([^>]*)\/>/g;
      const checksumMatches = [...artifactMatch[2].matchAll(checksumPattern)];
      if (artifactMatch[2].replace(checksumPattern, '').trim()) {
        throw verificationMetadataError(
          `Unparsed verification checksum content for ${coordinate}:${name}`,
        );
      }
      const checksums = checksumMatches.map((match) => {
        const attributes = parseExactXmlAttributes(match[1], ['value'], ['origin']);
        if (!/^[a-f0-9]{64}$/.test(attributes.value ?? '')) {
          throw verificationMetadataError(
            `Invalid verification checksum attributes for ${coordinate}:${name}`,
          );
        }
        return attributes.value;
      });
      if (
        artifacts.some((entry) => entry.name === name) ||
        checksums.length !== 1
      ) {
        throw verificationMetadataError(
          `Invalid verification checksum set for ${coordinate}:${name}`,
        );
      }
      artifacts.push({ name, sha256: checksums[0] });
    }
    components.push({
      coordinate,
      group,
      name: componentName,
      version,
      artifacts: artifacts.sort((left, right) => left.name.localeCompare(right.name)),
    });
  }
  components.sort((left, right) => left.coordinate.localeCompare(right.coordinate));
  return {
    schemaVersion: 1,
    configuration: {
      verifyMetadata: true,
      verifySignatures: verifySignatures === 'true',
      trustedArtifacts: parseMetadataPolicyEntries(
        xml,
        'trusted-artifacts',
        'trust',
      ),
      trustedKeys: parseMetadataPolicyEntries(xml, 'trusted-keys', 'trusted-key'),
      ignoredKeys: parseMetadataPolicyEntries(xml, 'ignored-keys', 'ignored-key'),
    },
    componentCount: components.length,
    artifactCount: components.reduce(
      (count, component) => count + component.artifacts.length,
      0,
    ),
    components,
  };
}

export function assertVerificationMetadataMatchesInventory(xml, expected) {
  const actual = parseVerificationMetadataInventory(xml);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw verificationMetadataError('Gradle verification metadata inventory drifted');
  }
  return actual;
}

export const ANDROID_RESOLUTION_COMMAND = Object.freeze({
  command: 'android/gradlew',
  args: Object.freeze([
    '--no-daemon',
    '--project-dir',
    'android',
    '--project-cache-dir',
    '../.native-build/android/project-cache',
    '--init-script',
    'gradle/b1-dependency-resolution.init.gradle',
    'b1ResolvedDependencies',
  ]),
});

export async function resolveAndroidDependencies({ writeLocksAndMetadata = false } = {}) {
  const resolution = resolveAndroidEnvironment();
  if (!resolution.ready) {
    const error = new Error(`Missing Android toolchain: ${resolution.missing.join(', ')}`);
    error.code = 'missing_android_toolchain';
    throw error;
  }
  const args = [...ANDROID_RESOLUTION_COMMAND.args];
  if (writeLocksAndMetadata) {
    args.push(
      'testDebugUnitTest',
      'assembleDebug',
      '--write-locks',
      '--write-verification-metadata',
      'sha256',
    );
  }
  const result = await runCommand(ANDROID_RESOLUTION_COMMAND.command, args, {
    cwd: ROOT,
    env: {
      ...process.env,
      JAVA_HOME: resolution.javaHome,
      ANDROID_HOME: resolution.androidSdkRoot,
      GRADLE_USER_HOME: join(ROOT, '.native-build/android/gradle-user-home'),
    },
  });
  if (result.exitCode !== 0) {
    const error = new Error(`Gradle dependency resolution failed with ${result.exitCode}`);
    error.code = 'android_resolution_failed';
    throw error;
  }
  const canonical = canonicaliseGradleResolution(
    JSON.parse(await readFile(RAW_RESOLUTION_PATH, 'utf8')),
  );
  assertVerificationMetadataCoversResolution(
    canonical,
    await readFile(VERIFICATION_METADATA_PATH, 'utf8'),
  );
  return canonical;
}

export async function main(args = process.argv.slice(2)) {
  try {
    const resolution = await resolveAndroidDependencies({
      writeLocksAndMetadata: args.includes('--write'),
    });
    printJson({
      ok: true,
      componentCount: resolution.componentCount,
      scopeMembershipCount: resolution.scopeMembershipCount,
      lockAndVerificationWrite: args.includes('--write'),
    });
    return EXIT_CODES.success;
  } catch (error) {
    printJson(
      {
        ok: false,
        code: error.code ?? 'android_resolution_failed',
        message: error.message,
      },
      process.stderr,
    );
    return error.code === 'missing_android_toolchain'
      ? EXIT_CODES.missingTool
      : EXIT_CODES.commandFailed;
  }
}

if (isMain(import.meta.url)) {
  process.exitCode = await main();
}
