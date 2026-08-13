export const MAX_GATEWAY_BODY_BYTES = 65_536;
// The base64 signed manifest envelope is the only field in any gateway
// response that can exceed the 64 KiB body cap; entitlement-gateway-port
// bounds that field with this constant, and pack-activation-coordinator
// applies the same bound to the envelope it activates.
export const MAX_SIGNED_ENVELOPE_BASE64_CHARS = 1_048_576;
// The authorise response is exactly that field plus an ordinary gateway
// record, so its bound is derived from the field bound rather than guessed
// alongside it: a body that passes this cap can still be rejected by the
// stricter field cap, never the reverse. Every other route keeps 64 KiB.
// Real shard envelopes are ~141 KB of base64, an order of magnitude inside
// both. (The registry's 1 MiB *envelope* bound would base64 to 1,398,104
// chars; the client's field bound is the stricter of the two and therefore
// the one that governs.)
export const MAX_AUTHORISE_RESPONSE_BYTES =
  MAX_SIGNED_ENVELOPE_BASE64_CHARS + MAX_GATEWAY_BODY_BYTES;
export const MAX_OPAQUE_PROOF_CHARS = 48_000;
export const MAX_SEALED_REFRESH_HANDLE_CHARS = 64_500;
export const MAX_REFRESH_HANDLE_VERSION = 2_147_483_647;

// Apple compact JWS and opaque store tokens are visible ASCII. Excluding quote
// and backslash makes their character count equal their JSON and UTF-8 byte count.
export const OPAQUE_PROOF_PATTERN = /^[\x21\x23-\x5B\x5D-\x7E]+$/;

export function gatewayJsonByteLength(value) {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}
