export default {
  async fetch(request, env) {
    if (new URL(request.url).pathname === '/google') {
      const { createGoogleStoreVerifier } = await import('../../../gateway/src/google-store-verifier.js');
      const verifier = createGoogleStoreVerifier({
        applicationId: 'uk.eugnel.ks2spelling',
        environment: 'sandbox',
        serviceAccount: {
          client_email: 'gateway@example.test',
          private_key: 'runtime-unused-key',
          token_uri: 'https://oauth2.googleapis.com/token',
        },
        jwtSigner: async () => 'runtime-jwt',
        fetchImpl: fetch,
        clock: () => 1_782_865_800_000,
      });
      const result = await verifier.complete({ productId: 'full_ks2', opaqueProof: 'runtime-token' });
      return Response.json({
        state: result.state,
        storeTransactionId: result.storeTransactionId,
        acknowledged: result.acknowledged,
      });
    }
    const {
      createWorkerAppleApiClient,
      createWorkerAppleSignedDataVerifier,
    } = await import('../../../gateway/src/apple-store-verifier.js');
    const [client, verifier] = await Promise.all([createWorkerAppleApiClient({
      privateKey: env.APPLE_TEST_PRIVATE_KEY,
      keyId: 'KEYID12345',
      issuerId: '00000000-0000-4000-8000-000000000000',
      applicationId: 'uk.eugnel.ks2spelling',
    }), createWorkerAppleSignedDataVerifier('uk.eugnel.ks2spelling')]);
    return Response.json({
      transactionInfo: await client.getTransactionInfo('1234567890'),
      verifierAvailable: typeof verifier.verifyAndDecodeTransaction === 'function',
      verifierOnlineChecks: verifier.enableOnlineChecks,
    });
  },
};
