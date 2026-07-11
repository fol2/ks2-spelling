import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { delimiter, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const EXIT_CODES = Object.freeze({
  success: 0,
  usage: 2,
  missingTool: 3,
  commandFailed: 4,
  stateMismatch: 5,
});

const SECRET_KEY =
  /(?:api[_-]?key|token|password|secret|credential|private[_-]?key|mobileprovision|provisioning[_-]?profile|code[_-]?sign[_-]?identity|signing[_-]?(?:certificate|identity))/i;

function replaceAllLiteral(text, value) {
  return value ? text.split(value).join('[REDACTED]') : text;
}

export function redactText(value, env = process.env) {
  let text = String(value ?? '');
  const secretValues = Object.entries(env)
    .filter(([key, secret]) => SECRET_KEY.test(key) && typeof secret === 'string' && secret)
    .map(([, secret]) => secret)
    .sort((left, right) => right.length - left.length);

  for (const secret of secretValues) {
    text = replaceAllLiteral(text, secret);
  }

  return text.replace(
    /((?:--)?[A-Za-z0-9_-]*(?:api[_-]?key|token|password|secret|credential|private[_-]?key|mobileprovision|provisioning[_-]?profile|code[_-]?sign[_-]?identity|signing[_-]?(?:certificate|identity))[A-Za-z0-9_-]*\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s]+)/gi,
    '$1[REDACTED]',
  );
}

export async function resolveExecutable(command, env = process.env) {
  const candidates = command.includes('/')
    ? [resolve(command)]
    : String(env.PATH ?? '')
        .split(delimiter)
        .filter(Boolean)
        .map((directory) => resolve(directory, command));

  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Continue through the deterministic search path.
    }
  }
  return null;
}

export function isMain(metaUrl) {
  return Boolean(process.argv[1]) && resolve(fileURLToPath(metaUrl)) === resolve(process.argv[1]);
}

export function runCommand(
  command,
  args = [],
  { cwd = process.cwd(), env = process.env, input = null, stream = false } = {},
) {
  return new Promise((completion) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    let spawnError = null;

    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('error', (error) => {
      spawnError = error;
    });
    child.on('close', (code, signal) => {
      const safeStdout = redactText(Buffer.concat(stdout).toString('utf8'), env);
      const safeStderr = redactText(Buffer.concat(stderr).toString('utf8'), env);
      if (stream) {
        if (safeStdout) process.stdout.write(safeStdout);
        if (safeStderr) process.stderr.write(safeStderr);
      }
      completion({
        command: redactText(command, env),
        args: args.map((argument) => redactText(argument, env)),
        exitCode: Number.isInteger(code) ? code : 1,
        signal,
        stdout: safeStdout,
        stderr: safeStderr,
        spawnError: spawnError
          ? { code: spawnError.code ?? null, message: redactText(spawnError.message, env) }
          : null,
      });
    });

    if (input === null) child.stdin.end();
    else child.stdin.end(input);
  });
}

export function startDetached(
  command,
  args = [],
  { cwd = process.cwd(), env = process.env } = {},
) {
  const child = spawn(command, args, {
    cwd,
    env,
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  return {
    command: redactText(command, env),
    args: args.map((argument) => redactText(argument, env)),
    pid: child.pid,
  };
}

export function printJson(value, stream = process.stdout) {
  stream.write(`${JSON.stringify(value, null, 2)}\n`);
}
