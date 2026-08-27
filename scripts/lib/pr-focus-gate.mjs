const ZERO_SHA = '0'.repeat(40);

export const SAFE_DOCUMENTATION_FILES = Object.freeze([
  '.github/pull_request_template.md',
  'AGENTS.md',
  'docs/agents/ai-sdlc.md',
  'docs/agents/issue-tracker.md',
  'docs/operations/merge-tier-gate.md',
]);

// Directory-wide documentation shortcuts are intentionally absent. A new path
// joins the zero-bootstrap route only with a direct contract test and fixture.
export const SAFE_DOCUMENTATION_PREFIXES = Object.freeze([]);

function normalisePath(path) {
  if (typeof path !== 'string') return '';
  if (path !== path.trim()) return '';
  const raw = path;
  if (
    raw.includes('\\') ||
    raw.startsWith('/') ||
    raw.startsWith('./') ||
    /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(raw)
  ) {
    return '';
  }
  const segments = raw.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    return '';
  }
  return raw;
}

export function presentSha(value) {
  if (typeof value !== 'string') return '';
  const candidate = value.trim();
  if (!candidate || candidate === ZERO_SHA || !/^[0-9a-f]{40}$/u.test(candidate)) {
    return '';
  }
  return candidate;
}

export function pathIsSafeDocumentation(
  path,
  {
    files = SAFE_DOCUMENTATION_FILES,
    prefixes = SAFE_DOCUMENTATION_PREFIXES,
  } = {},
) {
  const candidate = normalisePath(path);
  if (!candidate) return false;
  if (files.includes(candidate)) return true;
  if (!candidate.endsWith('.md')) return false;
  return prefixes.some((prefix) => candidate.startsWith(prefix));
}

export function decidePrFocusGate({
  eventName = '',
  baseSha = null,
  changedPaths = null,
  files = SAFE_DOCUMENTATION_FILES,
  prefixes = SAFE_DOCUMENTATION_PREFIXES,
} = {}) {
  if (eventName !== 'pull_request') {
    return { product: true, focus: 'F0,F1,F2', reason: 'integration-event' };
  }
  if (!presentSha(baseSha ?? '')) {
    return { product: true, focus: 'F0,F1,F2', reason: 'unresolved-base' };
  }
  if (!Array.isArray(changedPaths)) {
    return { product: true, focus: 'F0,F1,F2', reason: 'unresolved-diff' };
  }
  if (changedPaths.length === 0) {
    return { product: true, focus: 'F0,F1,F2', reason: 'empty-diff' };
  }
  const triggerPath = changedPaths.find(
    (path) => !pathIsSafeDocumentation(path, { files, prefixes }),
  );
  if (triggerPath !== undefined) {
    return {
      product: true,
      focus: 'F0,F1,F2',
      reason: 'product-or-unknown-change',
      triggerPath,
    };
  }
  return { product: false, focus: 'F0', reason: 'safe-documentation-only' };
}
