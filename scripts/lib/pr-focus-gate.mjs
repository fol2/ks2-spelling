const ZERO_SHA = '0'.repeat(40);

export const F0_ONLY_FILES = Object.freeze([
  'AGENTS.md',
  'README.md',
  '.github/pull_request_template.md',
  'docs/agents/ai-sdlc.md',
  'docs/agents/domain.md',
  'docs/agents/issue-tracker.md',
  'docs/agents/triage-labels.md',
]);

function normalisePath(path) {
  return String(path ?? '')
    .replaceAll('\\', '/')
    .replace(/^\.\//u, '');
}

export function presentFocusSha(value) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed || trimmed === ZERO_SHA) return '';
  return trimmed;
}

export function pathIsF0OnlyDocumentation(
  path,
  { files = F0_ONLY_FILES } = {},
) {
  const candidate = normalisePath(path);
  if (
    !candidate ||
    candidate.startsWith('/') ||
    candidate.split('/').includes('..')
  ) {
    return false;
  }
  return files.includes(candidate);
}

export function decidePrFocusGate({
  eventName = '',
  baseSha = null,
  changedPaths = null,
  files = F0_ONLY_FILES,
} = {}) {
  if (eventName !== 'pull_request') {
    return {
      product: true,
      gates: 'F0,F1,F2',
      reason: 'integration-event',
      baseSha: presentFocusSha(baseSha ?? '') || null,
    };
  }
  const resolvedBase = presentFocusSha(baseSha ?? '');
  if (!resolvedBase) {
    return {
      product: true,
      gates: 'F0,F1,F2',
      reason: 'unresolved-base',
      baseSha: null,
    };
  }
  if (!Array.isArray(changedPaths)) {
    return {
      product: true,
      gates: 'F0,F1,F2',
      reason: 'unresolved-diff',
      baseSha: resolvedBase,
    };
  }
  if (changedPaths.length === 0) {
    return {
      product: true,
      gates: 'F0,F1,F2',
      reason: 'empty-diff',
      baseSha: resolvedBase,
    };
  }
  if (
    changedPaths.every((path) =>
      pathIsF0OnlyDocumentation(path, { files }),
    )
  ) {
    return {
      product: false,
      gates: 'F0',
      reason: 'safe-documentation-only',
      baseSha: resolvedBase,
    };
  }
  return {
    product: true,
    gates: 'F0,F1,F2',
    reason: 'product-or-governed-input',
    baseSha: resolvedBase,
  };
}
