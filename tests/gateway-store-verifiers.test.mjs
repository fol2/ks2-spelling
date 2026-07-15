import assert from 'node:assert/strict';
import test from 'node:test';

const APPLE_PRODUCT = 'uk.eugnel.ks2spelling.fullks2';
const GOOGLE_PRODUCT = 'full_ks2';
const APPLICATION_ID = 'uk.eugnel.ks2spelling';

test('Apple verifies submitted JWS and then derives truth from a live sandbox lookup', async () => {
  const { createAppleStoreVerifier } = await import('../gateway/src/apple-store-verifier.js');
  const decoded = {
    transactionId: '123456789012345',
    productId: APPLE_PRODUCT,
    bundleId: APPLICATION_ID,
    environment: 'Sandbox',
  };
  const calls = [];
  const verifier = createAppleStoreVerifier({
    applicationId: APPLICATION_ID,
    environment: 'sandbox',
    signedDataVerifier: { verifyAndDecodeTransaction: async (jws) => {
      calls.push(['jws', jws]);
      return decoded;
    } },
    apiClient: { getTransactionInfo: async (id) => {
      calls.push(['api', id]);
      return { signedTransactionInfo: 'live-signed-transaction' };
    } },
  });
  const result = await verifier.verify({ productId: APPLE_PRODUCT, opaqueProof: 'submitted-jws' });
  assert.deepEqual(calls, [
    ['jws', 'submitted-jws'],
    ['api', '123456789012345'],
    ['jws', 'live-signed-transaction'],
  ]);
  assert.deepEqual(result, {
    store: 'apple', productId: APPLE_PRODUCT, environment: 'sandbox',
    applicationId: APPLICATION_ID, entitlementId: 'full-ks2', state: 'active',
    storeTransactionId: '123456789012345', opaqueProof: 'submitted-jws',
  });

  decoded.revocationDate = 1_782_865_800_000;
  assert.equal((await verifier.refresh({ productId: APPLE_PRODUCT, opaqueProof: 'submitted-jws' })).state, 'revoked');
});

test('Apple fails closed on client/live identity mismatch and unsafe transaction IDs', async () => {
  const { createAppleStoreVerifier } = await import('../gateway/src/apple-store-verifier.js');
  const submitted = {
    transactionId: '12345', productId: APPLE_PRODUCT,
    bundleId: APPLICATION_ID, environment: 'Sandbox',
  };
  const live = { ...submitted };
  const verifier = createAppleStoreVerifier({
    applicationId: APPLICATION_ID,
    environment: 'sandbox',
    signedDataVerifier: { verifyAndDecodeTransaction: async (jws) => jws === 'submitted' ? submitted : live },
    apiClient: { getTransactionInfo: async () => ({ signedTransactionInfo: 'live' }) },
  });
  for (const mutate of [
    () => { live.transactionId = '54321'; },
    () => { live.productId = 'other'; },
    () => { live.bundleId = 'other.app'; },
    () => { live.environment = 'Production'; },
    () => { live.transactionId = 'submitted'; },
  ]) {
    Object.assign(live, submitted);
    mutate();
    await assert.rejects(verifier.verify({ productId: APPLE_PRODUCT, opaqueProof: 'submitted' }), (error) => {
      assert.doesNotMatch(error.message, /submitted|live|12345|54321/);
      return true;
    });
  }
});

function googlePurchase(overrides = {}) {
  return {
    productLineItem: [{ productId: GOOGLE_PRODUCT }],
    purchaseStateContext: { purchaseState: 'PURCHASED' },
    testPurchaseContext: { fopType: 'TEST' },
    orderId: 'GPA.1234-5678-9012-34567',
    acknowledgementState: 'ACKNOWLEDGEMENT_STATE_PENDING',
    ...overrides,
  };
}

test('Google obtains OAuth, queries ProductPurchaseV2 and acknowledges only verified test purchases', async () => {
  const { createGoogleStoreVerifier } = await import('../gateway/src/google-store-verifier.js');
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push([url, init]);
    if (url === 'https://oauth2.googleapis.com/token') {
      return Response.json({ access_token: 'short-lived-access', expires_in: 3600 });
    }
    if (url.includes('/purchases/productsv2/tokens/')) return Response.json(googlePurchase());
    if (url.endsWith(':acknowledge')) return new Response(null, { status: 204 });
    throw new Error('unexpected');
  };
  const verifier = createGoogleStoreVerifier({
    applicationId: APPLICATION_ID,
    environment: 'sandbox',
    serviceAccount: {
      client_email: 'gateway@example.iam.gserviceaccount.com',
      private_key: 'test-private-key',
      token_uri: 'https://oauth2.googleapis.com/token',
    },
    jwtSigner: async () => 'signed-service-account-jwt',
    fetchImpl,
    clock: () => 1_782_865_800_000,
  });
  const verified = await verifier.verify({ productId: GOOGLE_PRODUCT, opaqueProof: 'purchase-token' });
  assert.equal(verified.storeTransactionId, 'GPA.1234-5678-9012-34567');
  assert.equal(verified.state, 'active');
  assert.equal(calls.filter(([url]) => url.includes(':acknowledge')).length, 0);
  const completed = await verifier.complete({ productId: GOOGLE_PRODUCT, opaqueProof: 'purchase-token' });
  assert.equal(completed.acknowledged, true);
  assert.equal(calls.filter(([url]) => url.includes(':acknowledge')).length, 1);
  assert.match(calls[1][0], /applications\/uk\.eugnel\.ks2spelling\/purchases\/productsv2\/tokens\/purchase-token$/);
  assert.equal(calls[1][1].headers.Authorization, 'Bearer short-lived-access');
  assert.equal(calls.every(([, init]) => init.redirect === 'manual'), true);
});

test('Google enforces exact package/product/state/test context and safe order ID', async () => {
  const { createGoogleStoreVerifier } = await import('../gateway/src/google-store-verifier.js');
  let purchase = googlePurchase();
  const verifier = createGoogleStoreVerifier({
    applicationId: APPLICATION_ID,
    environment: 'sandbox',
    serviceAccount: { client_email: 'x@example.test', private_key: 'x', token_uri: 'https://oauth2.googleapis.com/token' },
    jwtSigner: async () => 'jwt',
    fetchImpl: async (url) => url.includes('oauth2')
      ? Response.json({ access_token: 'access', expires_in: 3600 })
      : Response.json(purchase),
    clock: () => 1,
  });
  for (const value of [
    googlePurchase({ productLineItem: [{ productId: 'other' }] }),
    googlePurchase({ testPurchaseContext: { fopType: 'CARD' } }),
    googlePurchase({ orderId: 'purchase-token' }),
    googlePurchase({ orderId: 'GPA.not-safe' }),
  ]) {
    purchase = value;
    await assert.rejects(verifier.verify({ productId: GOOGLE_PRODUCT, opaqueProof: 'purchase-token' }));
  }
  purchase = googlePurchase({ purchaseStateContext: { purchaseState: 'PENDING' }, orderId: undefined });
  const pending = await verifier.refresh({ productId: GOOGLE_PRODUCT, opaqueProof: 'purchase-token' });
  assert.equal(pending.state, 'pending');
  await assert.rejects(verifier.complete({ productId: GOOGLE_PRODUCT, opaqueProof: 'purchase-token' }));

  purchase = googlePurchase({ purchaseStateContext: { purchaseState: 'CANCELLED' } });
  const revoked = await verifier.refresh({ productId: GOOGLE_PRODUCT, opaqueProof: 'purchase-token' });
  assert.equal(revoked.state, 'revoked');
  assert.equal(revoked.storeTransactionId, 'GPA.1234-5678-9012-34567');
});

test('store credential and rate-limit failures remain retryable and sanitised', async () => {
  const { createAppleStoreVerifier } = await import('../gateway/src/apple-store-verifier.js');
  const apple = createAppleStoreVerifier({
    applicationId: APPLICATION_ID,
    environment: 'sandbox',
    signedDataVerifier: { verifyAndDecodeTransaction: async () => ({
      transactionId: '12345', productId: APPLE_PRODUCT,
      bundleId: APPLICATION_ID, environment: 'Sandbox',
    }) },
    apiClient: { getTransactionInfo: async () => {
      throw Object.assign(new Error('secret upstream detail'), { httpStatusCode: 429 });
    } },
  });
  await assert.rejects(
    apple.verify({ productId: APPLE_PRODUCT, opaqueProof: 'submitted-secret' }),
    (error) => error.code === 'STORE_UNAVAILABLE' && error.retryable === true && !/secret/i.test(error.message),
  );

  const appleTimeout = createAppleStoreVerifier({
    applicationId: APPLICATION_ID,
    environment: 'sandbox',
    signedDataVerifier: { verifyAndDecodeTransaction: async () => ({
      transactionId: '12345', productId: APPLE_PRODUCT,
      bundleId: APPLICATION_ID, environment: 'Sandbox',
    }) },
    apiClient: { getTransactionInfo: async () => {
      throw Object.assign(new Error('private timeout detail'), { httpStatusCode: 408 });
    } },
  });
  await assert.rejects(
    appleTimeout.verify({ productId: APPLE_PRODUCT, opaqueProof: 'submitted-secret' }),
    (error) => error.code === 'STORE_UNAVAILABLE' && error.retryable === true && !/timeout/i.test(error.message),
  );

  const appleNetwork = createAppleStoreVerifier({
    applicationId: APPLICATION_ID,
    environment: 'sandbox',
    signedDataVerifier: { verifyAndDecodeTransaction: async () => ({
      transactionId: '12345', productId: APPLE_PRODUCT,
      bundleId: APPLICATION_ID, environment: 'Sandbox',
    }) },
    apiClient: { getTransactionInfo: async () => { throw new TypeError('private DNS detail'); } },
  });
  await assert.rejects(
    appleNetwork.verify({ productId: APPLE_PRODUCT, opaqueProof: 'submitted-secret' }),
    (error) => error.code === 'STORE_UNAVAILABLE' && error.retryable === true && !/DNS/i.test(error.message),
  );

  const appleOcsp = createAppleStoreVerifier({
    applicationId: APPLICATION_ID,
    environment: 'sandbox',
    signedDataVerifier: { verifyAndDecodeTransaction: async () => {
      throw Object.assign(new Error('private OCSP detail'), { status: 2 });
    } },
    apiClient: { getTransactionInfo: async () => assert.fail('must not query') },
  });
  await assert.rejects(
    appleOcsp.verify({ productId: APPLE_PRODUCT, opaqueProof: 'submitted-secret' }),
    (error) => error.code === 'STORE_UNAVAILABLE' && error.retryable === true && !/OCSP/i.test(error.message),
  );

  const { createGoogleStoreVerifier } = await import('../gateway/src/google-store-verifier.js');
  const google = createGoogleStoreVerifier({
    applicationId: APPLICATION_ID,
    environment: 'sandbox',
    serviceAccount: { client_email: 'x@example.test', private_key: 'x', token_uri: 'https://oauth2.googleapis.com/token' },
    jwtSigner: async () => 'jwt',
    fetchImpl: async () => new Response('private credential detail', { status: 429 }),
    clock: () => 1,
  });
  await assert.rejects(
    google.verify({ productId: GOOGLE_PRODUCT, opaqueProof: 'purchase-token' }),
    (error) => error.code === 'STORE_UNAVAILABLE' && error.retryable === true && !/credential/i.test(error.message),
  );

  const googleTimeout = createGoogleStoreVerifier({
    applicationId: APPLICATION_ID,
    environment: 'sandbox',
    serviceAccount: { client_email: 'x@example.test', private_key: 'x', token_uri: 'https://oauth2.googleapis.com/token' },
    jwtSigner: async () => 'jwt',
    fetchImpl: async (url) => url.includes('oauth2')
      ? Response.json({ access_token: 'access', expires_in: 3600 })
      : new Response('private timeout detail', { status: 408 }),
    clock: () => 1,
  });
  await assert.rejects(
    googleTimeout.verify({ productId: GOOGLE_PRODUCT, opaqueProof: 'purchase-token' }),
    (error) => error.code === 'STORE_UNAVAILABLE' && error.retryable === true && !/timeout/i.test(error.message),
  );
});

test('Google refuses OAuth, purchase and acknowledgement redirects without following them', async () => {
  const { createGoogleStoreVerifier } = await import('../gateway/src/google-store-verifier.js');
  for (const redirectAt of ['oauth', 'purchase', 'acknowledge']) {
    const calls = [];
    const verifier = createGoogleStoreVerifier({
      applicationId: APPLICATION_ID,
      environment: 'sandbox',
      serviceAccount: { client_email: 'x@example.test', private_key: 'x', token_uri: 'https://oauth2.googleapis.com/token' },
      jwtSigner: async () => 'jwt',
      fetchImpl: async (url, init) => {
        calls.push([url, init]);
        if (redirectAt === 'oauth' && url.includes('oauth2')) return new Response(null, { status: 302 });
        if (url.includes('oauth2')) return Response.json({ access_token: 'access', expires_in: 3600 });
        if (redirectAt === 'purchase' && url.includes('/productsv2/')) return new Response(null, { status: 302 });
        if (url.includes('/productsv2/')) return Response.json(googlePurchase());
        return new Response(null, { status: redirectAt === 'acknowledge' ? 302 : 204 });
      },
      clock: () => 1,
    });
    const operation = redirectAt === 'acknowledge' ? verifier.complete : verifier.verify;
    await assert.rejects(
      operation({ productId: GOOGLE_PRODUCT, opaqueProof: 'purchase-token' }),
      (error) => error.code === 'STORE_UNAVAILABLE' && error.retryable === true,
    );
    assert.equal(calls.every(([, init]) => init.redirect === 'manual'), true);
  }
});
