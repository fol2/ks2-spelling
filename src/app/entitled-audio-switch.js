// Which catalogue a learner hears is an entitlement question, so it is answered
// by the same authority the Parent card reads: the commerce snapshot's
// {entitlementState, packState}. Only 'active' + 'installed' — the entitlement
// verified and every shard of the product installed — routes playback to the
// shard-backed Full player. Never purchased, revoked, mid-download or one shard
// short all keep the bundled Starter player, so a partial install can never
// serve half a catalogue.
//
// The learning catalogue (E2.7b) reads the same predicate rather than a second
// signal of its own, which is what makes the all-or-nothing shard rule cover
// both: the child is never shown a word this device cannot say.
export function isFullProductEntitled(state) {
  return state?.entitlementState === 'active' && state?.packState === 'installed';
}

export function createEntitledAudioSwitch({ starter, full, observe } = {}) {
  for (const [player, label] of [[starter, 'starter'], [full, 'full']]) {
    if (
      typeof player?.play !== 'function' ||
      typeof player?.dispose !== 'function'
    ) {
      throw new TypeError(`Entitled audio switch requires a ${label} player.`);
    }
  }
  if (typeof observe !== 'function') {
    throw new TypeError('Entitled audio switch requires an observe function.');
  }
  let entitled = false;
  const subscription = observe((state) => {
    entitled = isFullProductEntitled(state);
  });
  if (typeof subscription?.remove !== 'function') {
    throw new TypeError('Entitled audio switch requires a removable observation.');
  }
  return Object.freeze({
    play(request) {
      return (entitled ? full : starter).play(request);
    },
    async dispose() {
      subscription.remove();
      await starter.dispose();
      await full.dispose();
    },
  });
}
