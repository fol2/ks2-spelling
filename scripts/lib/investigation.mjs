import { runCommand } from './run-command.mjs';

const KEYBOARD_DOMAIN = 'com.apple.iphonesimulator';
const KEYBOARD_KEY = 'ConnectHardwareKeyboard';

export function investigationError(code, message, options) {
  return Object.assign(new Error(message, options), { code });
}

export function roundMs(value) {
  return Math.round(value * 1_000) / 1_000;
}

export function createInvestigationRunner({ root, timeoutMs, failureCode }) {
  const execute = (command, args, { stream = false } = {}) =>
    runCommand(command, args, { cwd: root, stream, timeoutMs });
  const checked = async (command, args, options) => {
    const result = await execute(command, args, options);
    if (result.exitCode !== 0) {
      throw investigationError(
        failureCode,
        `${command} failed with exit code ${result.exitCode}.`,
      );
    }
    return result.stdout.trim();
  };
  return Object.freeze({ execute, checked });
}

export function exactAttachment(manifest, suggestedPrefix, code) {
  const matches = manifest.flatMap((entry) => entry.attachments ?? []).filter(
    ({ suggestedHumanReadableName }) => suggestedHumanReadableName?.startsWith(suggestedPrefix),
  );
  if (matches.length !== 1) {
    throw investigationError(code, `Expected one ${suggestedPrefix} attachment.`);
  }
  return matches[0].exportedFileName;
}

export async function configureSoftwareKeyboard({ execute, checked }) {
  const original = await execute('defaults', ['read', KEYBOARD_DOMAIN, KEYBOARD_KEY]);
  await checked('defaults', ['write', KEYBOARD_DOMAIN, KEYBOARD_KEY, '-bool', 'false']);
  return async () => {
    if (original.exitCode === 0) {
      const enabled = /^(?:1|true|yes)$/iu.test(original.stdout.trim());
      await checked('defaults', [
        'write', KEYBOARD_DOMAIN, KEYBOARD_KEY, '-bool', enabled ? 'true' : 'false',
      ]);
    } else {
      await checked('defaults', ['delete', KEYBOARD_DOMAIN, KEYBOARD_KEY]);
    }
  };
}
