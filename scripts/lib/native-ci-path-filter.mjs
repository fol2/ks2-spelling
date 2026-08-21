const ZERO_SHA = '0'.repeat(40);

export const NATIVE_CI_PATH_PREFIXES = Object.freeze([
  'src/',
  'public/',
  'vendor/',
  'content/',
  'config/',
  'ios/',
  'android/',
  'scripts/',
  'provenance/',
  'tests/fixtures/b3-hostile-zips/',
]);

export const NATIVE_CI_PATH_FILES = Object.freeze([
  'index.html',
  'vite.config.js',
  'capacitor.config.json',
  'package.json',
  'package-lock.json',
  '.npmrc',
  '.nvmrc',
  'docs/legal/privacy-notice.md',
]);

function normalisePath(path) {
  return String(path ?? '')
    .replaceAll('\\', '/')
    .replace(/^\.\//u, '');
}

export function presentSha(value) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed || trimmed === ZERO_SHA) return '';
  return trimmed;
}

export function pathSelectsNativeCi(
  path,
  { prefixes = NATIVE_CI_PATH_PREFIXES, files = NATIVE_CI_PATH_FILES } = {},
) {
  const candidate = normalisePath(path);
  if (!candidate || candidate.startsWith('/') || candidate.split('/').includes('..')) {
    return false;
  }
  if (files.includes(candidate)) return true;
  if (candidate === 'capacitor.config.json' || candidate.startsWith('capacitor.config.')) {
    return true;
  }
  return prefixes.some(
    (prefix) => candidate === prefix.slice(0, -1) || candidate.startsWith(prefix),
  );
}

export function resolveNativeCiBaseSha({
  mergeGroupBaseSha = '',
  pushBeforeSha = '',
} = {}) {
  return presentSha(mergeGroupBaseSha) || presentSha(pushBeforeSha) || null;
}

export function decideNativeCiSelection({
  certification = false,
  baseSha = null,
  changedPaths = null,
  prefixes = NATIVE_CI_PATH_PREFIXES,
  files = NATIVE_CI_PATH_FILES,
} = {}) {
  if (certification === true || certification === 'true') {
    return { native: true, reason: 'certification' };
  }
  if (!presentSha(baseSha ?? '')) {
    return { native: true, reason: 'unresolved-base' };
  }
  if (!Array.isArray(changedPaths)) {
    return { native: true, reason: 'unresolved-diff' };
  }
  if (changedPaths.length === 0) {
    return { native: true, reason: 'empty-diff' };
  }
  if (changedPaths.some((path) => pathSelectsNativeCi(path, { prefixes, files }))) {
    return { native: true, reason: 'native-input-changed' };
  }
  return { native: false, reason: 'no-native-input-changed' };
}
