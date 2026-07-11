import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  classifyAndroidDistribution,
  mavenLicenceSignature,
  mavenPomRelativePath,
  parseMavenPom,
  readCachedMavenPom,
  resolveEffectiveMavenLicences,
} from './lib/maven-evidence.mjs';
import { EXIT_CODES, isMain, printJson } from './lib/run-command.mjs';
import {
  parseVerificationMetadataInventory,
  resolveAndroidDependencies,
} from './resolve-android-dependencies.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const REPORT_PATH = join(ROOT, 'reports/b1/android-dependency-resolution.json');
const VERIFICATION_PATH = join(ROOT, 'android/gradle/verification-metadata.xml');
const GRADLE_USER_HOME = join(ROOT, '.native-build/android/gradle-user-home');

function certificationError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function applyMavenLicencePolicy({
  coordinate,
  distribution,
  signatures,
  policy,
}) {
  const classifications = signatures.map((signature) => policy.classifications[signature]);
  if (classifications.some((classification) => !classification)) {
    throw certificationError(
      'maven_licence_policy_violation',
      `Unclassified Maven licence declaration: ${coordinate}`,
    );
  }
  const expression =
    policy.componentOverrides[coordinate] ??
    [...new Set(classifications.map((classification) => classification.expression))].join(
      ' AND ',
    );
  const restricted = classifications.some(
    ({ scopePolicy }) => scopePolicy === 'tooling-or-test-only',
  );
  const expectedRestrictedExpression = policy.scopeRestrictedComponents[coordinate];
  if (
    (restricted && expectedRestrictedExpression !== expression) ||
    (!restricted && expectedRestrictedExpression) ||
    (restricted && distribution !== 'tooling-or-test-only')
  ) {
    throw certificationError(
      'maven_licence_policy_violation',
      `Maven licence scope or expression requires review: ${coordinate}`,
    );
  }
  return {
    expression,
    scopePolicy: restricted ? 'tooling-or-test-only' : 'any',
  };
}

export function assertAndroidCertificationCurrent(actual, committed) {
  if (JSON.stringify(actual) !== JSON.stringify(committed)) {
    throw certificationError(
      'android_certification_stale',
      'Committed Android dependency certification does not match fresh resolution',
    );
  }
}

async function collectPomClosure(resolution, extraCoordinates = []) {
  const records = new Map();
  const selected = new Set(resolution.components.map(({ coordinate }) => coordinate));
  async function load(coordinate) {
    if (records.has(coordinate)) return records.get(coordinate);
    const cached = await readCachedMavenPom(GRADLE_USER_HOME, coordinate);
    const parsed = parseMavenPom(cached.text);
    const record = { coordinate, ...cached, parsed };
    records.set(coordinate, record);
    if (!parsed.licences.length) {
      if (!parsed.parentCoordinate || parsed.parentCoordinate.includes('${')) {
        throw certificationError(
          'maven_licence_policy_violation',
          `No exact Maven licence parent for ${coordinate}`,
        );
      }
      await load(parsed.parentCoordinate);
    }
    return record;
  }
  for (const coordinate of [...selected, ...extraCoordinates]) await load(coordinate);
  return { records, selected };
}

async function discoverPomSource(record, repositoryBases) {
  const relativePath = mavenPomRelativePath(record.coordinate);
  const failures = [];
  for (const repository of repositoryBases) {
    const sourceUrl = `${repository}${relativePath}`;
    try {
      const response = await fetch(sourceUrl, {
        redirect: 'follow',
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) {
        failures.push(`${response.status}:${repository}`);
        continue;
      }
      const content = Buffer.from(await response.arrayBuffer());
      if (sha256(content) !== record.sha256) {
        failures.push(`sha256:${repository}`);
        continue;
      }
      return { repository, sourceUrl };
    } catch (error) {
      failures.push(`${error.name}:${repository}`);
    }
  }
  throw certificationError(
    'maven_source_unresolved',
    `No approved Maven source matched ${record.coordinate}: ${failures.join(', ')}`,
  );
}

async function discoverPomSources(records, repositoryBases) {
  const entries = [...records.values()];
  const sources = new Map();
  let index = 0;
  async function worker() {
    while (index < entries.length) {
      const record = entries[index];
      index += 1;
      sources.set(
        record.coordinate,
        await discoverPomSource(record, repositoryBases),
      );
    }
  }
  await Promise.all(Array.from({ length: Math.min(16, entries.length) }, worker));
  return sources;
}

function sourcesFromCommitted(committed, records, repositoryBases) {
  const allowed = new Set(repositoryBases);
  const sources = new Map();
  const closure = new Map(
    committed.pomClosure.map((entry) => [entry.coordinate, entry]),
  );
  for (const record of records.values()) {
    const evidence = closure.get(record.coordinate);
    if (
      !evidence ||
      evidence.sha256 !== record.sha256 ||
      !allowed.has(evidence.repository) ||
      evidence.sourceUrl !==
        `${evidence.repository}${mavenPomRelativePath(record.coordinate)}`
    ) {
      throw certificationError(
        'android_certification_stale',
        `Committed Maven POM source drifted: ${record.coordinate}`,
      );
    }
    sources.set(record.coordinate, {
      repository: evidence.repository,
      sourceUrl: evidence.sourceUrl,
    });
  }
  if (sources.size !== closure.size) {
    throw certificationError(
      'android_certification_stale',
      'Committed Maven POM closure contains an unexplained entry',
    );
  }
  return sources;
}

function annotateVerificationInventory(
  inventory,
  selected,
  pomClosure,
  taskCreatedBuildTools,
) {
  const closureCoordinates = new Set(pomClosure.map(({ coordinate }) => coordinate));
  const taskCreatedCoordinates = new Set(
    taskCreatedBuildTools.map(({ coordinate }) => coordinate),
  );
  return {
    ...inventory,
    components: inventory.components.map((component) => {
      let reason;
      if (selected.has(component.coordinate)) reason = 'selected-module';
      else if (taskCreatedCoordinates.has(component.coordinate)) {
        reason = 'task-created-build-tool';
      }
      else if (closureCoordinates.has(component.coordinate)) reason = 'licence-pom-closure';
      else if (
        component.artifacts.every(({ name }) =>
          name.endsWith('.pom') || name.endsWith('.module'),
        )
      ) {
        reason = 'gradle-metadata-selection-closure';
      } else {
        throw certificationError(
          'android_verification_metadata_invalid',
          `Unexplained verification artefact: ${component.coordinate}`,
        );
      }
      return { ...component, reason };
    }),
  };
}

export async function buildAndroidCertification({
  discoverSources = false,
  committed = null,
} = {}) {
  const [resolution, dependencyPolicy, licencePolicy, verificationXml] = await Promise.all([
    resolveAndroidDependencies(),
    readJson(join(ROOT, 'config/dependency-policy.json')),
    readJson(join(ROOT, 'config/maven-licence-policy.json')),
    readFile(VERIFICATION_PATH, 'utf8'),
  ]);
  const rawVerificationInventory = parseVerificationMetadataInventory(verificationXml);
  const selectedCoordinates = new Set(
    resolution.components.map(({ coordinate }) => coordinate),
  );
  const taskCreatedVerificationComponents = rawVerificationInventory.components.filter(
    (component) =>
      !selectedCoordinates.has(component.coordinate) &&
      component.artifacts.some(
        ({ name }) => !name.endsWith('.pom') && !name.endsWith('.module'),
      ),
  );
  const { records, selected } = await collectPomClosure(
    resolution,
    taskCreatedVerificationComponents.map(({ coordinate }) => coordinate),
  );
  const repositoryBases = dependencyPolicy.allowedSources.mavenRepositoryUrls;
  const sources = discoverSources
    ? await discoverPomSources(records, repositoryBases)
    : sourcesFromCommitted(committed, records, repositoryBases);
  const effectiveLicences = new Map(
    (
      await resolveEffectiveMavenLicences(
        [
          ...resolution.components.map(({ coordinate }) => coordinate),
          ...taskCreatedVerificationComponents.map(({ coordinate }) => coordinate),
        ],
        async (coordinate) => {
          const record = records.get(coordinate);
          const source = sources.get(coordinate);
          return record && source
            ? {
                text: record.text,
                sha256: record.sha256,
                sourceUrl: source.sourceUrl,
              }
            : null;
        },
      )
    ).map((entry) => [entry.coordinate, entry]),
  );
  const components = resolution.components.map((component) => {
    const source = sources.get(component.coordinate);
    const effective = effectiveLicences.get(component.coordinate);
    const distribution = classifyAndroidDistribution(component);
    const signatures = effective.licences.map((licence) =>
      mavenLicenceSignature([licence]),
    );
    const classification = applyMavenLicencePolicy({
      coordinate: component.coordinate,
      distribution,
      signatures,
      effective,
      policy: licencePolicy,
    });
    const effectiveSource = sources.get(effective.declaredBy);
    return {
      ...component,
      distribution,
      artifacts: component.artifacts.map((artifact) => ({
        ...artifact,
        sourceUrl: source.sourceUrl.replace(
          `${component.name}-${component.version}.pom`,
          artifact.name,
        ),
      })),
      pom: { ...component.pom, ...source },
      licence: {
        ...classification,
        entrySignatures: signatures,
        rawDeclarations: effective.licences,
        declaredBy: effective.declaredBy,
        inherited: effective.inherited,
        pom: { ...effective.pom, repository: effectiveSource.repository },
      },
    };
  });
  const taskCreatedBuildTools = taskCreatedVerificationComponents.map((component) => {
    const record = records.get(component.coordinate);
    const source = sources.get(component.coordinate);
    const effective = effectiveLicences.get(component.coordinate);
    const signatures = effective.licences.map((licence) =>
      mavenLicenceSignature([licence]),
    );
    const classification = applyMavenLicencePolicy({
      coordinate: component.coordinate,
      distribution: 'tooling-or-test-only',
      signatures,
      effective,
      policy: licencePolicy,
    });
    const effectiveSource = sources.get(effective.declaredBy);
    const pomName = `${component.name}-${component.version}.pom`;
    const verifiedPom = component.artifacts.find(({ name }) => name === pomName);
    if (!verifiedPom || verifiedPom.sha256 !== record.sha256) {
      throw certificationError(
        'android_verification_metadata_invalid',
        `Task-created build tool POM mismatch: ${component.coordinate}`,
      );
    }
    return {
      coordinate: component.coordinate,
      group: component.group,
      name: component.name,
      version: component.version,
      distribution: 'tooling-or-test-only',
      scope: 'task-created-build-tool',
      artifacts: component.artifacts
        .filter(({ name }) => name !== pomName && !name.endsWith('.module'))
        .map((artifact) => ({
          ...artifact,
          sourceUrl: source.sourceUrl.replace(pomName, artifact.name),
        })),
      pom: { sha256: record.sha256, ...source },
      licence: {
        ...classification,
        entrySignatures: signatures,
        rawDeclarations: effective.licences,
        declaredBy: effective.declaredBy,
        inherited: effective.inherited,
        pom: { ...effective.pom, repository: effectiveSource.repository },
      },
    };
  });
  const restrictedActual = [...components, ...taskCreatedBuildTools]
    .filter(({ licence }) => licence.scopePolicy === 'tooling-or-test-only')
    .map(({ coordinate }) => coordinate)
    .sort();
  const restrictedExpected = Object.keys(licencePolicy.scopeRestrictedComponents).sort();
  if (JSON.stringify(restrictedActual) !== JSON.stringify(restrictedExpected)) {
    throw certificationError(
      'maven_licence_policy_violation',
      'Scope-restricted Maven component set drifted',
    );
  }
  const pomClosure = [...records.values()]
    .map((record) => ({
      coordinate: record.coordinate,
      sha256: record.sha256,
      ...sources.get(record.coordinate),
      selectedModule: selected.has(record.coordinate),
    }))
    .sort((left, right) => left.coordinate.localeCompare(right.coordinate));
  const verificationInventory = annotateVerificationInventory(
    rawVerificationInventory,
    selected,
    pomClosure,
    taskCreatedBuildTools,
  );
  const inputs = await Promise.all(
    [
      'config/dependency-policy.json',
      'config/maven-licence-policy.json',
      'android/gradle/verification-metadata.xml',
      'android/gradle/dependency-locks/app.lockfile',
      'android/gradle/dependency-locks/capacitor-android.lockfile',
      'android/gradle/dependency-locks/capacitor-cordova-android-plugins.lockfile',
    ].map(async (path) => ({
      path,
      sha256: sha256(await readFile(join(ROOT, path))),
    })),
  );
  return {
    schemaVersion: 1,
    mode: 'resolved-toolchain',
    componentCount: resolution.componentCount,
    scopeMembershipCount: resolution.scopeMembershipCount,
    packagedRuntimeCount: components.filter(
      ({ distribution }) => distribution === 'packaged-runtime',
    ).length,
    scopeRestrictedToolingCount: restrictedActual.length,
    taskCreatedBuildToolCount: taskCreatedBuildTools.length,
    generatedFrom: inputs,
    components,
    taskCreatedBuildTools,
    pomClosure,
    verificationInventory,
    licencePolicyEvidence: {
      owner: licencePolicy.owner,
      reviewDate: licencePolicy.reviewDate,
      scopeRestrictedRationale: licencePolicy.scopeRestrictedRationale,
      androidSdkAcceptance: licencePolicy.androidSdkAcceptance,
    },
  };
}

export async function main(args = process.argv.slice(2)) {
  const write = args.includes('--write');
  try {
    const committed = write ? null : await readJson(REPORT_PATH);
    const certification = await buildAndroidCertification({
      discoverSources: write,
      committed,
    });
    if (write) {
      await writeFile(REPORT_PATH, `${JSON.stringify(certification, null, 2)}\n`, 'utf8');
    } else {
      assertAndroidCertificationCurrent(certification, committed);
    }
    printJson({
      ok: true,
      mode: certification.mode,
      components: certification.componentCount,
      packagedRuntime: certification.packagedRuntimeCount,
      scopeRestrictedTooling: certification.scopeRestrictedToolingCount,
      evidence: write ? 'written' : 'current',
    });
    return EXIT_CODES.success;
  } catch (error) {
    printJson(
      {
        ok: false,
        code: error.code ?? 'android_certification_failed',
        message: error.message,
      },
      process.stderr,
    );
    return EXIT_CODES.commandFailed;
  }
}

if (isMain(import.meta.url)) {
  process.exitCode = await main();
}
