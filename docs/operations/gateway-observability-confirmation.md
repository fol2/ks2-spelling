# Confirming the gateway's log settings after a deploy

The App Privacy declaration ("Data Not Collected") depends on the **deployed**
worker, not on the tracked config: platform invocation logs record the full
request URL — on the download route that includes the signed `?cap=` capability
token — into a 3–7 day store (#158, compliance position Gap 2). The tracked and
derived configs disable invocation logs and keep redacted application logs on;
this page is the step that closes the loop against the live worker.

## When

After every owner-run `wrangler deploy` from `gateway/` (the deploy applies
`wrangler.jsonc`, so the setting travels with it — this is a confirmation, not
an extra change).

## How

Either of:

1. **Dashboard** — Workers & Pages → `ks2-spelling-b3-sandbox` →
   Observability: *Worker Logs* enabled, *Invocation Logs* disabled.
2. **API (read-only, agent-executable)** —

   ```sh
   curl -s -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
     "https://api.cloudflare.com/client/v4/accounts/6d00cb4a0396c17ad6ba617bcbcaa45d/workers/scripts/ks2-spelling-b3-sandbox/script-settings" \
     | jq '.result.observability'
   ```

   Expected: `"enabled": true`, `"logs": { "enabled": true,
   "invocation_logs": false, ... }`.

## Record

Note the confirmation (date + deployed version id) in the deploy's record or
the issue that prompted the deploy. The tripwire test
(`tests/gateway-compliance-tripwire.test.mjs`) keeps the *tracked* facts true;
this confirmation is the only part that has to look at the live account.
