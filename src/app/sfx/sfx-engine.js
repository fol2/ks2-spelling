/**
 * WebAudio-only product SFX runtime.
 * Never touches HTMLAudioElement or the shared dictation player — that element
 * stays reserved for speech (WebKit crash mitigation).
 */

import { PRODUCT_SFX_MANIFEST, sfxGateDecision } from './sfx-model.js';

async function digestSha256Hex(bytes) {
  const digest = new Uint8Array(
    await globalThis.crypto.subtle.digest('SHA-256', bytes),
  );
  return [...digest]
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('');
}

function resolveAssetUrl(path) {
  const base =
    typeof document !== 'undefined' && typeof document.baseURI === 'string'
      ? document.baseURI
      : 'http://localhost/';
  return new URL(path, base).href;
}

/**
 * @param {{
 *   manifest?: typeof PRODUCT_SFX_MANIFEST,
 *   fetchImpl?: typeof fetch,
 *   createContext?: () => AudioContext,
 *   lifecycle?: { subscribe: (listener: (state: { isActive?: boolean }) => void) => (() => void) } | null,
 *   initiallyEnabled?: boolean,
 *   now?: () => number,
 * }} [options]
 */
export function createSfxEngine({
  manifest = PRODUCT_SFX_MANIFEST,
  fetchImpl = globalThis.fetch?.bind(globalThis),
  createContext,
  lifecycle = null,
  initiallyEnabled = true,
  now = Date.now,
} = {}) {
  if (!manifest || typeof manifest !== 'object') {
    throw new TypeError('SFX engine requires a manifest.');
  }
  if (typeof fetchImpl !== 'function') {
    throw new TypeError('SFX engine requires a fetchImpl.');
  }
  if (typeof createContext !== 'function') {
    throw new TypeError('SFX engine requires createContext().');
  }
  if (typeof now !== 'function') {
    throw new TypeError('SFX engine requires an injected now() clock.');
  }

  let enabled = initiallyEnabled === true;
  let unlocked = false;
  let speechUntil = 0;
  let context = null;
  let disposed = false;
  let unlockTarget = null;
  let unlockHandler = null;
  let lifecycleUnsubscribe = null;
  let decodeStarted = false;
  const buffers = new Map();

  function clearUnlockListeners() {
    if (!unlockTarget || !unlockHandler) return;
    unlockTarget.removeEventListener('pointerdown', unlockHandler, true);
    unlockTarget.removeEventListener('keydown', unlockHandler, true);
    unlockTarget = null;
    unlockHandler = null;
  }

  async function verifyAndDecode(name, entry) {
    const response = await fetchImpl(resolveAssetUrl(entry.path));
    const isCapacitorStatusZero =
      typeof response?.url === 'string' &&
      response.url.startsWith('capacitor:') &&
      response?.ok === false &&
      response?.status === 0;
    if (
      !response ||
      typeof response.arrayBuffer !== 'function' ||
      (response.ok !== true && !isCapacitorStatusZero)
    ) {
      return;
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength !== entry.byteSize) return;
    const actualDigest = await digestSha256Hex(bytes);
    if (actualDigest !== entry.sha256) return;
    if (!context || disposed) return;
    const copy = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const buffer = await context.decodeAudioData(copy);
    if (disposed) return;
    buffers.set(name, buffer);
  }

  function kickOffDecode() {
    if (decodeStarted || disposed || !context) return;
    decodeStarted = true;
    for (const [name, entry] of Object.entries(manifest)) {
      void verifyAndDecode(name, entry).catch(() => {
        // Missing or drifted assets stay silent — never throw into UI.
      });
    }
  }

  async function ensureContextRunning() {
    if (disposed) return false;
    if (!context) {
      context = createContext();
    }
    if (!context) return false;
    if (context.state === 'suspended' && typeof context.resume === 'function') {
      try {
        await context.resume();
      } catch {
        return context.state === 'running';
      }
    }
    return context.state === 'running';
  }

  async function unlockFromGesture() {
    if (disposed) return;
    const running = await ensureContextRunning();
    kickOffDecode();
    if (running) {
      unlocked = true;
      clearUnlockListeners();
    }
  }

  function onLifecycle(state) {
    if (disposed || !context) return;
    if (state?.isActive) {
      if (unlocked && context.state === 'suspended' && typeof context.resume === 'function') {
        void context.resume().catch(() => {});
      }
      return;
    }
    if (typeof context.suspend === 'function' && context.state === 'running') {
      void context.suspend().catch(() => {});
    }
  }

  if (lifecycle && typeof lifecycle.subscribe === 'function') {
    lifecycleUnsubscribe = lifecycle.subscribe(onLifecycle);
  }

  return Object.freeze({
    attachGestureUnlock(target) {
      if (disposed || !target || typeof target.addEventListener !== 'function') return;
      if (unlockHandler) clearUnlockListeners();
      unlockHandler = () => {
        void unlockFromGesture();
      };
      unlockTarget = target;
      // Capture + passive only. Never steal focus, cancel the event, or stop
      // bubbling — keyboard safety by construction.
      target.addEventListener('pointerdown', unlockHandler, { capture: true, passive: true });
      target.addEventListener('keydown', unlockHandler, { capture: true, passive: true });
    },

    play(name) {
      if (disposed) return;
      const entry = manifest[name];
      if (!entry) return;
      const decision = sfxGateDecision({
        name,
        tier: entry.tier,
        enabled,
        unlocked,
        speechUntil,
        now: now(),
      });
      if (!decision.play) return;
      const buffer = buffers.get(name);
      if (!buffer || !context) return;
      try {
        // WebKit reports 'suspended' until gesture-driven resume completes,
        // yet a BufferSource started on a suspended context queues and plays at
        // resume. Request resume and start optimistically.
        if (context.state !== 'running' && typeof context.resume === 'function') {
          void context.resume();
        }
        const source = context.createBufferSource();
        source.buffer = buffer;
        const gainNode = context.createGain();
        const adjust = typeof decision.gainAdjust === 'number' ? decision.gainAdjust : 1;
        gainNode.gain.value = entry.gain * adjust;
        source.connect(gainNode);
        gainNode.connect(context.destination);
        source.start(0);
      } catch {
        // Fire-and-forget: any runtime fault is a silent no-op.
      }
    },

    noteSpeechStarted(holdMs) {
      if (disposed) return;
      const hold = typeof holdMs === 'number' && Number.isFinite(holdMs) ? holdMs : 0;
      speechUntil = now() + Math.max(0, hold);
    },

    setEnabled(value) {
      enabled = value === true;
    },

    isEnabled() {
      return enabled;
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      unlocked = false;
      clearUnlockListeners();
      if (typeof lifecycleUnsubscribe === 'function') {
        try {
          lifecycleUnsubscribe();
        } catch {
          // Ignore unsubscribe faults during teardown.
        }
        lifecycleUnsubscribe = null;
      }
      buffers.clear();
      const closing = context;
      context = null;
      if (closing && typeof closing.close === 'function') {
        void closing.close().catch(() => {});
      }
    },
  });
}
