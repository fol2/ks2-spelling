function unsupported(operation) {
  const error = new Error(
    `Cloudflare OAuth/Wrangler cannot securely ${operation} with exact R2 custom metadata; provision an audited OAuth-capable Cloudflare API adapter before Task22.`,
  );
  error.code = 'b3_cloudflare_exact_r2_metadata_adapter_unavailable';
  throw error;
}

export function createDefaultB3CloudflarePrimitives() {
  const blocked = (operation) => async () => unsupported(operation);
  return Object.freeze({
    dryRunBundle: blocked('bind and retrieve the exact deployed Worker bundle'),
    deployExactBundle: blocked('deploy the exact bound Worker bundle'),
    inspectVersionApi: blocked('bind the deployed bytes to the Versions API identity'),
    inspectWorkerState: blocked('inspect complete Worker state'),
    inspectObject: blocked('read object bytes, ETag and exact custom metadata'),
    uploadObject: blocked('upload immutable objects with exact custom metadata'),
    smokeGateway: blocked('complete the authenticated live gateway smoke'),
  });
}
