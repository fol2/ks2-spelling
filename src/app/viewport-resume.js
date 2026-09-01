const SCALE_EPSILON = 0.01;
const OFFSET_EPSILON = 1;
const HEIGHT_GAP_PX = 8;

function numberOr(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export function readViewportSnapshot(env = globalThis) {
  const visualViewport = env.visualViewport;
  return Object.freeze({
    scale: numberOr(visualViewport?.scale, 1),
    offsetTop: numberOr(visualViewport?.offsetTop, 0),
    offsetLeft: numberOr(visualViewport?.offsetLeft, 0),
    scrollX: numberOr(env.scrollX, 0),
    scrollY: numberOr(env.scrollY, 0),
    visualWidth: numberOr(visualViewport?.width, numberOr(env.innerWidth, 0)),
    visualHeight: numberOr(visualViewport?.height, numberOr(env.innerHeight, 0)),
    layoutWidth: numberOr(env.innerWidth, 0),
    layoutHeight: numberOr(env.innerHeight, 0),
  });
}

export function viewportNeedsReset(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return false;
  if (Math.abs(numberOr(snapshot.scale, 1) - 1) > SCALE_EPSILON) return true;
  if (Math.abs(numberOr(snapshot.offsetTop, 0)) > OFFSET_EPSILON) return true;
  if (Math.abs(numberOr(snapshot.offsetLeft, 0)) > OFFSET_EPSILON) return true;
  if (Math.abs(numberOr(snapshot.scrollX, 0)) > OFFSET_EPSILON) return true;
  if (Math.abs(numberOr(snapshot.scrollY, 0)) > OFFSET_EPSILON) return true;
  const visualHeight = numberOr(snapshot.visualHeight, 0);
  const layoutHeight = numberOr(snapshot.layoutHeight, 0);
  if (visualHeight <= 0 || layoutHeight <= 0) return false;
  const covered = visualHeight + Math.max(0, numberOr(snapshot.offsetTop, 0));
  return layoutHeight - covered > HEIGHT_GAP_PX;
}

function restoreAuthoredViewportMeta(document) {
  const meta = document?.querySelector?.('meta[name="viewport"]');
  if (!meta || typeof meta.getAttribute !== 'function' || typeof meta.setAttribute !== 'function') {
    return;
  }
  const original = meta.getAttribute('content');
  if (typeof original !== 'string' || original.length === 0) return;
  const withoutMax = original
    .replace(/,?\s*maximum-scale\s*=\s*[^,]+/gi, '')
    .replace(/,\s*,/g, ',')
    .replace(/^\s*,\s*|\s*,\s*$/g, '');
  meta.setAttribute('content', `${withoutMax}, maximum-scale=1.0`);
  meta.setAttribute('content', original);
}

export function resetProductViewport(env = globalThis) {
  const document = env.document;
  if (document?.visibilityState === 'hidden') return;
  const active = document?.activeElement;
  if (typeof env.scrollTo === 'function') env.scrollTo(0, 0);
  restoreAuthoredViewportMeta(document);
  if (active && active !== document?.body && typeof active.focus === 'function') {
    active.focus({ preventScroll: true });
  }
}

export function installViewportResume(env = globalThis) {
  if (env.__ks2ViewportResumeInstalled === true) {
    return env.__ks2ResetProductViewport;
  }
  const run = (force) => {
    if (!force && !viewportNeedsReset(readViewportSnapshot(env))) return;
    resetProductViewport(env);
  };
  env.__ks2ViewportResumeInstalled = true;
  env.__ks2ResetProductViewport = () => run(true);
  env.document?.addEventListener?.('visibilitychange', () => {
    if (env.document?.visibilityState === 'visible') run(true);
  });
  env.addEventListener?.('pageshow', (event) => {
    run(event?.persisted === true);
  });
  return env.__ks2ResetProductViewport;
}
