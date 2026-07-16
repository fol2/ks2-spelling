import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  checkB3ExternalPrerequisites,
  createCloudflareRemoteInspector,
  runOAuthSafeWrangler,
  validateB3LocalMutationAuthority,
} from './check-b3-external-prerequisites.mjs';
import {
  B3_CLOUDFLARE_SCOPE,
  assertB3RemoteMutationScope,
  orchestrateB3CloudflareDeployment,
  readTrackedB3CloudflareAuthority,
  validateB3CloudflareDeploymentDraft,
} from './lib/b3-cloudflare-evidence.mjs';
import { createDefaultB3CloudflarePrimitives } from './lib/b3-cloudflare-live-adapter.mjs';
import { assertCleanB3Head } from './prepare-b3-distribution.mjs';
import { fingerprintB3Application } from './fingerprint-b3-application.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

export async function deployB3SandboxGateway({
  root = ROOT,
  env = process.env,
  remoteInspector,
  primitives,
  readAuthorityObject,
  applicationAuthority,
  clock,
  localMutationGate = validateB3LocalMutationAuthority,
  prerequisiteChecker = checkB3ExternalPrerequisites,
  trackedAuthorityReader = readTrackedB3CloudflareAuthority,
  write = false,
} = {}) {
  assertB3RemoteMutationScope({
    approvedScope: env.B3_REMOTE_MUTATION_SCOPE,
    runToken: env.B3_REMOTE_RUN_TOKEN,
    expectedScope: B3_CLOUDFLARE_SCOPE,
  });
  await localMutationGate({
    approvalFile: env.B3_PREREQUISITES_FILE,
    runToken: env.B3_REMOTE_RUN_TOKEN,
    requestedScope: B3_CLOUDFLARE_SCOPE,
    root,
    clock,
  });
  const inspector = remoteInspector ?? createCloudflareRemoteInspector({
    commandRunner: (args, context) => runOAuthSafeWrangler(args, { root, env, accountId: context?.accountId }),
  });
  const prerequisite = await prerequisiteChecker({
    approvalFile: env.B3_PREREQUISITES_FILE,
    runToken: env.B3_REMOTE_RUN_TOKEN,
    remoteInspector: inspector,
    root,
    clock,
  });
  if (prerequisite.status !== 'pass') {
    const error = new Error('B3 Cloudflare prerequisites are blocked');
    error.code = 'b3_cloudflare_prerequisites_blocked';
    error.gates = prerequisite.gates;
    throw error;
  }
  const tracked = await trackedAuthorityReader(root);
  const checkpoint = applicationAuthority ?? {
    testedApplicationCommit: await assertCleanB3Head(root),
    applicationFingerprint: (await fingerprintB3Application({ root })).sha256,
  };
  const defaultReader = (role) => readFile(resolve(
    root,
    role === 'signed-manifest'
      ? '.native-build/b3/pack/signed-manifest.json'
      : '.native-build/b3/pack/b3-sandbox-proof.zip',
  ));
  const draft = validateB3CloudflareDeploymentDraft(await orchestrateB3CloudflareDeployment({
    applicationAuthority: checkpoint,
    tracked,
    primitives: primitives ?? createDefaultB3CloudflarePrimitives({ root, env }),
    readAuthorityObject: readAuthorityObject ?? defaultReader,
  }));
  if (write) {
    const evidenceDirectory = resolve(root, '.native-build/b3/evidence');
    await mkdir(evidenceDirectory, { recursive: true, mode: 0o700 });
    await writeFile(
      resolve(evidenceDirectory, 'cloudflare-deployment-draft.json'),
      `${JSON.stringify(draft, null, 2)}\n`,
      { mode: 0o600, flag: 'wx' },
    );
  }
  return draft;
}

async function main() {
  try {
    const evidence = await deployB3SandboxGateway({ write: true });
    process.stdout.write(`${JSON.stringify({ ok: true, deploymentVersionId: evidence.worker.deploymentVersionId })}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ ok: false, code: error.code ?? 'b3_cloudflare_deploy_failed', message: error.message, ...(error.gates ? { gates: error.gates } : {}) })}\n`);
    return 6;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
