import { safeGatewayError } from './store-verifier-port.js';

const APPLE_SANDBOX = 'Sandbox';
// @apple/app-store-server-library 3.1.0 VerificationStatus.RETRYABLE_VERIFICATION_FAILURE.
const APPLE_RETRYABLE_VERIFICATION_STATUS = 2;

function fail(code = 'PROOF_REJECTED') {
  throw safeGatewayError(code);
}

function assertOptions(options) {
  if (
    options === null || typeof options !== 'object' || options.applicationId !== 'uk.eugnel.ks2spelling' ||
    options.environment !== 'sandbox'
  ) fail();
  if (
    options.signedDataVerifier !== undefined &&
    typeof options.signedDataVerifier?.verifyAndDecodeTransaction !== 'function'
  ) fail();
  if (options.apiClient !== undefined && typeof options.apiClient?.getTransactionInfo !== 'function') fail();
  return options;
}

export async function createWorkerAppleSignedDataVerifier(applicationId) {
  const [{ Environment, SignedDataVerifier }, rootModule] = await Promise.all([
    import('@apple/app-store-server-library'),
    import('../config/apple-root-certificates/AppleRootCA-G3.der'),
  ]);
  const rootBytes = rootModule.default instanceof ArrayBuffer
    ? new Uint8Array(rootModule.default)
    : rootModule.default;
  if (!(rootBytes instanceof Uint8Array) || rootBytes.byteLength === 0) fail('STORE_UNAVAILABLE');
  return new SignedDataVerifier(
    [Buffer.from(rootBytes)],
    false,
    Environment.SANDBOX,
    applicationId,
  );
}

export async function createWorkerAppleApiClient(options, fetchImpl = fetch) {
  for (const key of ['privateKey', 'keyId', 'issuerId']) {
    if (typeof options[key] !== 'string' || options[key].length === 0) fail('STORE_UNAVAILABLE');
  }
  if (typeof fetchImpl !== 'function') fail('STORE_UNAVAILABLE');
  const { AppStoreServerAPIClient, Environment } = await import('@apple/app-store-server-library');
  class WorkerAppStoreServerAPIClient extends AppStoreServerAPIClient {
    async makeFetchRequest(path, queryParameters, method, requestBody, headers) {
      const url = new URL(path, this.urlBase);
      url.search = queryParameters.toString();
      const response = await fetchImpl(url, {
        method,
        headers,
        body: requestBody,
        redirect: 'manual',
      });
      if (response.status >= 300 && response.status < 400) fail('STORE_UNAVAILABLE');
      return response;
    }
  }
  return new WorkerAppStoreServerAPIClient(
    options.privateKey,
    options.keyId,
    options.issuerId,
    options.applicationId,
    Environment.SANDBOX,
  );
}

function validateTransaction(value, { applicationId, productId }) {
  if (
    value === null || typeof value !== 'object' || value.bundleId !== applicationId ||
    value.productId !== productId || value.environment !== APPLE_SANDBOX ||
    typeof value.transactionId !== 'string' || !/^[1-9][0-9]{0,31}$/.test(value.transactionId)
  ) fail(value?.productId !== productId ? 'PRODUCT_MISMATCH' : 'PROOF_REJECTED');
  return value;
}

function isRetryableStoreError(error) {
  const status = error?.httpStatusCode ?? error?.status;
  return error instanceof TypeError || error?.name === 'AbortError' ||
    error?.status === APPLE_RETRYABLE_VERIFICATION_STATUS ||
    status === 401 || status === 403 || status === 408 || status === 429 || status >= 500;
}

export function createAppleStoreVerifier(rawOptions) {
  const options = assertOptions(rawOptions);
  let officialDependencies;
  async function dependencies() {
    if (options.signedDataVerifier && options.apiClient) {
      return { signedDataVerifier: options.signedDataVerifier, apiClient: options.apiClient };
    }
    officialDependencies ??= Promise.all([
      options.signedDataVerifier ?? createWorkerAppleSignedDataVerifier(options.applicationId),
      options.apiClient ?? createWorkerAppleApiClient(options),
    ]).then(([signedDataVerifier, apiClient]) => ({ signedDataVerifier, apiClient }));
    return officialDependencies;
  }

  async function liveVerify({ productId, opaqueProof }) {
    if (productId !== 'uk.eugnel.ks2spelling.fullks2' || typeof opaqueProof !== 'string' || opaqueProof.length === 0) {
      fail('PRODUCT_MISMATCH');
    }
    const { signedDataVerifier, apiClient } = await dependencies();
    async function decode(signedTransaction) {
      try {
        return validateTransaction(
          await signedDataVerifier.verifyAndDecodeTransaction(signedTransaction),
          { applicationId: options.applicationId, productId },
        );
      } catch (error) {
        if (error?.code && error?.status) throw error;
        fail(isRetryableStoreError(error) ? 'STORE_UNAVAILABLE' : 'PROOF_REJECTED');
      }
    }
    const submitted = await decode(opaqueProof);
    let response;
    try {
      response = await apiClient.getTransactionInfo(submitted.transactionId);
    } catch (error) {
      if (error?.code && error?.status) throw error;
      fail(isRetryableStoreError(error) ? 'STORE_UNAVAILABLE' : 'PROOF_REJECTED');
    }
    if (typeof response?.signedTransactionInfo !== 'string') fail();
    const live = await decode(response.signedTransactionInfo);
    if (live.transactionId !== submitted.transactionId) fail('PROOF_REJECTED');
    return Object.freeze({
      store: 'apple',
      productId,
      environment: 'sandbox',
      applicationId: options.applicationId,
      entitlementId: 'full-ks2',
      state: live.revocationDate === undefined || live.revocationDate === null ? 'active' : 'revoked',
      storeTransactionId: live.transactionId,
      opaqueProof,
    });
  }

  return Object.freeze({
    verify: liveVerify,
    refresh: liveVerify,
    complete: liveVerify,
  });
}
