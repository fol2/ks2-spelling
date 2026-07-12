import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { join, resolve } from 'node:path';

import { canonicalJson } from '../src/platform/database/canonical-json.js';
import { fingerprintB2Application } from './fingerprint-b2-application.mjs';
import { inspectHashBoundDatabaseSet } from './lib/b2-isolated-database-evidence.mjs';
import {
  B2_ANDROID_DEVICE,
  B2_APPLICATION_ID,
  B2_ATOMIC_FAILURE_CHECKPOINTS,
  B2_NATIVE_REPORT_SCHEMA_VERSION,
  B2_PLUGIN_VERSIONS,
  analyseAndroidScreenshotBmp,
  assertAndroidAvdIdentity,
  assertAndroidAvdPointerIdentity,
  assertAndroidSerialOwnership,
  assertStartedAndroidEmulatorProcess,
  createB2AndroidFreshInstallPlan,
  compareB2NativeLogicalEvidence,
  decodeB2MachineUtf8,
  validateB2NativeReport,
} from './lib/b2-evidence.mjs';
import {
  parseAndroidResumedActivity,
} from './launch-android-emulator.mjs';
import {
  parsePackagedAndroidManifestPolicy,
  parsePackagedAndroidPermissions,
  resolveAndroidEnvironment,
} from './test-android.mjs';
import {
  EXIT_CODES,
  isMain,
  printJson,
  redactText,
  startDetached,
} from './lib/run-command.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const REPORT_DIRECTORY = join(ROOT, 'reports/b2');
const REPORT_PATH = join(REPORT_DIRECTORY, 'android-emulator-proof.json');
const SCREENSHOT_PATH = join(REPORT_DIRECTORY, 'android-emulator-proof.png');
const IOS_REPORT_PATH = join(REPORT_DIRECTORY, 'ios-simulator-proof.json');
const IOS_SCREENSHOT_PATH = join(REPORT_DIRECTORY, 'ios-simulator-proof.png');
const EXIT_REPORT_PATH = join(REPORT_DIRECTORY, 'b2-exit-report.json');
const PENDING_PROOF_PATH = join(ROOT, '.native-build/b2/android-pending-proof.json');
const DATABASE_DIRECTORY = join(ROOT, '.native-build/b2/android-database-set');
const DATABASE_NAME = 'ks2-spellingSQLite.db';
const APK_PATH = join(
  ROOT,
  '.native-build/android/build/app/outputs/apk/debug/app-debug.apk',
);
const REMOTE_DATABASE_DIRECTORY = 'databases';
const REMOTE_TEMP_DIRECTORY_PREFIX = 'files/.b2-proof-export-';
const REMOTE_HIERARCHY_PATH_PREFIX = '/sdcard/ks2-spelling-b2-window-';
const POLL_ATTEMPTS = 600;
const POLL_INTERVAL_MS = 100;
const PROCESS_POLL_ATTEMPTS = 50;
const PROCESS_POLL_INTERVAL_MS = 100;
const HIERARCHY_OUTPUT_POLL_ATTEMPTS = 20;
const HIERARCHY_OUTPUT_POLL_INTERVAL_MS = 50;
const HIERARCHY_DUMP_REPORT_PREFIX = 'UI hierchary dumped to: ';
const HIERARCHY_NULL_ROOT_DIAGNOSTIC =
  'ERROR: null root node returned by UiTestAutomationBridge.\n';
const COMMAND_TIMEOUT_MS = 15 * 60 * 1000;
const PROCESS_TERMINATION_GRACE_MS = 250;
const SHA256 = /^[a-f0-9]{64}$/;
const PID = /^[1-9][0-9]*$/;
const LOGICAL_TABLES = Object.freeze([
  Object.freeze({ name: 'app_metadata', orderBy: 'key' }),
  Object.freeze({ name: 'learner_profiles', orderBy: 'learner_id' }),
  Object.freeze({ name: 'spelling_aggregates', orderBy: 'learner_id' }),
  Object.freeze({ name: 'spelling_subject_states', orderBy: 'learner_id' }),
  Object.freeze({ name: 'spelling_practice_sessions', orderBy: 'learner_id' }),
  Object.freeze({ name: 'spelling_events', orderBy: 'learner_id, sequence_no' }),
  Object.freeze({
    name: 'spelling_monster_states',
    orderBy: 'learner_id, reward_track_id',
  }),
  Object.freeze({ name: 'spelling_camp_states', orderBy: 'learner_id, pack_id' }),
]);

export const B2_ANDROID_DATABASE_FILES = Object.freeze([
  DATABASE_NAME,
  `${DATABASE_NAME}-wal`,
  `${DATABASE_NAME}-shm`,
]);

const DEFAULT_FS = Object.freeze({
  copyFile,
  existsSync,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
});

function proofError(code, message, options) {
  const error = new Error(message, options);
  error.code = code;
  return error;
}

function b2AndroidMachineText(result, stream = 'stdout') {
  try {
    return decodeB2MachineUtf8(result?.[`${stream}Bytes`]);
  } catch (cause) {
    throw proofError(
      'b2_android_machine_output_invalid',
      `B2 Android ${stream} machine evidence is invalid`,
      { cause },
    );
  }
}

function exactKeys(value, keys) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype &&
    Object.keys(value).toSorted().join('\0') === [...keys].toSorted().join('\0')
  );
}

function exactStringArray(value, expected) {
  return (
    Array.isArray(value) &&
    value.length === expected.length &&
    value.every((entry, index) => entry === expected[index])
  );
}

function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

function throwIfAborted(signal) {
  signal?.throwIfAborted();
}

function abortableDelay(milliseconds, signal) {
  throwIfAborted(signal);
  return new Promise((resolveDelay, rejectDelay) => {
    const onAbort = () => {
      clearTimeout(timeout);
      rejectDelay(signal.reason);
    };
    const timeout = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolveDelay();
    }, milliseconds);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export function runB2AndroidSubprocess(
  command,
  args = [],
  {
    cwd = ROOT,
    env = process.env,
    timeoutMs = COMMAND_TIMEOUT_MS,
    spawnProcess = spawn,
    signalSource = process,
    signal,
    input,
  } = {},
) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError('B2 Android subprocess timeout must be a positive integer.');
  }
  if (signal?.aborted) {
    return Promise.resolve({
      command: redactText(command, env),
      args: args.map((argument) => redactText(argument, env)),
      exitCode: null,
      signal: null,
      stdout: '',
      stdoutBytes: Buffer.alloc(0),
      stderr: '',
      stderrBytes: Buffer.alloc(0),
      spawnError: null,
      timedOut: false,
      interruptedSignal: null,
      aborted: true,
      abortReason: signal.reason,
    });
  }
  return new Promise((resolveResult) => {
    if (input !== undefined && typeof input !== 'string' && !Buffer.isBuffer(input)) {
      throw new TypeError('B2 Android subprocess input must be text or bytes.');
    }
    const child = spawnProcess(command, args, {
      cwd,
      env,
      detached: true,
      stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    let spawnError = null;
    let timedOut = false;
    let interruptedSignal = null;
    let aborted = false;
    let abortReason;
    let settled = false;
    let forceKillTimer;

    const terminateGroup = (processSignal) => {
      if (!Number.isSafeInteger(child.pid)) return;
      try {
        process.kill(-child.pid, processSignal);
      } catch {
        try {
          child.kill(processSignal);
        } catch {
          // The child may already have exited.
        }
      }
    };
    const terminateWithGrace = () => {
      terminateGroup('SIGTERM');
      if (forceKillTimer === undefined) {
        forceKillTimer = setTimeout(
          () => terminateGroup('SIGKILL'),
          PROCESS_TERMINATION_GRACE_MS,
        );
        forceKillTimer.unref?.();
      }
    };
    const onSignal = (processSignal) => {
      interruptedSignal = processSignal;
      terminateWithGrace();
    };
    const onAbort = () => {
      aborted = true;
      abortReason = signal.reason;
      terminateWithGrace();
    };
    const signalHandlers = Object.fromEntries(
      ['SIGINT', 'SIGTERM'].map((name) => [name, () => onSignal(name)]),
    );
    for (const [name, handler] of Object.entries(signalHandlers)) {
      signalSource.on(name, handler);
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    const timeout = setTimeout(() => {
      timedOut = true;
      terminateWithGrace();
    }, timeoutMs);
    timeout.unref?.();

    child.stdout?.on('data', (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr?.on('data', (chunk) => stderr.push(Buffer.from(chunk)));
    if (input !== undefined) child.stdin?.end(input);
    child.on('error', (error) => {
      spawnError = error;
    });
    child.on('close', (code, processSignal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearTimeout(forceKillTimer);
      for (const [name, handler] of Object.entries(signalHandlers)) {
        signalSource.off(name, handler);
      }
      signal?.removeEventListener('abort', onAbort);
      const stdoutBytes = Buffer.concat(stdout);
      const stderrBytes = Buffer.concat(stderr);
      resolveResult({
        command: redactText(command, env),
        args: args.map((argument) => redactText(argument, env)),
        exitCode: Number.isInteger(code) ? code : null,
        signal: processSignal,
        stdout: redactText(stdoutBytes.toString('utf8'), env),
        stdoutBytes,
        stderr: redactText(stderrBytes.toString('utf8'), env),
        stderrBytes,
        spawnError,
        timedOut,
        interruptedSignal,
        aborted,
        abortReason,
      });
    });
  });
}

function createRequiredRunner(run = runB2AndroidSubprocess) {
  return async function required(
    command,
    args,
    {
      allowMissingApplication = false,
      timeoutMs = COMMAND_TIMEOUT_MS,
      signal,
      input,
    } = {},
  ) {
    throwIfAborted(signal);
    const result = await run(command, args, {
      cwd: ROOT,
      timeoutMs,
      signal,
      input,
    });
    throwIfAborted(signal);
    if (!result || typeof result !== 'object') {
      throw proofError(
        'b2_android_command_result_invalid',
        `${command} returned a malformed command result`,
      );
    }
    if (result.spawnError) {
      throw proofError(
        'b2_android_command_spawn_failed',
        `${command} could not be started: ${result.spawnError.message}`,
      );
    }
    if (result.aborted) {
      throw result.abortReason ?? proofError(
        'b2_android_command_aborted',
        `${command} ${args.join(' ')} was aborted`,
      );
    }
    if (result.timedOut) {
      throw proofError(
        'b2_android_command_timeout',
        `${command} ${args.join(' ')} exceeded its bounded timeout`,
      );
    }
    if (result.interruptedSignal) {
      throw proofError(
        'b2_android_command_interrupted',
        `${command} ${args.join(' ')} was interrupted by ${result.interruptedSignal}`,
      );
    }
    if (result.signal) {
      throw proofError(
        'b2_android_command_signal',
        `${command} ${args.join(' ')} exited via ${result.signal}`,
      );
    }
    if (result.exitCode === 0) return result;
    const machineOutput = allowMissingApplication && Number.isInteger(result.exitCode)
      ? `${b2AndroidMachineText(result)}\n${b2AndroidMachineText(result, 'stderr')}`
      : '';
    if (
      allowMissingApplication &&
      Number.isInteger(result.exitCode) &&
      /(?:unknown package|not installed|does not exist|no such file)/i.test(
        machineOutput,
      )
    ) return result;
    throw proofError(
      'b2_android_command_failed',
      `${command} ${args.join(' ')} failed with ${result.exitCode}`,
    );
  };
}

export async function runWithB2AndroidOwnedCleanup({
  work,
  killOwnedSerial,
  terminateProcessGroup,
  signalSource = process,
}) {
  if (
    typeof work !== 'function' ||
    typeof killOwnedSerial !== 'function' ||
    typeof terminateProcessGroup !== 'function'
  ) {
    throw new TypeError('B2 Android cleanup dependencies must be functions.');
  }
  let ownedSerial = null;
  let ownedProcessGroup = null;
  const ownSerial = (serial) => {
    if (serial !== B2_ANDROID_DEVICE.serial) {
      throw proofError(
        'b2_android_serial_invalid',
        'B2 Android ownership is not the exact emulator serial',
      );
    }
    ownedSerial = serial;
  };
  const ownProcessGroup = (pid) => {
    if (!Number.isSafeInteger(pid) || pid <= 0) {
      throw proofError(
        'b2_android_process_group_invalid',
        'B2 Android emulator process-group PID is invalid',
      );
    }
    if (ownedProcessGroup !== null && ownedProcessGroup !== pid) {
      throw proofError(
        'b2_android_process_group_changed',
        'B2 Android emulator process-group identity changed',
      );
    }
    ownedProcessGroup = pid;
  };
  const controller = new AbortController();
  const handlers = Object.fromEntries(
    ['SIGINT', 'SIGTERM'].map((name) => [
      name,
      () => {
        if (!controller.signal.aborted) {
          controller.abort(proofError(
            'b2_android_signal_interrupted',
            `B2 Android proof interrupted by ${name}`,
          ));
        }
      },
    ]),
  );
  for (const [name, handler] of Object.entries(handlers)) {
    signalSource.on(name, handler);
  }
  let result;
  let primaryError;
  try {
    result = await work({
      signal: controller.signal,
      ownSerial,
      ownProcessGroup,
    });
    controller.signal.throwIfAborted();
  } catch (error) {
    primaryError = controller.signal.aborted ? controller.signal.reason : error;
  } finally {
    for (const [name, handler] of Object.entries(handlers)) {
      signalSource.off(name, handler);
    }
  }
  let cleanupError;
  try {
    if (ownedSerial !== null) await killOwnedSerial(ownedSerial);
    else if (ownedProcessGroup !== null) {
      await terminateProcessGroup(ownedProcessGroup);
    }
  } catch (error) {
    cleanupError = error;
  }
  if (primaryError && cleanupError) {
    const aggregate = new AggregateError(
      [primaryError, cleanupError],
      'B2 Android proof and owned-emulator cleanup both failed',
      { cause: primaryError },
    );
    aggregate.code = primaryError.code ?? 'b2_android_proof_failed';
    throw aggregate;
  }
  if (primaryError) throw primaryError;
  if (cleanupError) throw cleanupError;
  return result;
}

export function parseB2AndroidPidProbe(result) {
  if (!result || typeof result !== 'object') {
    throw proofError(
      'b2_android_process_probe_failed',
      'B2 Android process probe result is malformed',
    );
  }
  if (
    result.spawnError ||
    result.timedOut ||
    result.interruptedSignal ||
    result.signal ||
    result.aborted
  ) {
    throw proofError(
      'b2_android_process_probe_failed',
      'B2 Android process probe did not complete normally',
    );
  }
  const stdout = b2AndroidMachineText(result);
  const stderr = b2AndroidMachineText(result, 'stderr');
  if (result.exitCode === 0 && PID.test(stdout.trim())) {
    return { state: 'present', pid: stdout.trim() };
  }
  if (
    [0, 1].includes(result.exitCode) &&
    stdout.trim() === '' &&
    stderr.trim() === ''
  ) return { state: 'absent', pid: null };
  throw proofError(
    'b2_android_process_probe_failed',
    `B2 Android process probe failed with ${result.exitCode}`,
  );
}

export async function pollB2AndroidProcess({
  expected,
  expectedPid,
  run = runB2AndroidSubprocess,
  adb = 'adb',
  attempts = PROCESS_POLL_ATTEMPTS,
  intervalMs = PROCESS_POLL_INTERVAL_MS,
  sleep = abortableDelay,
  signal,
}) {
  if (!['present', 'absent'].includes(expected)) {
    throw new TypeError('B2 Android process expectation is invalid.');
  }
  if (expectedPid !== undefined && !PID.test(expectedPid)) {
    throw new TypeError('B2 Android expected PID is invalid.');
  }
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    throwIfAborted(signal);
    const observed = parseB2AndroidPidProbe(
      await run(
        adb,
        [
          '-s',
          B2_ANDROID_DEVICE.serial,
          'shell',
          'pidof',
          B2_APPLICATION_ID,
        ],
        { cwd: ROOT, timeoutMs: 5_000, signal },
      ),
    );
    throwIfAborted(signal);
    if (
      observed.state === expected &&
      (expected !== 'present' ||
        expectedPid === undefined ||
        observed.pid === expectedPid)
    ) return observed;
    if (attempt + 1 < attempts) await sleep(intervalMs, signal);
  }
  throw proofError(
    expected === 'present'
      ? 'b2_android_process_missing'
      : 'b2_android_process_still_running',
    `B2 Android application process did not become ${expected}`,
  );
}

const B2_ANDROID_PHASES = Object.freeze([
  'Background test ready',
  'Ready for relaunch',
  'B2 proof complete',
]);
const B2_ANDROID_COMMON_VISIBLE_TEXT = Object.freeze([
  'B2 persistence proof',
  'KS2 Spelling',
  'Local SQLite, transaction recovery and app lifecycle diagnostics.',
  'Active proof phase',
  'Native local data',
  'Database',
  'ks2-spelling',
  'SQLite schema',
  '1',
  'Learner isolation',
  'Lifecycle',
]);

function decodeXmlText(value) {
  if (/&(?!(?:amp|quot|apos|lt|gt|#\d+|#x[0-9a-fA-F]+);)/.test(value)) {
    throw proofError(
      'b2_android_hierarchy_xml_invalid',
      'B2 Android hierarchy contains an unknown or unescaped XML entity',
    );
  }
  const decoded = value.replace(
    /&(?:amp|quot|apos|lt|gt|#\d+|#x[0-9a-fA-F]+);/g,
    (entity) => {
      const named = {
        '&amp;': '&',
        '&quot;': '"',
        '&apos;': "'",
        '&lt;': '<',
        '&gt;': '>',
      }[entity];
      if (named !== undefined) return named;
      const hexadecimal = entity.startsWith('&#x');
      const codePoint = Number.parseInt(
        entity.slice(hexadecimal ? 3 : 2, -1),
        hexadecimal ? 16 : 10,
      );
      if (
        !Number.isInteger(codePoint) ||
        codePoint < 0 ||
        codePoint > 0x10ffff ||
        (codePoint >= 0xd800 && codePoint <= 0xdfff)
      ) {
        throw proofError(
          'b2_android_hierarchy_xml_invalid',
          'B2 Android hierarchy contains an invalid XML character reference',
        );
      }
      return String.fromCodePoint(codePoint);
    },
  );
  return decoded;
}

export function parseB2AndroidHierarchyTexts(output) {
  const document = typeof output === 'string' ? output.trim() : '';
  const declaration = /^<\?xml\s+version=(?:"1\.0"|'1\.0')\s+encoding=(?:"UTF-8"|'UTF-8')\s+standalone=(?:"yes"|'yes')\s*\?>/;
  const declarationMatch = document.match(declaration);
  if (!declarationMatch) {
    throw proofError(
      'b2_android_hierarchy_xml_invalid',
      'B2 Android hierarchy is not an exact uiautomator XML document',
    );
  }
  let body = document.slice(declarationMatch[0].length).trim();
  const hierarchyOpen = body.match(/^<hierarchy\s+rotation="0"\s*>/);
  if (!hierarchyOpen || !body.endsWith('</hierarchy>')) {
    throw proofError(
      'b2_android_hierarchy_xml_invalid',
      'B2 Android hierarchy root is malformed',
    );
  }
  body = body
    .slice(hierarchyOpen[0].length, -'</hierarchy>'.length)
    .trim();
  const texts = [];
  const token = /<node\b([^<>]*?)\s*(\/?)>|<\/node>/g;
  let cursor = 0;
  let depth = 0;
  let nodeCount = 0;
  let rootNodeCount = 0;
  for (const match of body.matchAll(token)) {
    if (body.slice(cursor, match.index).trim() !== '') {
      throw proofError(
        'b2_android_hierarchy_xml_invalid',
        'B2 Android hierarchy contains unknown markup or text',
      );
    }
    cursor = match.index + match[0].length;
    if (match[0] === '</node>') {
      if (depth === 0) {
        throw proofError(
          'b2_android_hierarchy_xml_invalid',
          'B2 Android hierarchy closes an unopened node',
        );
      }
      depth -= 1;
      continue;
    }
    nodeCount += 1;
    if (depth === 0) rootNodeCount += 1;
    const source = match[1];
    const attributes = new Map();
    let remainder = source;
    for (const attribute of source.matchAll(
      /\s+([A-Za-z_:][A-Za-z0-9_.:-]*)="([^"]*)"/g,
    )) {
      if (attributes.has(attribute[1])) {
        throw proofError(
          'b2_android_hierarchy_xml_invalid',
          `B2 Android hierarchy node duplicates ${attribute[1]}`,
        );
      }
      attributes.set(attribute[1], decodeXmlText(attribute[2]));
      remainder = remainder.replace(attribute[0], '');
    }
    if (remainder.trim() !== '' || !attributes.has('text')) {
      throw proofError(
        'b2_android_hierarchy_xml_invalid',
        'B2 Android hierarchy node attributes are malformed',
      );
    }
    const text = attributes.get('text');
    if (text !== '') texts.push(text);
    if (match[2] !== '/') depth += 1;
  }
  if (
    cursor !== body.length ||
    depth !== 0 ||
    nodeCount === 0 ||
    rootNodeCount !== 1
  ) {
    throw proofError(
      'b2_android_hierarchy_xml_invalid',
      'B2 Android hierarchy node structure is malformed',
    );
  }
  return texts;
}

export function assertB2AndroidHierarchyPhase(output, phase) {
  if (!B2_ANDROID_PHASES.includes(phase)) {
    throw new TypeError('B2 Android hierarchy phase is invalid.');
  }
  const texts = parseB2AndroidHierarchyTexts(output);
  const expected = [
    ...B2_ANDROID_COMMON_VISIBLE_TEXT,
    phase,
    phase === 'B2 proof complete' ? 'verified' : 'pending',
    phase === 'B2 proof complete'
      ? 'pause, resume and relaunch verified'
      : 'proof in progress',
  ];
  if (
    expected.some((text) => texts.filter((candidate) => candidate === text).length !== 1) ||
    B2_ANDROID_PHASES.some(
      (candidate) => candidate !== phase && texts.includes(candidate),
    )
  ) {
    throw proofError(
      'b2_android_hierarchy_phase_invalid',
      `B2 Android UI hierarchy does not show the exact ${phase} diagnostic shell`,
    );
  }
  return {
    phase,
    hierarchySha256: sha256(Buffer.from(output, 'utf8')),
    texts,
  };
}

export async function waitForB2AndroidHierarchyPhase({
  phase,
  probe,
  attempts = POLL_ATTEMPTS,
  intervalMs = POLL_INTERVAL_MS,
  sleep = abortableDelay,
  signal,
}) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    throwIfAborted(signal);
    let result;
    try {
      result = await probe({ signal });
    } catch (error) {
      if (error.code !== 'b2_android_hierarchy_dump_not_ready') throw error;
    }
    throwIfAborted(signal);
    if (result?.exitCode === 0 && !result.signal && !result.timedOut) {
      const hierarchy = b2AndroidMachineText(result);
      try {
        return {
          ...assertB2AndroidHierarchyPhase(hierarchy, phase),
          attempts: attempt + 1,
          hierarchy,
        };
      } catch (error) {
        if (error.code !== 'b2_android_hierarchy_phase_invalid') throw error;
      }
    } else if (
      result?.spawnError ||
      result?.timedOut ||
      result?.signal ||
      result?.interruptedSignal ||
      result?.aborted
    ) {
      throw proofError(
        'b2_android_hierarchy_probe_failed',
        'B2 Android hierarchy probe failed before readiness',
      );
    }
    if (attempt + 1 < attempts) await sleep(intervalMs, signal);
  }
  throw proofError(
    'b2_android_hierarchy_timeout',
    `B2 Android UI hierarchy timed out at ${phase}`,
  );
}

function databaseSiblingNames(output) {
  const entries = String(output ?? '')
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (new Set(entries).size !== entries.length) {
    throw proofError(
      'b2_android_database_set_invalid',
      'B2 Android database listing contains duplicate entries',
    );
  }
  const siblings = entries.filter(
    (name) => name === DATABASE_NAME || name.startsWith(`${DATABASE_NAME}-`),
  );
  const unknown = siblings.filter((name) => !B2_ANDROID_DATABASE_FILES.includes(name));
  if (unknown.length !== 0) {
    throw proofError(
      'b2_android_database_sidecar_unknown',
      `B2 Android database has unknown sidecars: ${unknown.join(', ')}`,
    );
  }
  if (!siblings.includes(DATABASE_NAME)) {
    throw proofError(
      'b2_android_database_set_invalid',
      'B2 Android primary database is missing',
    );
  }
  return B2_ANDROID_DATABASE_FILES.filter((name) => siblings.includes(name));
}

export async function collectB2AndroidDatabaseSet({
  listDatabaseFiles,
  assertTemporaryDirectoryAbsent,
  createTemporaryDirectory,
  copyToTemporaryDirectory,
  pullTemporaryFile,
  removeTemporaryDirectory,
  destinationDirectory = DATABASE_DIRECTORY,
  fs = DEFAULT_FS,
  signal,
}) {
  for (const dependency of [
    listDatabaseFiles,
    assertTemporaryDirectoryAbsent,
    createTemporaryDirectory,
    copyToTemporaryDirectory,
    pullTemporaryFile,
    removeTemporaryDirectory,
  ]) {
    if (typeof dependency !== 'function') {
      throw new TypeError('B2 Android run-as collection dependency is invalid.');
    }
  }
  throwIfAborted(signal);
  const observed = databaseSiblingNames(await listDatabaseFiles({ signal }));
  throwIfAborted(signal);
  await assertTemporaryDirectoryAbsent({ signal });
  throwIfAborted(signal);
  let cleanupRegistered = false;
  const temporaryDirectory = `${destinationDirectory}.tmp-${process.pid}`;
  let destinationOwned = false;
  let primaryError;
  let result;
  try {
    cleanupRegistered = true;
    await createTemporaryDirectory({ signal });
    throwIfAborted(signal);
    await fs.rm(temporaryDirectory, { force: true, recursive: true });
    await fs.mkdir(temporaryDirectory, { recursive: true });
    for (const filename of observed) {
      throwIfAborted(signal);
      await copyToTemporaryDirectory(filename, { signal });
    }
    throwIfAborted(signal);
    const after = databaseSiblingNames(await listDatabaseFiles({ signal }));
    if (!exactStringArray(after, observed)) {
      throw proofError(
        'b2_android_database_set_changed',
        'B2 Android database sidecar set changed during run-as collection',
      );
    }
    const pulledFileSha256 = {};
    for (const filename of observed) {
      throwIfAborted(signal);
      const bytes = await pullTemporaryFile(filename, { signal });
      throwIfAborted(signal);
      if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) {
        throw proofError(
          'b2_android_database_set_invalid',
          `B2 Android database evidence is empty: ${filename}`,
        );
      }
      await fs.writeFile(join(temporaryDirectory, filename), bytes);
      pulledFileSha256[filename] = sha256(bytes);
    }
    throwIfAborted(signal);
    await fs.rm(destinationDirectory, { force: true, recursive: true });
    destinationOwned = true;
    await fs.rename(temporaryDirectory, destinationDirectory);
    const fileSha256 = {};
    for (const filename of observed) {
      throwIfAborted(signal);
      let bytes;
      try {
        bytes = await fs.readFile(join(destinationDirectory, filename));
      } catch (cause) {
        throw proofError(
          'b2_android_database_destination_changed',
          `B2 Android final database evidence cannot be read: ${filename}`,
          { cause },
        );
      }
      const finalSha256 = sha256(bytes);
      if (finalSha256 !== pulledFileSha256[filename]) {
        throw proofError(
          'b2_android_database_destination_changed',
          `B2 Android final database evidence changed after collection: ${filename}`,
        );
      }
      fileSha256[filename] = finalSha256;
    }
    result = {
      databasePath: join(destinationDirectory, DATABASE_NAME),
      sidecarsObserved: observed.slice(1),
      observedFiles: observed,
      fileSha256,
      everyObservedSidecarCollectedSafely:
        observed.length === Object.keys(fileSha256).length,
    };
  } catch (error) {
    primaryError = error;
    const cleanupErrors = [];
    for (const directory of [
      temporaryDirectory,
      ...(destinationOwned ? [destinationDirectory] : []),
    ]) {
      try {
        await fs.rm(directory, { force: true, recursive: true });
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    if (cleanupErrors.length !== 0) {
      const aggregate = new AggregateError(
        [error, ...cleanupErrors],
        'B2 Android database collection and local cleanup both failed',
        { cause: error },
      );
      aggregate.code = error.code ?? 'b2_android_database_collection_failed';
      primaryError = aggregate;
    }
  }
  let cleanupError;
  if (cleanupRegistered) {
    try {
      await removeTemporaryDirectory();
      cleanupRegistered = false;
    } catch (error) {
      cleanupError = error;
    }
  }
  if (primaryError && cleanupError) {
    const aggregate = new AggregateError(
      [primaryError, cleanupError],
      'B2 Android database collection and temporary cleanup both failed',
      { cause: primaryError },
    );
    aggregate.code = primaryError.code ?? 'b2_android_database_collection_failed';
    throw aggregate;
  }
  if (primaryError) throw primaryError;
  if (cleanupError) throw cleanupError;
  return result;
}

function pragmaScalar(database, pragma, key) {
  const row = database.prepare(`PRAGMA ${pragma}`).get();
  if (!row || !Object.hasOwn(row, key)) {
    throw proofError(
      'b2_android_pragma_invalid',
      `B2 Android collected database PRAGMA ${pragma} is incomplete`,
    );
  }
  return row[key];
}

function tableRows(database, table, orderBy) {
  return database.prepare(`SELECT * FROM ${table} ORDER BY ${orderBy}`).all();
}

async function inspectB2AndroidDatabaseFile(databasePath, { signal } = {}) {
  throwIfAborted(signal);
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    database.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    const integrityRows = database.prepare('PRAGMA integrity_check').all();
    const logicalState = {
      schema: database
        .prepare(
          'SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name',
        )
        .all(),
      tables: Object.fromEntries(
        LOGICAL_TABLES.map(({ name, orderBy }) => [
          name,
          tableRows(database, name, orderBy),
        ]),
      ),
      userVersion: database.prepare('PRAGMA user_version').all(),
    };
    throwIfAborted(signal);
    const metadataRow = logicalState.tables.app_metadata.find(
      ({ key }) => key === 'b2-proof',
    );
    let metadata;
    try {
      metadata = JSON.parse(metadataRow?.value_json ?? '');
    } catch (cause) {
      throw proofError(
        'b2_android_metadata_invalid',
        'B2 Android final proof metadata is not valid JSON',
        { cause },
      );
    }
    if (
      canonicalJson(metadata) !== metadataRow.value_json ||
      metadata.schemaVersion !== 1 ||
      metadata.phase !== 'complete' ||
      metadata.commandIndex !== 6 ||
      metadata.activeLearnerId !== 'learner-a' ||
      metadata.expectedSessionId !== null ||
      metadata.learnerARevision !== 6 ||
      metadata.updatedAt !== 1_768_478_400_000 ||
      metadataRow.updated_at !== metadata.updatedAt ||
      metadata.migrationRollback !== 'verified' ||
      !exactStringArray(metadata.lifecycleEvents, ['pause', 'resume']) ||
      !exactStringArray(
        metadata.atomicFailureCheckpoints,
        B2_ATOMIC_FAILURE_CHECKPOINTS,
      ) ||
      !SHA256.test(metadata.learnerBDigest ?? '') ||
      !SHA256.test(metadata.preRelaunchDigest ?? '')
    ) {
      throw proofError(
        'b2_android_metadata_invalid',
        'B2 Android final proof metadata is incomplete or stale',
      );
    }
    const sessionRow = logicalState.tables.spelling_practice_sessions.find(
      ({ learner_id: learnerId }) => learnerId === 'learner-a',
    );
    if (typeof sessionRow?.session_id !== 'string' || !sessionRow.session_id) {
      throw proofError(
        'b2_android_session_invalid',
        'B2 Android resumed practice session identity is missing',
      );
    }
    const campRows = logicalState.tables.spelling_camp_states;
    const monsterRows = logicalState.tables.spelling_monster_states;
    if (campRows.length !== 0) {
      throw proofError(
        'b2_android_starter_camp_invalid',
        'B2 Android Starter proof unexpectedly contains Camp rows',
      );
    }
    if (
      monsterRows.length === 0 ||
      monsterRows.some(
        ({ learner_id: learnerId, reward_track_id: rewardTrackId }) =>
          learnerId !== 'learner-a' ||
          typeof rewardTrackId !== 'string' ||
          rewardTrackId.length === 0,
      )
    ) {
      throw proofError(
        'b2_android_monster_state_invalid',
        'B2 Android Monster state is not spelling-derived and child-owned',
      );
    }
    return {
      databaseSha256: sha256(await readFile(databasePath)),
      foreignKeys: Number(pragmaScalar(database, 'foreign_keys', 'foreign_keys')),
      journalMode: pragmaScalar(database, 'journal_mode', 'journal_mode'),
      synchronous: Number(pragmaScalar(database, 'synchronous', 'synchronous')),
      busyTimeout: Number(pragmaScalar(database, 'busy_timeout', 'timeout')),
      integrityCheck:
        integrityRows.length === 1 ? integrityRows[0].integrity_check : null,
      finalLogicalSnapshotSha256: sha256(canonicalJson(logicalState)),
      resumedSessionId: sessionRow.session_id,
      learnerBDigest: metadata.learnerBDigest,
      preRelaunchDigest: metadata.preRelaunchDigest,
      migrationRollback: metadata.migrationRollback,
      atomicFailureCheckpoints: metadata.atomicFailureCheckpoints,
      lifecycleEvents: metadata.lifecycleEvents,
      finalRevision: metadata.learnerARevision,
      starterCampRows: campRows.length,
      monsterState: 'spelling-derived-child-owned',
    };
  } finally {
    database.close();
  }
}

export function inspectB2AndroidHashBoundDatabaseSet(
  options,
  {
    fs = DEFAULT_FS,
    scratchRoot = join(ROOT, '.native-build/b2'),
    inspectDatabase = inspectB2AndroidDatabaseFile,
    signal,
  } = {},
) {
  return inspectHashBoundDatabaseSet(options, {
    scratchRoot,
    scratchPrefix: 'android-database-verify',
    inspectDatabase,
    fs,
    signal,
  });
}

function requireDependency(dependencies, name) {
  if (typeof dependencies?.[name] !== 'function') {
    throw new TypeError(`B2 Android proof dependency ${name} must be a function.`);
  }
}

export async function runB2AndroidLifecycleProof(dependencies) {
  for (const name of [
    'syncAndBuildDebug',
    'acquireOwnedDevice',
    'withOwnedCleanup',
    'killOwnedSerial',
    'terminateProcessGroup',
    'bootOwnedDevice',
    'freshInstallAndLaunch',
    'waitForHierarchyPhase',
    'pressHome',
    'relaunchForResume',
    'assertProcessPresent',
    'forceStopApplication',
    'assertProcessAbsent',
    'launchApplication',
    'captureForegroundEvidence',
    'collectTerminatedDatabaseSet',
    'inspectCollectedDatabase',
    'inspectPackagedPrivacy',
  ]) requireDependency(dependencies, name);
  return dependencies.withOwnedCleanup({
    killOwnedSerial: dependencies.killOwnedSerial,
    terminateProcessGroup: dependencies.terminateProcessGroup,
    work: async ({ signal, ownSerial, ownProcessGroup }) => {
      const step = async (operation) => {
        throwIfAborted(signal);
        const value = await operation();
        throwIfAborted(signal);
        return value;
      };
      const build = await step(() => dependencies.syncAndBuildDebug({ signal }));
      const device = await step(() => dependencies.acquireOwnedDevice({ signal }));
      await step(() =>
        dependencies.bootOwnedDevice(device, {
          signal,
          ownSerial,
          ownProcessGroup,
        }),
      );
      const firstLaunch = await step(() =>
        dependencies.freshInstallAndLaunch(build, { signal }),
      );
      const preKillPid = firstLaunch?.pid;
      if (!PID.test(preKillPid ?? '')) {
        throw proofError(
          'b2_android_pid_invalid',
          'B2 Android pre-kill PID is invalid',
        );
      }
      const background = await step(() =>
        dependencies.waitForHierarchyPhase('Background test ready', { signal }),
      );
      await step(() => dependencies.assertProcessPresent(preKillPid, { signal }));
      await step(() => dependencies.pressHome({ signal }));
      await step(() => dependencies.relaunchForResume({ signal }));
      const ready = await step(() =>
        dependencies.waitForHierarchyPhase('Ready for relaunch', { signal }),
      );
      await step(() => dependencies.assertProcessPresent(preKillPid, { signal }));
      await step(() => dependencies.forceStopApplication({ signal }));
      await step(() => dependencies.assertProcessAbsent({ signal }));
      const secondLaunch = await step(() => dependencies.launchApplication({ signal }));
      const postRelaunchPid = secondLaunch?.pid;
      if (!PID.test(postRelaunchPid ?? '') || postRelaunchPid === preKillPid) {
        throw proofError(
          'b2_android_pid_unchanged',
          'B2 Android relaunch did not create a different process PID',
        );
      }
      await step(() =>
        dependencies.assertProcessPresent(postRelaunchPid, { signal }),
      );
      const complete = await step(() =>
        dependencies.waitForHierarchyPhase('B2 proof complete', { signal }),
      );
      const screenshot = await step(() =>
        dependencies.captureForegroundEvidence(
          { pid: postRelaunchPid, hierarchy: complete },
          { signal },
        ),
      );
      await step(() => dependencies.forceStopApplication({ signal }));
      await step(() => dependencies.assertProcessAbsent({ signal }));
      const collected = await step(() =>
        dependencies.collectTerminatedDatabaseSet({ signal }),
      );
      const database = await step(() =>
        dependencies.inspectCollectedDatabase(
          {
            databasePath: collected.databasePath,
            observedFiles: collected.observedFiles,
            fileSha256: collected.fileSha256,
            readOnly: true,
          },
          { signal },
        ),
      );
      const privacy = await step(() => dependencies.inspectPackagedPrivacy({ signal }));
      return {
        build,
        device,
        background,
        ready,
        complete,
        screenshot,
        collected,
        database,
        privacy,
        lifecycle: {
          preKillPid,
          postRelaunchPid,
          differentPid: true,
        },
      };
    },
  });
}

async function findAvdManager(sdkRoot, fs = DEFAULT_FS) {
  const root = join(sdkRoot, 'cmdline-tools');
  const candidates = [join(root, 'latest/bin/avdmanager')];
  try {
    const versions = (await fs.readdir(root)).toSorted().reverse();
    candidates.push(...versions.map((version) => join(root, version, 'bin/avdmanager')));
  } catch {
    // The stable missing-tool check below handles this.
  }
  return candidates.find((path) => fs.existsSync(path)) ?? null;
}

async function readAvdIdentity(fs, home) {
  const directory = join(home, '.android/avd');
  const config = await fs.readFile(
    join(directory, `${B2_ANDROID_DEVICE.name}.avd/config.ini`),
    'utf8',
  );
  const pointer = await fs.readFile(
    join(directory, `${B2_ANDROID_DEVICE.name}.ini`),
    'utf8',
  );
  assertAndroidAvdIdentity(config);
  assertAndroidAvdPointerIdentity(pointer, home);
}

function shellArgs(...args) {
  return ['-s', B2_ANDROID_DEVICE.serial, 'shell', ...args];
}

function assertB2AndroidHierarchyDumpReport(dump, expectedPath) {
  const stdout = b2AndroidMachineText(dump);
  const stderr = b2AndroidMachineText(dump, 'stderr');
  const paths = [];
  for (const stream of [stdout, stderr]) {
    if (stream === '') continue;
    if (!stream.endsWith('\n')) {
      throw proofError(
        'b2_android_hierarchy_output_report_invalid',
        'B2 Android hierarchy dump report is not complete',
      );
    }
    for (const line of stream.slice(0, -1).split('\n')) {
      if (!line.startsWith(HIERARCHY_DUMP_REPORT_PREFIX)) {
        throw proofError(
          'b2_android_hierarchy_output_report_invalid',
          'B2 Android hierarchy dump report contains unexpected diagnostics',
        );
      }
      const path = line.slice(HIERARCHY_DUMP_REPORT_PREFIX.length);
      if (!path || /\s/.test(path)) {
        throw proofError(
          'b2_android_hierarchy_output_report_invalid',
          'B2 Android hierarchy dump reported a malformed output path',
        );
      }
      paths.push(path);
    }
  }
  if (paths.length === 0 || new Set(paths).size !== 1) {
    throw proofError(
      'b2_android_hierarchy_output_report_invalid',
      'B2 Android hierarchy dump did not report one unique output path',
    );
  }
  if (paths[0] !== expectedPath) {
    throw proofError(
      'b2_android_hierarchy_output_redirected',
      'B2 Android hierarchy dump was redirected away from its owned path',
    );
  }
}

export function b2AndroidRemoteShellArgs(script) {
  if (typeof script !== 'string' || script.length === 0) {
    throw new TypeError('B2 Android remote shell script must be non-empty text.');
  }
  const quotedScript = `'${script.replaceAll("'", `'"'"'`)}'`;
  return ['sh', '-c', quotedScript];
}

export function createB2AndroidProductionDependencies({
  run = runB2AndroidSubprocess,
  fs = DEFAULT_FS,
  sleep = abortableDelay,
  signalSource = process,
  env = process.env,
  startEmulator = startDetached,
  runId = randomUUID(),
} = {}) {
  if (!/^[a-z0-9-]{8,64}$/.test(runId)) {
    throw new TypeError('B2 Android run ID must be a safe unique token.');
  }
  const resolution = resolveAndroidEnvironment({ env, pathExists: fs.existsSync });
  if (!resolution.ready) {
    throw proofError(
      'b2_android_toolchain_missing',
      `B2 Android toolchain is incomplete: ${resolution.missing.join(', ')}`,
    );
  }
  const sdkRoot = resolution.androidSdkRoot;
  const adb = join(sdkRoot, 'platform-tools/adb');
  const emulator = join(sdkRoot, 'emulator/emulator');
  const aapt2 = join(sdkRoot, 'build-tools/36.0.0/aapt2');
  const androidEnv = {
    ...env,
    JAVA_HOME: resolution.javaHome,
    ANDROID_HOME: sdkRoot,
  };
  const required = createRequiredRunner((command, args, options) =>
    run(command, args, { ...options, env: androidEnv }),
  );
  const probe = (command, args, options = {}) =>
    run(command, args, {
      cwd: ROOT,
      timeoutMs: options.timeoutMs ?? 5_000,
      signal: options.signal,
      env: androidEnv,
    });
  const hierarchyRemotePath = `${REMOTE_HIERARCHY_PATH_PREFIX}${runId}.xml`;
  const remoteTemporaryDirectory = `${REMOTE_TEMP_DIRECTORY_PREFIX}${runId}`;

  async function dumpHierarchy({ signal } = {}) {
    const collision = await required(
      adb,
      shellArgs(
        ...b2AndroidRemoteShellArgs(
          `if [ -e ${hierarchyRemotePath} ]; then echo exists; else echo absent; fi`,
        ),
      ),
      { signal, timeoutMs: 30_000 },
    );
    if (b2AndroidMachineText(collision).trim() !== 'absent') {
      throw proofError(
        'b2_android_hierarchy_collision',
        'B2 Android hierarchy path already exists',
      );
    }
    let ownsHierarchyPath = true;
    try {
      const dump = await required(
        adb,
        shellArgs('uiautomator', 'dump', hierarchyRemotePath),
        { signal, timeoutMs: 30_000 },
      );
      const dumpStdout = b2AndroidMachineText(dump);
      const dumpStderr = b2AndroidMachineText(dump, 'stderr');
      if (
        dumpStdout === '' &&
        dumpStderr === HIERARCHY_NULL_ROOT_DIAGNOSTIC
      ) {
        throw proofError(
          'b2_android_hierarchy_dump_not_ready',
          'B2 Android hierarchy dump has no accessibility root yet',
        );
      }
      assertB2AndroidHierarchyDumpReport(dump, hierarchyRemotePath);
      for (let attempt = 0; attempt < HIERARCHY_OUTPUT_POLL_ATTEMPTS; attempt += 1) {
        const output = await probe(adb, shellArgs('cat', hierarchyRemotePath), {
          signal,
          timeoutMs: 5_000,
        });
        throwIfAborted(signal);
        const outputStdout = b2AndroidMachineText(output);
        const outputStderr = b2AndroidMachineText(output, 'stderr');
        const completedNormally =
          output &&
          typeof output === 'object' &&
          !output.spawnError &&
          !output.timedOut &&
          !output.signal &&
          !output.interruptedSignal &&
          !output.aborted &&
          Number.isInteger(output.exitCode);
        if (
          completedNormally &&
          output.exitCode === 0 &&
          outputStdout.length !== 0
        ) return output;
        const outputPending = completedNormally && (
          (output.exitCode === 0 && outputStdout === '' && outputStderr === '') ||
          (output.exitCode === 1 &&
            outputStdout === '' &&
            outputStderr ===
              `cat: ${hierarchyRemotePath}: No such file or directory\n`)
        );
        if (!outputPending) {
          throw proofError(
            'b2_android_hierarchy_output_failed',
            'B2 Android hierarchy output probe failed before readiness',
          );
        }
        if (attempt === HIERARCHY_OUTPUT_POLL_ATTEMPTS - 1) {
          throw proofError(
            'b2_android_hierarchy_output_timeout',
            'B2 Android hierarchy output did not appear at its owned path',
          );
        }
        await sleep(HIERARCHY_OUTPUT_POLL_INTERVAL_MS, signal);
      }
      throw proofError(
        'b2_android_hierarchy_output_timeout',
        'B2 Android hierarchy output did not appear at its owned path',
      );
    } finally {
      if (ownsHierarchyPath) {
        await required(
          adb,
          shellArgs('rm', '-f', hierarchyRemotePath),
          { timeoutMs: 30_000 },
        );
        ownsHierarchyPath = false;
      }
    }
  }

  return {
    async syncAndBuildDebug({ signal } = {}) {
      await required(process.execPath, ['scripts/native-sync-check.mjs'], { signal });
      await required(process.execPath, ['scripts/test-android.mjs'], { signal });
      throwIfAborted(signal);
      if (!fs.existsSync(APK_PATH)) {
        throw proofError(
          'b2_android_build_output_invalid',
          'B2 Android debug APK is missing',
        );
      }
      return {
        apkPath: APK_PATH,
        compiled: true,
        configuration: 'Debug',
        signing: 'debug',
      };
    },
    async acquireOwnedDevice({ signal } = {}) {
      if (!fs.existsSync(adb) || !fs.existsSync(emulator) || !fs.existsSync(aapt2)) {
        throw proofError(
          'b2_android_launch_tools_missing',
          'B2 Android launch tools or exact aapt2 36.0.0 are unavailable',
        );
      }
      const avdManager = await findAvdManager(sdkRoot, fs);
      if (!avdManager) {
        throw proofError(
          'b2_android_launch_tools_missing',
          'B2 Android avdmanager is unavailable',
        );
      }
      const avds = await required(emulator, ['-list-avds'], { signal });
      let avdExists = b2AndroidMachineText(avds)
        .split(/\r?\n/)
        .includes(B2_ANDROID_DEVICE.name);
      if (!avdExists) {
        await required(
          avdManager,
          [
            'create',
            'avd',
            '--name',
            B2_ANDROID_DEVICE.name,
            '--package',
            B2_ANDROID_DEVICE.image,
            '--device',
            B2_ANDROID_DEVICE.device,
          ],
          { signal, input: 'no\n' },
        );
        avdExists = true;
      }
      await readAvdIdentity(fs, env.HOME);
      return { adb, emulator, avdExists };
    },
    withOwnedCleanup(options) {
      return runWithB2AndroidOwnedCleanup({ ...options, signalSource });
    },
    async bootOwnedDevice(_device, { signal, ownSerial, ownProcessGroup } = {}) {
      const state = await probe(adb, ['-s', B2_ANDROID_DEVICE.serial, 'get-state'], {
        signal,
      });
      if (state.exitCode === 0) {
        const identity = await required(
          adb,
          ['-s', B2_ANDROID_DEVICE.serial, 'emu', 'avd', 'name'],
          { signal },
        );
        assertAndroidSerialOwnership(b2AndroidMachineText(identity));
        ownSerial(B2_ANDROID_DEVICE.serial);
      } else {
        if (
          state.spawnError ||
          state.timedOut ||
          state.signal ||
          state.interruptedSignal ||
          state.aborted ||
          !Number.isInteger(state.exitCode)
        ) {
          throw proofError(
            'b2_android_serial_probe_failed',
            'B2 Android serial probe did not complete normally',
          );
        }
        const detached = startEmulator(
          emulator,
          [
            '-avd',
            B2_ANDROID_DEVICE.name,
            '-port',
            B2_ANDROID_DEVICE.port,
            '-no-snapshot-save',
            '-no-boot-anim',
          ],
          { cwd: ROOT, env: androidEnv },
        );
        if (!Number.isSafeInteger(detached?.pid) || detached.pid <= 0) {
          throw proofError(
            'b2_android_emulator_start_failed',
            'B2 Android emulator did not return an owned process PID',
          );
        }
        ownProcessGroup(detached.pid);
      }
      await required(adb, ['-s', B2_ANDROID_DEVICE.serial, 'wait-for-device'], {
        signal,
      });
      for (let attempt = 0; attempt < 90; attempt += 1) {
        const boot = await required(
          adb,
          shellArgs('getprop', 'sys.boot_completed'),
          { signal, timeoutMs: 5_000 },
        );
        if (b2AndroidMachineText(boot).trim() === '1') break;
        if (attempt === 89) {
          throw proofError(
            'b2_android_boot_timeout',
            'B2 Android emulator did not finish booting',
          );
        }
        await sleep(2_000, signal);
      }
      const identity = await required(
        adb,
        ['-s', B2_ANDROID_DEVICE.serial, 'emu', 'avd', 'name'],
        { signal },
      );
      assertAndroidSerialOwnership(b2AndroidMachineText(identity));
      ownSerial(B2_ANDROID_DEVICE.serial);
    },
    async killOwnedSerial(serial) {
      if (serial !== B2_ANDROID_DEVICE.serial) {
        throw proofError(
          'b2_android_cleanup_ownership_invalid',
          'B2 Android cleanup refused a non-owned serial',
        );
      }
      const result = await probe(adb, ['-s', serial, 'emu', 'kill'], {
        timeoutMs: 30_000,
      });
      if (
        result.spawnError ||
        result.timedOut ||
        result.signal ||
        result.interruptedSignal ||
        result.aborted ||
        ![0, 1].includes(result.exitCode)
      ) {
        throw proofError(
          'b2_android_cleanup_failed',
          'B2 Android owned-emulator shutdown failed',
        );
      }
    },
    async terminateProcessGroup(processGroupPid) {
      const identity = await probe(
        '/bin/ps',
        ['-p', String(processGroupPid), '-o', 'command='],
        { timeoutMs: 5_000 },
      );
      if (identity.exitCode === 1 && b2AndroidMachineText(identity).trim() === '') return;
      if (
        identity.exitCode !== 0 ||
        identity.spawnError ||
        identity.timedOut ||
        identity.signal ||
        identity.interruptedSignal ||
        identity.aborted
      ) {
        throw proofError(
          'b2_android_cleanup_failed',
          'B2 Android process-group identity probe failed',
        );
      }
      assertStartedAndroidEmulatorProcess(b2AndroidMachineText(identity).trim());
      try {
        process.kill(-processGroupPid, 'SIGTERM');
      } catch (error) {
        if (error.code !== 'ESRCH') throw error;
      }
    },
    async freshInstallAndLaunch(build, { signal } = {}) {
      const plan = createB2AndroidFreshInstallPlan({ apkPath: build.apkPath });
      for (const [index, [command, args]] of plan.entries()) {
        await required(command === 'adb' ? adb : command, args, {
          allowMissingApplication: index === 0,
          signal,
        });
      }
      await required(
        adb,
        shellArgs('am', 'start', '-n', B2_ANDROID_DEVICE.activity),
        { signal },
      );
      const observed = await pollB2AndroidProcess({
        expected: 'present',
        run: probe,
        adb,
        sleep,
        signal,
      });
      return { pid: observed.pid };
    },
    waitForHierarchyPhase(phase, { signal } = {}) {
      return waitForB2AndroidHierarchyPhase({
        phase,
        probe: () => dumpHierarchy({ signal }),
        sleep,
        signal,
      });
    },
    async pressHome({ signal } = {}) {
      await required(adb, shellArgs('input', 'keyevent', 'KEYCODE_HOME'), { signal });
    },
    async relaunchForResume({ signal } = {}) {
      await required(
        adb,
        shellArgs('am', 'start', '-n', B2_ANDROID_DEVICE.activity),
        { signal },
      );
    },
    async assertProcessPresent(expectedPid, { signal } = {}) {
      await pollB2AndroidProcess({
        expected: 'present',
        expectedPid,
        run: probe,
        adb,
        sleep,
        signal,
      });
    },
    async forceStopApplication({ signal } = {}) {
      await required(adb, shellArgs('am', 'force-stop', B2_APPLICATION_ID), {
        signal,
      });
    },
    async assertProcessAbsent({ signal } = {}) {
      await pollB2AndroidProcess({
        expected: 'absent',
        run: probe,
        adb,
        sleep,
        signal,
      });
    },
    async launchApplication({ signal } = {}) {
      await required(
        adb,
        shellArgs('am', 'start', '-n', B2_ANDROID_DEVICE.activity),
        { signal },
      );
      const observed = await pollB2AndroidProcess({
        expected: 'present',
        run: probe,
        adb,
        sleep,
        signal,
      });
      return { pid: observed.pid };
    },
    async captureForegroundEvidence({ pid: expectedPid, hierarchy }, { signal } = {}) {
      assertB2AndroidHierarchyPhase(hierarchy.hierarchy, 'B2 proof complete');
      await pollB2AndroidProcess({
        expected: 'present',
        expectedPid,
        run: probe,
        adb,
        sleep,
        signal,
      });
      const activities = await required(
        adb,
        shellArgs('dumpsys', 'activity', 'activities'),
        { signal },
      );
      parseAndroidResumedActivity(b2AndroidMachineText(activities));
      const freshHierarchy = await dumpHierarchy({ signal });
      const hierarchyEvidence = assertB2AndroidHierarchyPhase(
        b2AndroidMachineText(freshHierarchy),
        'B2 proof complete',
      );
      const screenshot = await required(
        adb,
        ['-s', B2_ANDROID_DEVICE.serial, 'exec-out', 'screencap', '-p'],
        { signal, timeoutMs: 30_000 },
      );
      if (!(screenshot.stdoutBytes instanceof Uint8Array) || screenshot.stdoutBytes.length === 0) {
        throw proofError(
          'b2_android_screenshot_invalid',
          'B2 Android screenshot bytes are missing',
        );
      }
      await fs.mkdir(REPORT_DIRECTORY, { recursive: true });
      await fs.writeFile(SCREENSHOT_PATH, screenshot.stdoutBytes);
      const bmpPath = join(ROOT, '.native-build/b2/android-proof.bmp');
      await fs.mkdir(join(ROOT, '.native-build/b2'), { recursive: true });
      try {
        await required(
          'sips',
          ['-s', 'format', 'bmp', SCREENSHOT_PATH, '--out', bmpPath],
          { signal },
        );
        analyseAndroidScreenshotBmp(await fs.readFile(bmpPath));
      } finally {
        await fs.rm(bmpPath, { force: true });
      }
      await pollB2AndroidProcess({
        expected: 'present',
        expectedPid,
        run: probe,
        adb,
        sleep,
        signal,
      });
      const screenshotBytes = await fs.readFile(SCREENSHOT_PATH);
      return {
        path: SCREENSHOT_PATH,
        sha256: sha256(screenshotBytes),
        machineStateSource: 'uiautomator-hierarchy',
        exactTextState: 'complete',
        hierarchySha256: hierarchyEvidence.hierarchySha256,
        manualVisualInspection: 'pending',
      };
    },
    collectTerminatedDatabaseSet({ signal } = {}) {
      const runAs = (...args) =>
        required(adb, shellArgs('run-as', B2_APPLICATION_ID, ...args), { signal });
      const runAsCleanup = (...args) =>
        required(adb, shellArgs('run-as', B2_APPLICATION_ID, ...args), {
          timeoutMs: 30_000,
        });
      return collectB2AndroidDatabaseSet({
        async listDatabaseFiles() {
          return b2AndroidMachineText(
            await runAs('ls', '-1', REMOTE_DATABASE_DIRECTORY),
          );
        },
        async assertTemporaryDirectoryAbsent() {
          const result = await runAs(
            ...b2AndroidRemoteShellArgs(
              `if [ -e ${remoteTemporaryDirectory} ]; then echo exists; else echo absent; fi`,
            ),
          );
          if (b2AndroidMachineText(result).trim() !== 'absent') {
            throw proofError(
              'b2_android_temporary_collision',
              'B2 Android run-as temporary directory already exists',
            );
          }
        },
        async createTemporaryDirectory() {
          await runAsCleanup(
            ...b2AndroidRemoteShellArgs(
              `mkdir ${remoteTemporaryDirectory} && printf ${runId} > ${remoteTemporaryDirectory}/.owner`,
            ),
          );
        },
        async copyToTemporaryDirectory(filename) {
          if (!B2_ANDROID_DATABASE_FILES.includes(filename)) {
            throw proofError(
              'b2_android_database_sidecar_unknown',
              `B2 Android refused unknown database evidence: ${filename}`,
            );
          }
          await runAs(
            'cp',
            `${REMOTE_DATABASE_DIRECTORY}/${filename}`,
            `${remoteTemporaryDirectory}/${filename}`,
          );
        },
        async pullTemporaryFile(filename) {
          const result = await required(
            adb,
            [
              '-s',
              B2_ANDROID_DEVICE.serial,
              'exec-out',
              'run-as',
              B2_APPLICATION_ID,
              'cat',
              `${remoteTemporaryDirectory}/${filename}`,
            ],
            { signal },
          );
          return result.stdoutBytes;
        },
        async removeTemporaryDirectory() {
          await runAsCleanup(
            ...b2AndroidRemoteShellArgs(
              `if [ ! -e ${remoteTemporaryDirectory} ]; then exit 0; elif [ "$(cat ${remoteTemporaryDirectory}/.owner 2>/dev/null)" = "${runId}" ]; then rm -rf ${remoteTemporaryDirectory}; else echo foreign-owned-temp >&2; exit 42; fi`,
            ),
          );
        },
        fs,
        signal,
      });
    },
    async inspectCollectedDatabase(
      { databasePath, observedFiles, fileSha256, readOnly },
      { signal } = {},
    ) {
      if (readOnly !== true) {
        throw new TypeError('B2 Android database inspection must be read-only.');
      }
      return inspectB2AndroidHashBoundDatabaseSet(
        { databasePath, observedFiles, fileSha256 },
        { fs, signal },
      );
    },
    async inspectPackagedPrivacy({ signal } = {}) {
      const [permissionsOutput, manifestOutput, configOutput, api, osVersion] =
        await Promise.all([
          required(aapt2, ['dump', 'permissions', APK_PATH], { signal }),
          required(
            aapt2,
            ['dump', 'xmltree', '--file', 'AndroidManifest.xml', APK_PATH],
            { signal },
          ),
          required('unzip', ['-p', APK_PATH, 'assets/capacitor.config.json'], {
            signal,
          }),
          required(adb, shellArgs('getprop', 'ro.build.version.sdk'), { signal }),
          required(adb, shellArgs('getprop', 'ro.build.version.release'), { signal }),
        ]);
      const permissions = parsePackagedAndroidPermissions(
        b2AndroidMachineText(permissionsOutput),
      );
      const backup = parsePackagedAndroidManifestPolicy(
        b2AndroidMachineText(manifestOutput),
      );
      let config;
      try {
        config = JSON.parse(b2AndroidMachineText(configOutput));
      } catch (cause) {
        throw proofError(
          'b2_android_config_invalid',
          'B2 Android packaged Capacitor configuration is invalid',
          { cause },
        );
      }
      if ((config.server?.url ?? null) !== null) {
        throw proofError(
          'b2_android_server_url_invalid',
          'B2 Android packaged application contains server.url',
        );
      }
      if (
        b2AndroidMachineText(api).trim() !== '36' ||
        b2AndroidMachineText(osVersion).trim() !== '16'
      ) {
        throw proofError(
          'b2_android_runtime_invalid',
          'B2 Android runtime is not Android 16 / API 36',
        );
      }
      return {
        serverUrl: null,
        packagedPermissions: [
          ...permissions.declaredPermissions,
          ...permissions.requestedPermissions,
        ],
        androidBackupEnabled: backup.allowBackup,
        androidApi: 36,
        osVersion: '16',
        buildTools: '36.0.0',
      };
    },
  };
}

export function assertB2AndroidApplicationStatusClean(statusOutput) {
  const applicationChanges = String(statusOutput ?? '')
    .split('\n')
    .filter(Boolean)
    .filter((line) => {
      const path = line.slice(3).replace(/^"|"$/g, '');
      return !path.startsWith('reports/b2/');
    });
  if (applicationChanges.length !== 0) {
    throw proofError(
      'b2_android_checkpoint_dirty',
      'B2 Android proof requires a clean application checkpoint',
    );
  }
  return true;
}

export function validateB2AndroidManualAttestation(candidate, screenshotSha256) {
  if (
    !exactKeys(candidate, [
      'schemaVersion',
      'platform',
      'screenshotSha256',
      'manualVisualInspection',
    ]) ||
    candidate.schemaVersion !== 1 ||
    candidate.platform !== 'android-emulator' ||
    candidate.manualVisualInspection !== 'passed' ||
    !SHA256.test(screenshotSha256 ?? '') ||
    candidate.screenshotSha256 !== screenshotSha256
  ) {
    throw proofError(
      'b2_android_manual_attestation_invalid',
      'B2 Android manual visual attestation is missing, stale or malformed',
    );
  }
  return structuredClone(candidate);
}

export function validateB2AndroidPendingProof(
  candidate,
  { expectedCommit, expectedFingerprint, screenshotBytes } = {},
) {
  const invalid = (detail) => {
    throw proofError(
      'b2_android_pending_proof_invalid',
      `B2 Android pending proof ${detail}`,
    );
  };
  if (
    !exactKeys(candidate, [
      'schemaVersion',
      'testedApplicationCommit',
      'applicationFingerprint',
      'proof',
    ]) ||
    candidate.schemaVersion !== 1 ||
    candidate.testedApplicationCommit !== expectedCommit ||
    candidate.applicationFingerprint !== expectedFingerprint ||
    !/^[a-f0-9]{40}$/.test(candidate.testedApplicationCommit ?? '') ||
    !SHA256.test(candidate.applicationFingerprint ?? '')
  ) invalid('checkpoint identity is stale or malformed');
  const proof = candidate.proof;
  if (
    !exactKeys(proof, [
      'build',
      'device',
      'background',
      'ready',
      'complete',
      'screenshot',
      'collected',
      'database',
      'privacy',
      'lifecycle',
    ]) ||
    !exactKeys(proof.build, [
      'apkPath',
      'compiled',
      'configuration',
      'signing',
    ]) ||
    typeof proof.build.apkPath !== 'string' ||
    !proof.build.apkPath ||
    proof.build.compiled !== true ||
    proof.build.configuration !== 'Debug' ||
    proof.build.signing !== 'debug' ||
    !exactKeys(proof.device, ['adb', 'emulator', 'avdExists']) ||
    typeof proof.device.adb !== 'string' ||
    !proof.device.adb ||
    typeof proof.device.emulator !== 'string' ||
    !proof.device.emulator ||
    proof.device.avdExists !== true ||
    !exactKeys(proof.background, [
      'phase',
      'hierarchySha256',
      'attempts',
      'hierarchy',
    ]) ||
    !exactKeys(proof.ready, [
      'phase',
      'hierarchySha256',
      'attempts',
      'hierarchy',
    ]) ||
    !exactKeys(proof.complete, [
      'phase',
      'hierarchySha256',
      'attempts',
      'hierarchy',
    ]) ||
    !exactStringArray(
      [proof.background.phase, proof.ready.phase, proof.complete.phase],
      ['Background test ready', 'Ready for relaunch', 'B2 proof complete'],
    ) ||
    [proof.background, proof.ready, proof.complete].some(
      (phase) =>
        typeof phase.hierarchy !== 'string' ||
        !phase.hierarchy.includes(phase.phase) ||
        !Number.isSafeInteger(phase.attempts) ||
        phase.attempts < 1 ||
        !SHA256.test(phase.hierarchySha256 ?? '') ||
        sha256(Buffer.from(phase.hierarchy, 'utf8')) !== phase.hierarchySha256,
    ) ||
    !exactKeys(proof.screenshot, [
      'path',
      'sha256',
      'machineStateSource',
      'exactTextState',
      'hierarchySha256',
      'manualVisualInspection',
    ]) ||
    typeof proof.screenshot.path !== 'string' ||
    !proof.screenshot.path ||
    proof.screenshot?.manualVisualInspection !== 'pending' ||
    proof.screenshot?.machineStateSource !== 'uiautomator-hierarchy' ||
    proof.screenshot?.exactTextState !== 'complete' ||
    !SHA256.test(proof.screenshot?.sha256 ?? '') ||
    proof.screenshot.hierarchySha256 !== proof.complete.hierarchySha256 ||
    !(screenshotBytes instanceof Uint8Array) ||
    sha256(screenshotBytes) !== proof.screenshot.sha256 ||
    !exactKeys(proof.lifecycle, [
      'preKillPid',
      'postRelaunchPid',
      'differentPid',
    ]) ||
    !PID.test(proof.lifecycle?.preKillPid ?? '') ||
    !PID.test(proof.lifecycle?.postRelaunchPid ?? '') ||
    proof.lifecycle.preKillPid === proof.lifecycle.postRelaunchPid ||
    proof.lifecycle.differentPid !== true ||
    !exactKeys(proof.collected, [
      'databasePath',
      'sidecarsObserved',
      'observedFiles',
      'fileSha256',
      'everyObservedSidecarCollectedSafely',
    ]) ||
    typeof proof.collected.databasePath !== 'string' ||
    !proof.collected.databasePath ||
    !exactKeys(proof.database, [
      'databaseSha256',
      'foreignKeys',
      'journalMode',
      'synchronous',
      'busyTimeout',
      'integrityCheck',
      'finalLogicalSnapshotSha256',
      'resumedSessionId',
      'learnerBDigest',
      'preRelaunchDigest',
      'migrationRollback',
      'atomicFailureCheckpoints',
      'lifecycleEvents',
      'finalRevision',
      'starterCampRows',
      'monsterState',
    ]) ||
    proof.database?.finalRevision !== 6 ||
    !SHA256.test(proof.database?.databaseSha256 ?? '') ||
    !SHA256.test(proof.database?.finalLogicalSnapshotSha256 ?? '') ||
    !SHA256.test(proof.database?.learnerBDigest ?? '') ||
    !SHA256.test(proof.database?.preRelaunchDigest ?? '') ||
    typeof proof.database?.resumedSessionId !== 'string' ||
    !proof.database.resumedSessionId ||
    proof.database.foreignKeys !== 1 ||
    proof.database.journalMode !== 'wal' ||
    proof.database.synchronous !== 2 ||
    proof.database.busyTimeout !== 5000 ||
    proof.database.integrityCheck !== 'ok' ||
    !exactStringArray(
      proof.database?.atomicFailureCheckpoints,
      B2_ATOMIC_FAILURE_CHECKPOINTS,
    ) ||
    proof.database?.migrationRollback !== 'verified' ||
    !exactStringArray(proof.database?.lifecycleEvents, ['pause', 'resume']) ||
    proof.database?.starterCampRows !== 0 ||
    proof.database?.monsterState !== 'spelling-derived-child-owned' ||
    !Array.isArray(proof.collected?.observedFiles) ||
    proof.collected.observedFiles[0] !== DATABASE_NAME ||
    !exactStringArray(
      proof.collected.observedFiles,
      B2_ANDROID_DATABASE_FILES.filter((name) =>
        proof.collected.observedFiles.includes(name),
      ),
    ) ||
    !exactKeys(
      proof.collected.fileSha256,
      proof.collected.observedFiles,
    ) ||
    !exactStringArray(
      proof.collected.sidecarsObserved,
      proof.collected.observedFiles.slice(1),
    ) ||
    proof.collected.observedFiles.some(
      (name) => !SHA256.test(proof.collected.fileSha256[name]),
    ) ||
    proof.collected.everyObservedSidecarCollectedSafely !== true ||
    proof.database.databaseSha256 !==
      proof.collected.fileSha256[DATABASE_NAME] ||
    !exactKeys(proof.privacy, [
      'serverUrl',
      'packagedPermissions',
      'androidBackupEnabled',
      'androidApi',
      'osVersion',
      'buildTools',
    ]) ||
    proof.privacy?.packagedPermissions?.length !== 0 ||
    proof.privacy?.androidBackupEnabled !== false ||
    proof.privacy?.serverUrl !== null ||
    proof.privacy.androidApi !== 36 ||
    proof.privacy.osVersion !== '16' ||
    proof.privacy.buildTools !== '36.0.0'
  ) invalid('payload is incomplete, stale or malformed');
  try {
    for (const hierarchy of [proof.background, proof.ready, proof.complete]) {
      assertB2AndroidHierarchyPhase(hierarchy.hierarchy, hierarchy.phase);
    }
  } catch {
    invalid('hierarchy phases are not the exact diagnostic shell');
  }
  return structuredClone(candidate);
}

async function assertCleanCheckpoint(required) {
  const [commit, status] = await Promise.all([
    required('git', ['rev-parse', 'HEAD']),
    required('git', ['status', '--porcelain', '--untracked-files=all']),
  ]);
  const testedApplicationCommit = b2AndroidMachineText(commit).trim();
  if (!/^[a-f0-9]{40}$/.test(testedApplicationCommit)) {
    throw proofError(
      'b2_android_checkpoint_invalid',
      'B2 Android tested application commit is malformed',
    );
  }
  assertB2AndroidApplicationStatusClean(b2AndroidMachineText(status));
  return testedApplicationCommit;
}

export async function clearB2AndroidProofOutputs(fs = DEFAULT_FS) {
  await Promise.all([
    fs.rm(REPORT_PATH, { force: true }),
    fs.rm(SCREENSHOT_PATH, { force: true }),
    fs.rm(EXIT_REPORT_PATH, { force: true }),
    fs.rm(PENDING_PROOF_PATH, { force: true }),
  ]);
}

export async function writeB2AndroidValidatedReport({
  testedApplicationCommit,
  applicationFingerprint,
  proof,
  manualAttestation,
  fs = DEFAULT_FS,
  paths = {
    androidReport: REPORT_PATH,
    androidScreenshot: SCREENSHOT_PATH,
    iosReport: IOS_REPORT_PATH,
    iosScreenshot: IOS_SCREENSHOT_PATH,
  },
}) {
  const attestation = validateB2AndroidManualAttestation(
    manualAttestation,
    proof.screenshot.sha256,
  );
  const report = {
    schemaVersion: B2_NATIVE_REPORT_SCHEMA_VERSION,
    platform: 'android-emulator',
    testedApplicationCommit,
    applicationFingerprint,
    identity: { applicationId: B2_APPLICATION_ID },
    device: {
      name: B2_ANDROID_DEVICE.name,
      runtime: B2_ANDROID_DEVICE.image,
      osVersion: proof.privacy.osVersion,
    },
    nativeVersions: {
      buildTools: proof.privacy.buildTools,
      androidApi: proof.privacy.androidApi,
      capacitorAndroid: '8.4.1',
    },
    pluginVersions: { ...B2_PLUGIN_VERSIONS },
    database: {
      name: 'ks2-spelling',
      physicalFile: DATABASE_NAME,
      schemaVersion: 1,
      foreignKeys: proof.database.foreignKeys,
      journalMode: proof.database.journalMode,
      synchronous: proof.database.synchronous,
      busyTimeout: proof.database.busyTimeout,
      integrityCheck: proof.database.integrityCheck,
      databaseSha256: proof.database.databaseSha256,
      walModeObserved: proof.database.journalMode === 'wal',
      sidecarsObserved: proof.collected.sidecarsObserved,
      everyObservedSidecarCollectedSafely:
        proof.collected.everyObservedSidecarCollectedSafely,
    },
    lifecycle: {
      events: ['pause', 'resume'],
      ...proof.lifecycle,
    },
    proof: {
      resumedSessionId: proof.database.resumedSessionId,
      preKillRevision: 4,
      finalRevision: proof.database.finalRevision,
      finalLogicalSnapshotSha256: proof.database.finalLogicalSnapshotSha256,
      atomicFailureCheckpoints: proof.database.atomicFailureCheckpoints,
      migrationRollback: proof.database.migrationRollback,
      learnerBIsolation: 'verified',
      learnerBInitialSha256: proof.database.learnerBDigest,
      learnerBFinalSha256: proof.database.learnerBDigest,
      monsterState: proof.database.monsterState,
      starterCampRows: proof.database.starterCampRows,
    },
    privacy: {
      serverUrl: proof.privacy.serverUrl,
      packagedAndroidPermissions: proof.privacy.packagedPermissions,
      androidBackupEnabled: proof.privacy.androidBackupEnabled,
      addedIosUsageDescriptionKeys: [],
      addedIosEntitlements: [],
    },
    ui: {
      diagnosticPhase: 'complete',
      machineStateSource: proof.screenshot.machineStateSource,
      screenshotSha256: proof.screenshot.sha256,
      manualVisualInspection: attestation.manualVisualInspection,
    },
    cleanup: { deviceStopped: true },
  };
  const screenshotBytes = await fs.readFile(paths.androidScreenshot);
  validateB2NativeReport(report, {
    expectedPlatform: 'android-emulator',
    expectedApplicationCommit: testedApplicationCommit,
    expectedApplicationFingerprint: applicationFingerprint,
    screenshotBytes,
  });
  let iosReport;
  try {
    iosReport = JSON.parse(await fs.readFile(paths.iosReport, 'utf8'));
  } catch (cause) {
    throw proofError(
      'b2_android_ios_evidence_missing',
      'B2 Android finalisation requires the matched iOS report',
      { cause },
    );
  }
  let iosScreenshotBytes;
  try {
    iosScreenshotBytes = await fs.readFile(paths.iosScreenshot);
  } catch (cause) {
    throw proofError(
      'b2_android_ios_evidence_missing',
      'B2 Android finalisation requires the matched iOS screenshot',
      { cause },
    );
  }
  validateB2NativeReport(iosReport, {
    expectedPlatform: 'ios-simulator',
    expectedApplicationCommit: testedApplicationCommit,
    expectedApplicationFingerprint: applicationFingerprint,
    screenshotBytes: iosScreenshotBytes,
  });
  compareB2NativeLogicalEvidence(iosReport, report);
  await fs.writeFile(
    paths.androidReport,
    `${JSON.stringify(report, null, 2)}\n`,
    'utf8',
  );
  return report;
}

async function capturePendingProof() {
  await clearB2AndroidProofOutputs();
  const required = createRequiredRunner();
  try {
    const testedApplicationCommit = await assertCleanCheckpoint(required);
    const before = await fingerprintB2Application({ root: ROOT });
    const proof = await runB2AndroidLifecycleProof(
      createB2AndroidProductionDependencies(),
    );
    const after = await fingerprintB2Application({ root: ROOT });
    if (before.sha256 !== after.sha256) {
      throw proofError(
        'b2_android_application_drift',
        'B2 Android application fingerprint changed during proof',
      );
    }
    await assertCleanCheckpoint(required);
    await DEFAULT_FS.mkdir(join(ROOT, '.native-build/b2'), { recursive: true });
    await DEFAULT_FS.writeFile(
      PENDING_PROOF_PATH,
      `${JSON.stringify({
        schemaVersion: 1,
        testedApplicationCommit,
        applicationFingerprint: before.sha256,
        proof,
      }, null, 2)}\n`,
      'utf8',
    );
    printJson(
      {
        ok: false,
        code: 'b2_android_manual_attestation_required',
        screenshot: 'reports/b2/android-emulator-proof.png',
        screenshotSha256: proof.screenshot.sha256,
        pendingProof: '.native-build/b2/android-pending-proof.json',
      },
      process.stderr,
    );
    return EXIT_CODES.stateMismatch;
  } catch (error) {
    await clearB2AndroidProofOutputs();
    throw error;
  }
}

async function finalisePendingProof(attestationPath) {
  if (typeof attestationPath !== 'string' || !attestationPath) {
    throw proofError(
      'b2_android_manual_attestation_required',
      'Use --attest <path> with a screenshot-SHA-bound manual attestation',
    );
  }
  const required = createRequiredRunner();
  const currentCommit = await assertCleanCheckpoint(required);
  const fingerprint = await fingerprintB2Application({ root: ROOT });
  const screenshotBytes = await DEFAULT_FS.readFile(SCREENSHOT_PATH);
  let pending = JSON.parse(await DEFAULT_FS.readFile(PENDING_PROOF_PATH, 'utf8'));
  pending = validateB2AndroidPendingProof(pending, {
    expectedCommit: currentCommit,
    expectedFingerprint: fingerprint.sha256,
    screenshotBytes,
  });
  const recomputedDatabase = await inspectB2AndroidHashBoundDatabaseSet({
    databasePath: pending.proof.collected.databasePath,
    observedFiles: pending.proof.collected.observedFiles,
    fileSha256: pending.proof.collected.fileSha256,
  });
  if (canonicalJson(recomputedDatabase) !== canonicalJson(pending.proof.database)) {
    throw proofError(
      'b2_android_pending_proof_invalid',
      'B2 Android pending logical database report was locally modified',
    );
  }
  const manualAttestation = JSON.parse(
    await DEFAULT_FS.readFile(resolve(attestationPath), 'utf8'),
  );
  await DEFAULT_FS.rm(REPORT_PATH, { force: true });
  const report = await writeB2AndroidValidatedReport({
    testedApplicationCommit: pending.testedApplicationCommit,
    applicationFingerprint: pending.applicationFingerprint,
    proof: pending.proof,
    manualAttestation,
  });
  await DEFAULT_FS.rm(PENDING_PROOF_PATH, { force: true });
  printJson({
    ok: true,
    report: 'reports/b2/android-emulator-proof.json',
    proof: report,
  });
  return EXIT_CODES.success;
}

export async function main(args = process.argv.slice(2)) {
  try {
    if (args.length === 0) return capturePendingProof();
    if (args.length === 2 && args[0] === '--attest') {
      return finalisePendingProof(args[1]);
    }
    throw proofError(
      'b2_android_proof_usage_invalid',
      'Use no arguments to capture or --attest <path> to finalise',
    );
  } catch (error) {
    printJson(
      {
        ok: false,
        code: error.code ?? 'b2_android_proof_failed',
        message: error.message,
      },
      process.stderr,
    );
    return EXIT_CODES.stateMismatch;
  }
}

if (isMain(import.meta.url)) {
  process.exitCode = await main();
}
