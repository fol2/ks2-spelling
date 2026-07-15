import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
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
const REPORT_PATH = join(ROOT, 'reports/b2/dependency-audit.json');
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

function classifyB2AndroidDistribution(component) {
  const normalised = {
    ...component,
    scopes: component.scopes.map((scope) => ({
      ...scope,
      configuration: /^(?:debug|release)AnnotationProcessorClasspath$/.test(
        scope.configuration,
      )
        ? scope.configuration.replace('AnnotationProcessor', 'Compile')
        : scope.configuration,
    })),
  };
  return classifyAndroidDistribution(normalised);
}

function mavenComplianceFields(coordinate, distribution, classification, evidenceMode) {
  const sqlCipher = coordinate === 'net.zetetic:sqlcipher-android:4.10.0';
  const b3 = evidenceMode === 'b3';
  return {
    packaged: distribution === 'packaged-runtime',
    privacyRole: sqlCipher
      ? b3
        ? 'Local database implementation in no-encryption mode; final store disclosure review pending'
        : 'Local database implementation; B2 opens it in no-encryption mode'
      : distribution === 'packaged-runtime'
        ? b3
          ? 'B3 compiled dependency closure; no app-configured analytics, advertising or learner payload; vendor runtime data-practice and final Play Data Safety review pending'
          : 'Native application dependency; no collection or transmission declared in B2'
        : 'Build or test only',
    restrictedClassification: classification.scopePolicy,
    exportClassification: sqlCipher
      ? 'unresolved-before-store-release'
      : 'none-identified',
  };
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
  const override = policy.componentOverrides[coordinate];
  if (signatures.length > 1 && !override) {
    throw certificationError(
      'maven_licence_policy_violation',
      `Multiple Maven licence declarations require an exact component override: ${coordinate}`,
    );
  }
  const expression =
    override ??
    [...new Set(classifications.map((classification) => classification.expression))].join(
      ' AND ',
    );
  const restricted = classifications.some(
    ({ scopePolicy }) => scopePolicy === 'tooling-or-test-only',
  );
  const reviewedRuntimeExpression = policy.packagedRuntimeComponents?.[coordinate];
  const reviewedForPackagedRuntime =
    restricted &&
    distribution === 'packaged-runtime' &&
    reviewedRuntimeExpression === expression;
  const expectedRestrictedExpression = policy.scopeRestrictedComponents[coordinate];
  if (
    (restricted && !reviewedForPackagedRuntime && expectedRestrictedExpression !== expression) ||
    (reviewedForPackagedRuntime && expectedRestrictedExpression) ||
    (!restricted && expectedRestrictedExpression) ||
    (restricted && !reviewedForPackagedRuntime && distribution !== 'tooling-or-test-only')
  ) {
    throw certificationError(
      'maven_licence_policy_violation',
      `Maven licence scope or expression requires review: ${coordinate}`,
    );
  }
  return {
    expression,
    scopePolicy: restricted && !reviewedForPackagedRuntime ? 'tooling-or-test-only' : 'any',
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

async function collectPomClosure(
  resolution,
  extraCoordinates = [],
  licenceNameOverrides = {},
) {
  const records = new Map();
  const selected = new Set(resolution.components.map(({ coordinate }) => coordinate));
  async function load(coordinate) {
    if (records.has(coordinate)) return records.get(coordinate);
    const cached = await readCachedMavenPom(GRADLE_USER_HOME, coordinate);
    let evidenceText = cached.text;
    let parsed;
    try {
      parsed = parseMavenPom(evidenceText);
    } catch (error) {
      const override = licenceNameOverrides[coordinate];
      if (
        error.code !== 'maven_licence_unknown' ||
        !override ||
        override.missingField !== 'name' ||
        override.pomSha256 !== cached.sha256 ||
        !cached.text.includes(`<url>${override.url}</url>`)
      ) {
        throw certificationError(
          error.code ?? 'maven_licence_unknown',
          `${coordinate}: ${error.message}`,
        );
      }
      evidenceText = cached.text.replace(
        `<url>${override.url}</url>`,
        `<name>${override.name}</name>\n      <url>${override.url}</url>`,
      );
      parsed = parseMavenPom(evidenceText);
    }
    const record = { coordinate, ...cached, text: evidenceText, parsed };
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
  evidenceMode = 'b2',
} = {}) {
  if (!['b2', 'b3'].includes(evidenceMode)) {
    throw new TypeError('Android certification evidence mode is invalid');
  }
  const [
    resolution,
    dependencyPolicy,
    licencePolicy,
    noticeOverrides,
    verificationXml,
  ] = await Promise.all([
    resolveAndroidDependencies(),
    readJson(join(ROOT, 'config/dependency-policy.json')),
    readJson(join(ROOT, 'config/maven-licence-policy.json')),
    readJson(join(ROOT, 'config/third-party-notices-overrides.json')),
    readFile(VERIFICATION_PATH, 'utf8'),
  ]);
  const rawVerificationInventory = parseVerificationMetadataInventory(verificationXml);
  const b2LicencePolicy = {
    ...licencePolicy,
    classifications: {
      ...licencePolicy.classifications,
      ...noticeOverrides.mavenLicenceClassifications,
    },
    componentOverrides: {
      ...licencePolicy.componentOverrides,
      ...noticeOverrides.mavenComponentLicenceOverrides,
    },
  };
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
    noticeOverrides.mavenPomLicenceNameOverrides,
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
    const distribution = classifyB2AndroidDistribution(component);
    const signatures = effective.licences.map((licence) =>
      mavenLicenceSignature([licence]),
    );
    const classification = applyMavenLicencePolicy({
      coordinate: component.coordinate,
      distribution,
      signatures,
      effective,
      policy: b2LicencePolicy,
    });
    const effectiveSource = sources.get(effective.declaredBy);
    return {
      ...component,
      distribution,
      ...mavenComplianceFields(
        component.coordinate,
        distribution,
        classification,
        evidenceMode,
      ),
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
      policy: b2LicencePolicy,
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
      ...mavenComplianceFields(
        component.coordinate,
        'tooling-or-test-only',
        classification,
        evidenceMode,
      ),
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
  const restrictedExpected = Object.keys(b2LicencePolicy.scopeRestrictedComponents).sort();
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
  const lockfilePaths = [
    'android/gradle/dependency-locks/app.lockfile',
    'android/gradle/dependency-locks/capacitor-android.lockfile',
    'android/gradle/dependency-locks/capacitor-app.lockfile',
    'android/gradle/dependency-locks/capacitor-community-sqlite.lockfile',
    'android/gradle/dependency-locks/capacitor-cordova-android-plugins.lockfile',
  ];
  const inputs = await Promise.all(
    [
      'package.json',
      'scripts/certify-android-dependencies.mjs',
      'scripts/resolve-android-dependencies.mjs',
      'scripts/lib/maven-evidence.mjs',
      'config/dependency-policy.json',
      'config/maven-licence-policy.json',
      'config/third-party-notices-overrides.json',
      'android/gradle/verification-metadata.xml',
      ...lockfilePaths,
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
    lockfiles: inputs.filter(({ path }) => lockfilePaths.includes(path)),
    components,
    taskCreatedBuildTools,
    pomClosure,
    verificationInventory,
    licencePolicyEvidence: {
      owner: licencePolicy.owner,
      reviewDate: licencePolicy.reviewDate,
      scopeRestrictedRationale: licencePolicy.scopeRestrictedRationale,
      androidSdkAcceptance: licencePolicy.androidSdkAcceptance,
      playBillingRedistributionReview: licencePolicy.playBillingRedistributionReview,
      b2NoticeOverrideOwner: noticeOverrides.owner,
      b2NoticeOverrideReviewDate: noticeOverrides.reviewDate,
    },
  };
}

export async function main(args = process.argv.slice(2)) {
  const write = args.includes('--write');
  try {
    if (write) {
      throw certificationError(
        'android_certification_write_forbidden',
        'Task 3 audits Task 2 locks without rewriting them; use audit:dependencies --write',
      );
    }
    const appBuild = await readFile(join(ROOT, 'android/app/build.gradle'), 'utf8');
    const b3BillingActive = /com\.android\.billingclient:billing:9\.1\.0/.test(appBuild);
    const committed = b3BillingActive ? null : (await readJson(REPORT_PATH)).android;
    const certification = await buildAndroidCertification({
      discoverSources: b3BillingActive,
      committed,
      evidenceMode: b3BillingActive ? 'b3' : 'b2',
    });
    if (committed) assertAndroidCertificationCurrent(certification, committed);
    printJson({
      ok: true,
      mode: certification.mode,
      components: certification.componentCount,
      packagedRuntime: certification.packagedRuntimeCount,
      scopeRestrictedTooling: certification.scopeRestrictedToolingCount,
      evidence: b3BillingActive ? 'live-locked-policy' : 'current',
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
