import { createHash } from 'node:crypto';
import { link, lstat, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import {
  parseB3StrictJsonBytes,
  readValidatedB3OperatorFile,
} from '../check-b3-external-prerequisites.mjs';
import { createDefaultB3DistributionInspectors } from './b3-distribution-inspectors.mjs';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const HASH = /^[0-9a-f]{64}$/u;
const PLATFORM = new Set(['ios', 'android']);

function fail(message, code = 'b3_live_capture_invalid') {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function platformName(platform) {
  if (!PLATFORM.has(platform)) fail('B3 live-capture platform is invalid');
  return platform;
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function writeExclusive(path, bytes, { mode = 0o600 } = {}) {
  await mkdir(resolve(path, '..'), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, bytes, { flag: 'wx', mode });
  try {
    await link(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function persistB3PlatformScreenshot({ root, platform, sourcePath }) {
  const name = platformName(platform);
  const record = await readValidatedB3OperatorFile({ path: sourcePath, root });
  const bytes = record.bytes;
  if (bytes.length < 33 || bytes.length > 64 * 1024 * 1024 ||
      !bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE) ||
      bytes.toString('ascii', 12, 16) !== 'IHDR' ||
      bytes.readUInt32BE(16) < 320 || bytes.readUInt32BE(20) < 480) {
    fail('B3 screenshot is not a bounded original-resolution PNG');
  }
  const path = resolve(root, `reports/b3/${name}-sandbox-proof.png`);
  await writeExclusive(path, bytes);
  const persisted = await readFile(path);
  if (!persisted.equals(bytes)) fail('B3 screenshot persistence changed the original bytes');
  return Object.freeze({ path: `reports/b3/${name}-sandbox-proof.png`, sha256: sha256(bytes) });
}

export async function readB3CaptureCheckpoint({ root, platform }) {
  const name = platformName(platform);
  const path = resolve(root, `.native-build/b3/evidence/${name}-capture-checkpoint.json`);
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || (metadata.mode & 0o077) !== 0) {
    fail('B3 capture checkpoint file policy is invalid');
  }
  const canonicalRoot = await realpath(root);
  const canonicalPath = await realpath(path);
  if (!canonicalPath.startsWith(`${canonicalRoot}/`)) fail('B3 capture checkpoint escaped the repository');
  const value = parseB3StrictJsonBytes(await readFile(path), 'B3 capture checkpoint');
  const keys = ['schemaVersion', 'platform', 'nextScenario', 'completedScenarios', 'deviceObservationSha256'];
  if (!value || Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key)) ||
      value.schemaVersion !== 1 || value.platform !== name || typeof value.nextScenario !== 'string' ||
      !Array.isArray(value.completedScenarios) || !HASH.test(value.deviceObservationSha256)) {
    fail('B3 capture checkpoint schema is invalid');
  }
  return Object.freeze(structuredClone(value));
}

export async function writeB3CaptureCheckpoint({ root, platform, value }) {
  const name = platformName(platform);
  const path = resolve(root, `.native-build/b3/evidence/${name}-capture-checkpoint.json`);
  await writeExclusive(path, Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8'));
  return `.native-build/b3/evidence/${basename(path)}`;
}

function visibleActionError(platform, operation) {
  const error = new Error(`The ${platform} application does not yet export a device-generated observation for ${operation}; Task22 cannot resume securely.`);
  error.code = `b3_${platform}_native_observation_api_unavailable`;
  return error;
}

function createDefaultAdapter({ root, env, platform }) {
  const inspectors = createDefaultB3DistributionInspectors({ root, env });
  const signedPath = platform === 'ios' ? env.B3_IOS_SIGNED_IPA_PATH : env.B3_ANDROID_SIGNED_AAB_PATH;
  return Object.freeze({
    inspectDistribution: () => inspectors.artifactInspector({ platform, signedPath }),
    captureScreenshot: async () => {
      const sourcePath = platform === 'ios' ? env.B3_IOS_SCREENSHOT_PATH : env.B3_ANDROID_SCREENSHOT_PATH;
      return persistB3PlatformScreenshot({ root, platform, sourcePath });
    },
    inspectDeviceStore: async () => { throw visibleActionError(platform, 'device-store observation'); },
    inspectSyntheticLearners: async () => { throw visibleActionError(platform, 'native learner digest observation'); },
    runScenario: async ({ scenario }) => { throw visibleActionError(platform, scenario); },
    inspectTerminalEvidence: async () => { throw visibleActionError(platform, 'terminal evidence export'); },
    inspectStoreKitTest: async () => { throw visibleActionError(platform, 'StoreKit Test report binding'); },
  });
}

export function createDefaultB3IosCaptureAdapter({ root, env = process.env } = {}) {
  return createDefaultAdapter({ root, env, platform: 'ios' });
}

export function createDefaultB3AndroidCaptureAdapter({ root, env = process.env } = {}) {
  const base = createDefaultAdapter({ root, env, platform: 'android' });
  return Object.freeze({
    ...base,
    beginSlowCardScenario: base.runScenario,
    pollSlowCardScenario: base.runScenario,
    finishSlowCardScenario: base.runScenario,
    beginUnacknowledgedScenario: base.runScenario,
    forceStopUnacknowledgedScenario: base.runScenario,
    finishUnacknowledgedScenario: base.runScenario,
    wait: (milliseconds) => new Promise((resolveWait) => setTimeout(resolveWait, milliseconds)),
  });
}
