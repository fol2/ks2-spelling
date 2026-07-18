import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readValidatedB3OperatorJson } from './check-b3-external-prerequisites.mjs';
import { assertCleanB3Head } from './prepare-b3-distribution.mjs';
import { fingerprintB3Application } from './fingerprint-b3-application.mjs';
import {
  assembleB3CloudflareEvidence,
  readTrackedB3CloudflareAuthority,
  validateB3CloudflareDeploymentDraft,
  verifyB3CloudflareDeploymentEvidence,
} from './lib/b3-cloudflare-evidence.mjs';
import { validateB3CloudflareEvidence } from './lib/b3-evidence.mjs';
import { openB3CaptureStore } from './lib/b3-capture-store.mjs';
import { publishB3FinalProofOutput } from './lib/b3-final-proof-output.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

export function b3PlatformGatewayFromDeploymentDraft(value) {
  const draft = validateB3CloudflareDeploymentDraft(value);
  const [manifest, archive] = draft.objects;
  const platformObject = (object) => Object.freeze({
    key: object.key,
    sha256: object.sha256,
    size: object.size,
    etag: object.etag,
    metadataMatched: true,
  });
  return Object.freeze({
    accountId: draft.worker.accountId,
    workerName: draft.worker.name,
    publicSandboxOrigin: draft.worker.publicSandboxOrigin,
    deploymentVersionId: draft.worker.deploymentVersionId,
    scriptAuthoritySha256: draft.worker.scriptAuthoritySha256,
    signedEnvelopeSha256: draft.signedEnvelopeSha256,
    manifestObject: platformObject(manifest),
    archiveObject: platformObject(archive),
  });
}

async function readDefaultDeviceSmokeProjection() {
  const store = await openB3CaptureStore({ platform: 'ios' });
  try {
    const projection = (await store.readCapture()).gatewaySmokeProjection;
    if (projection === null) {
      throw new Error('B3 device gateway smoke projection is absent from SQLite authority');
    }
    return projection;
  } finally {
    await store.close();
  }
}

export async function proveB3Cloudflare({
  root = ROOT,
  primitives,
  applicationAuthority,
  draft,
  smokeProjection,
  trackedAuthorityReader = readTrackedB3CloudflareAuthority,
  write = false,
} = {}) {
  if (!primitives) {
    throw Object.assign(
      new Error('Task 22 authorised Cloudflare finalisation is required'),
      { code: 'b3_task22_cloudflare_finalisation_required' },
    );
  }
  const checkpoint = applicationAuthority ?? {
    testedApplicationCommit: await assertCleanB3Head(root),
    applicationFingerprint: (await fingerprintB3Application({ root })).sha256,
  };
  const tracked = await trackedAuthorityReader(root);
  const deploymentDraft = validateB3CloudflareDeploymentDraft(draft ?? (
    await readValidatedB3OperatorJson({
      path: resolve(root, '.native-build/b3/evidence/cloudflare-deployment-draft.json'),
      label: 'B3 Cloudflare deployment draft',
      root,
    })
  ).value);
  const deviceSmoke = smokeProjection ?? await readDefaultDeviceSmokeProjection();
  const candidate = validateB3CloudflareEvidence(await assembleB3CloudflareEvidence({
    draft: deploymentDraft,
    smokeProjection: deviceSmoke,
    smokeGateway: primitives.smokeGateway,
  }));
  await verifyB3CloudflareDeploymentEvidence({
    evidence: candidate,
    applicationAuthority: checkpoint,
    tracked,
    primitives,
  });
  if (write) {
    await publishB3FinalProofOutput({
      root,
      output: 'reports/b3/cloudflare-sandbox-proof.json',
      bytes: Buffer.from(`${JSON.stringify(candidate, null, 2)}\n`, 'utf8'),
    });
  }
  return candidate;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const evidence = await proveB3Cloudflare({ write: true });
    process.stdout.write(`${JSON.stringify({ ok: true, deploymentVersionId: evidence.worker.deploymentVersionId })}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ ok: false, code: error.code ?? 'b3_cloudflare_proof_failed', message: error.message })}\n`);
    process.exitCode = 6;
  }
}
