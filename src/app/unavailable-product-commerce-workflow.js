function unavailableSnapshot() {
  return Object.freeze({
    displayPrice: '',
    entitlementState: 'none',
    packState: 'missing',
    syncFailed: true,
  });
}

export function createUnavailableProductCommerceWorkflow() {
  const snapshot = unavailableSnapshot();
  const unavailable = async () => {
    throw Object.assign(new Error('product_commerce_release_authority_unavailable'), {
      code: 'product_commerce_release_authority_unavailable',
    });
  };
  return Object.freeze({
    async start() { return snapshot; },
    async refresh() { return snapshot; },
    purchase: unavailable,
    restore: unavailable,
    download: unavailable,
    async recover() { return snapshot; },
    async dispose() {},
  });
}
