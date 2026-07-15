export const MAX_GATEWAY_BODY_BYTES = 65_536;
export const MAX_OPAQUE_PROOF_CHARS = 48_000;
export const MAX_SEALED_REFRESH_HANDLE_CHARS = 64_500;
export const MAX_REFRESH_HANDLE_VERSION = 2_147_483_647;

// Apple compact JWS and opaque store tokens are visible ASCII. Excluding quote
// and backslash makes their character count equal their JSON and UTF-8 byte count.
export const OPAQUE_PROOF_PATTERN = /^[\x21\x23-\x5B\x5D-\x7E]+$/;

export function gatewayJsonByteLength(value) {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}
