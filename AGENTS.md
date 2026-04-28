# AGENTS: Remote Control

This is the standalone Remote Control repo, intended to become public before launch.

## Repo Shape

- `packages/skill`: installable Codex skill package.
- `packages/relay`: plain Cloudflare Worker relay deployed with Wrangler.
- This repo is now the source of truth. Do not continue feature work in the old monorepo `apps/codex-message` directory unless explicitly asked.

## Deployment

- Do not use Alchemy or the old monorepo CI helpers here.
- Deploy the relay manually with Wrangler from `packages/relay`.
- Secrets come from your shell/root env when running `wrangler secret put`; never commit populated `.env`, `.dev.vars`, or secret values.
- If Cloudflare bindings change, run `pnpm --filter @gaberagland/remote-control-relay types` after the Wrangler config is valid.
- If `wrangler deploy --dry-run` unexpectedly bundles old TanStack/assets output, delete ignored generated files under `packages/relay/.wrangler/` and `packages/relay/dist/`; Wrangler may be following a stale local deploy redirect.

## Gotchas

- The README install command `npx @gaberagland/remote-control install` is the intended public path, but it only works after the skill package is published to npm. Until then, treat it as launch-facing copy and use local package workflows for testing.
- The installer default relay is still a temporary hosted workers.dev URL until a final product domain is chosen.
- Sendblue API calls should use `api.sendblue.com`, not the older `.co` host.
- Keep this repo free of private monorepo dependencies such as `@vibe/ui`.
- Token identity is client-token-only. Do not add a Codex account id or local `userId` back unless the product design changes.
- The relay intentionally does not persist prompt content: inbound iMessage body/media is held in the relay Durable Object's in-memory buffer and scrubbed when Codex claims it, while D1 is for metadata such as phone bindings, pairing, and thread state. Outbound Codex replies are forwarded to Sendblue without storing the content.
- `list` is still accepted as an undocumented compatibility alias for the documented iMessage `threads` command. Do not document `list` unless product copy changes.
- Record future import/deploy gotchas here as they are discovered.

## Remaining Launch TODOs

- Decide the final product/domain name.
- Add the Cloudflare custom domain route to `packages/relay/wrangler.jsonc`.
- Deploy the relay with Wrangler after the domain is configured.
- Update the Sendblue inbound webhook URL to the deployed `/webhooks/sendblue` endpoint.
- Update `REMOTE_CONTROL_RELAY_URL` or the installer default relay URL to the final hosted URL.
- Publish `@gaberagland/remote-control` to npm, or update install docs to the final package name.
- Confirm the GitHub repo visibility and README links are correct before sharing publicly.
- Verify self-hosting from a fresh D1 database.
- Run a fresh end-to-end smoke test from the npm package: install, start Remote Control, pair iMessage, send text, send inbound image, generate outbound image, use `threads`, switch threads, and `stop remote`.
