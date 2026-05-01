# Remote Control Relay

This package contains the plain Cloudflare Worker relay for Remote Control. It intentionally avoids a web framework so the hosted code path is small and easy to audit.

## Self-Hosting

Before starting, you need a Cloudflare account, a Sendblue account with an iMessage-capable number, and Node/pnpm installed locally.

1. Install dependencies from the repo root.

   ```bash
   pnpm install
   ```

2. Log in to Cloudflare.

   ```bash
   cd relay
   pnpm exec wrangler login
   ```

3. Create a Cloudflare D1 database for routing metadata.

   ```bash
   pnpm exec wrangler d1 create remote-control
   ```

4. Copy the returned `database_id` into `wrangler.jsonc`.

5. Update `SENDBLUE_FROM_NUMBER` in `wrangler.jsonc` to your Sendblue number.

6. Apply metadata migrations.

   ```bash
   pnpm exec wrangler d1 migrations apply remote-control --remote
   ```

7. Set Sendblue secrets.

   ```bash
   pnpm exec wrangler secret put SENDBLUE_API_KEY
   pnpm exec wrangler secret put SENDBLUE_SECRET_KEY
   pnpm exec wrangler secret put SENDBLUE_WEBHOOK_SECRET
   ```

   `SENDBLUE_WEBHOOK_SECRET` can be any strong random string you choose. Use the same value when configuring the Sendblue webhook signing secret.

8. Deploy.

   ```bash
   pnpm exec wrangler deploy
   ```

9. In Sendblue, set the inbound webhook URL to:

   ```text
   https://<your-worker-url>/webhooks/sendblue
   ```

10. Install and configure the skill against your relay.

   ```bash
   $skill-installer install https://github.com/gragland/remote-control/tree/main/remote-control
   ```

   Then ask Codex: `Remote Control use my self-hosted relay at https://<your-worker-url>`

## Configuration

`wrangler.jsonc` contains non-secret defaults:

- `SENDBLUE_FROM_NUMBER`
- `SENDBLUE_API_BASE_URL`
- `SENDBLUE_TYPING_DELAY_MS`

For self-hosting, change `SENDBLUE_FROM_NUMBER` to your Sendblue number before deploying. `SENDBLUE_API_BASE_URL` should usually stay as-is. Secrets must be configured with `wrangler secret put`.

## Custom Domain

After choosing a domain, add a Cloudflare custom domain route to `wrangler.jsonc`:

```jsonc
"routes": [
  { "pattern": "remote-control.example.com", "custom_domain": true }
]
```

Then redeploy with `pnpm exec wrangler deploy` and update the Sendblue webhook URL to the custom domain.

## API Summary

- `POST /installations`: returns a local install token.
- `POST /threads/:threadId`: registers or re-enables a Codex thread.
- `POST /threads/:threadId/status`: forwards Codex output, progress updates, and generated images to iMessage without storing the outbound content.
- `GET /threads/:threadId/events`: WebSocket delivery events backed by the relay Durable Object.
- `POST /threads/:threadId/replies/:replyId/claim`: claims one reply or media group.
- `GET /threads/:threadId`: debug thread state.
- `POST /threads/:threadId/stop`: disables remote control for a thread.
- `POST /webhooks/sendblue`: receives Sendblue inbound events.

All non-webhook thread APIs use `Authorization: Bearer <token>`. When a user pairs by texting the code, the relay links that token to their phone number.

The relay stores the minimum data needed to route messages. Cloudflare D1 is still required for routing metadata such as thread state, pairing state, and phone bindings, but message content is never stored there. Inbound message content is held only in the Durable Object's in-memory buffer while pending, then scrubbed when local Codex claims it. Outbound Codex replies are forwarded to Sendblue and are not stored by the relay.

Cloudflare persisted logging is disabled for this Worker in `wrangler.jsonc`. Keep Worker logs, log exports, Tail Workers, and tracing off in production unless the full pipeline is reviewed first. Message bodies are never placed in URLs, and relay warnings intentionally avoid logging Sendblue response payloads because provider error payloads could echo message content.

## Development

```bash
pnpm --filter @gaberagland/remote-control-relay test
pnpm --filter @gaberagland/remote-control-relay typecheck
pnpm --filter @gaberagland/remote-control-relay dev
```

`src/worker.ts` is the Worker entrypoint and contains the route handling directly.
