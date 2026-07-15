import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readValidatedB3OperatorJson } from './check-b3-external-prerequisites.mjs';
import { assertCleanB3Head } from './prepare-b3-distribution.mjs';
import { fingerprintB3Application } from './fingerprint-b3-application.mjs';
import {
  readTrackedB3CloudflareAuthority,
  verifyB3CloudflareDeploymentEvidence,
} from './lib/b3-cloudflare-evidence.mjs';
import { validateB3CloudflareEvidence } from './lib/b3-evidence.mjs';
import { createDefaultB3CloudflarePrimitives } from './lib/b3-cloudflare-live-adapter.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

export async function proveB3Cloudflare({
  root = ROOT,
  primitives,
  applicationAuthority,
  evidence,
  write = false,
} = {}) {
  const checkpoint = applicationAuthority ?? {
    testedApplicationCommit: await assertCleanB3Head(root),
    applicationFingerprint: (await fingerprintB3Application({ root })).sha256,
  };
  const tracked = await readTrackedB3CloudflareAuthority(root);
  const candidate = validateB3CloudflareEvidence(evidence ?? (
    await readValidatedB3OperatorJson({
      path: resolve(root, '.native-build/b3/evidence/cloudflare-deployment.json'),
      label: 'B3 Cloudflare deployment evidence',
      root,
    })
  ).value);
  await verifyB3CloudflareDeploymentEvidence({
    evidence: candidate,
    applicationAuthority: checkpoint,
    tracked,
    primitives: primitives ?? createDefaultB3CloudflarePrimitives({ root }),
  });
  if (write) {
    await writeFile(resolve(root, 'reports/b3/cloudflare-sandbox-proof.json'), `${JSON.stringify(candidate, null, 2)}\n`, { flag: 'wx' });
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
