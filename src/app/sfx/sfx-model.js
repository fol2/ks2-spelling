/**
 * Pure product SFX decision model — no I/O, no Web Audio side effects.
 * Manifest hashes must match the bytes produced by scripts/generate-product-sfx.mjs.
 */

/** −10 dB linear multiplier used to duck feedback/celebration under dictation. */
export const SFX_SPEECH_DUCK_GAIN = 10 ** (-10 / 20);

export const PRODUCT_SFX_MANIFEST = Object.freeze({
  correct: Object.freeze({
    path: '/sfx/correct.wav',
    sha256: '74db88b68c73a79635738fd44831e891d02ec4e7ae342260628c3c655942d784',
    byteSize: 20204,
    gain: 0.35,
    tier: 'feedback',
  }),
  retry: Object.freeze({
    path: '/sfx/retry.wav',
    sha256: '912b5e9d79e72a0bfde076f0927c0754f83ea8272d5a9169ab895c5688f2dec4',
    byteSize: 14444,
    gain: 0.28,
    tier: 'feedback',
  }),
  catch: Object.freeze({
    path: '/sfx/catch.wav',
    sha256: '54951e53a0e89711741fc1cd20d90bbbe6f42e280a8f7abaa7aefa91742d57cc',
    byteSize: 33644,
    gain: 0.4,
    tier: 'celebration',
  }),
  evolve: Object.freeze({
    path: '/sfx/evolve.wav',
    sha256: 'b22a1448c52772f1d6bb7e9905ff6ad3a935dba3b1272144333ed93227ef2782',
    byteSize: 43244,
    gain: 0.45,
    tier: 'celebration',
  }),
  flourish: Object.freeze({
    path: '/sfx/flourish.wav',
    sha256: '376cff80b6ddd9e0dde280151bccb36c35a13418d8c8e486e56edce73a78de29',
    byteSize: 28844,
    gain: 0.42,
    tier: 'celebration',
  }),
  tick: Object.freeze({
    path: '/sfx/tick.wav',
    sha256: '4586d4fcb95209fc86e5e3382b15fd6a9daf1a397a33f670bb1674663c78d64e',
    byteSize: 3884,
    gain: 0.18,
    tier: 'ui',
  }),
  sheet: Object.freeze({
    path: '/sfx/sheet.wav',
    sha256: 'e4dfc71d330187b37a802d30399823fc490bc1db4a72db202069c8583aff9a5e',
    byteSize: 8684,
    gain: 0.22,
    tier: 'ui',
  }),
  stamp: Object.freeze({
    path: '/sfx/stamp.wav',
    sha256: 'a12b1321f36a700c8ae52960518e7e9d0da1d205d248d497536046af14ad46a6',
    byteSize: 19244,
    gain: 0.38,
    tier: 'celebration',
  }),
});

/**
 * Gate whether a named cue may play, and at what relative gain.
 *
 * @param {{
 *   name: string,
 *   tier: 'ui' | 'feedback' | 'celebration',
 *   enabled: boolean,
 *   unlocked: boolean,
 *   speechUntil: number,
 *   now: number,
 * }} input
 * @returns {{ play: boolean, gainAdjust?: number }}
 */
export function sfxGateDecision({ name: _name, tier, enabled, unlocked, speechUntil, now }) {
  if (!enabled || !unlocked) {
    return { play: false };
  }

  const inSpeechWindow =
    typeof speechUntil === 'number' &&
    Number.isFinite(speechUntil) &&
    typeof now === 'number' &&
    Number.isFinite(now) &&
    now < speechUntil;

  if (inSpeechWindow) {
    if (tier === 'ui') {
      return { play: false };
    }
    if (tier === 'feedback' || tier === 'celebration') {
      return { play: true, gainAdjust: SFX_SPEECH_DUCK_GAIN };
    }
    return { play: false };
  }

  return { play: true };
}
