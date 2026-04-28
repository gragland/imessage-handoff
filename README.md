# Remote Control

Remote Control lets you continue a local Codex thread from iMessage. It has two parts:

- `packages/skill`: the installable Codex skill and Stop hook scripts.
- `packages/relay`: a plain Cloudflare Worker relay with D1 metadata, a Durable Object message buffer, and iMessage transport.

The hosted relay is the default path. You can also deploy your own relay with Wrangler and point the skill at it.

## Install

```bash
npx @gaberagland/remote-control install
```

Until the package is published, install from GitHub:

```bash
npx github:gragland/remote-control install
```

Then open a Codex thread and invoke Remote Control, or say:

```text
start remote
```

If this is your first time, Codex prints a pairing code. Text that code to the phone number shown by Codex. After that, text normal instructions from iMessage.

## How It Works

1. The installer asks the relay for a token and stores it locally in `~/.codex/skills/remote-control/.state/config.json`.
2. `start remote` registers the current `CODEX_THREAD_ID` with the relay.
3. When you text the pairing code, the relay links that local token to your phone number.
4. iMessages from your paired phone become pending replies for the active Codex thread.
5. The local Stop hook waits via the configured transport, either polling or WebSocket, claims a reply from the relay Durable Object, and continues the original Codex thread.
6. Codex results are sent back to iMessage.

## Commands

Local Codex:

```text
start remote
stop remote
```

The local transport defaults to polling. To try WebSocket delivery, run the installer with `--transport=websocket` or set `REMOTE_CONTROL_TRANSPORT=websocket`; use `poll` to switch back.

iMessage:

```text
threads
```

`threads` shows active remote threads and lets users switch which thread receives iMessage replies.

## Self-Hosting

See [packages/relay](packages/relay) for Wrangler deployment instructions.

## Security Model

Remote Control is a relay for prompts into a local Codex thread. The local config contains the token that gets linked to your phone number when you pair with iMessage.

Keep `~/.codex/skills/remote-control/.state/config.json` private. If that token leaks, reset the install token and pair your phone again:

```bash
npx @gaberagland/remote-control install --reset-token
```

User message content is never intentionally stored by Remote Control. The only persistent system that stores user messages is the message provider, Sendblue.

The relay keeps content-free routing metadata in D1, such as thread records, pairing state, phone bindings, and external message ids for retry dedupe. Inbound iMessage bodies and media URLs live only in the relay Durable Object's in-memory buffer until Codex claims them, then they are scrubbed. Outbound Codex replies and generated image bytes are forwarded directly to Sendblue and are not stored by the relay.

The Cloudflare Worker config disables persisted logging for this app only: Workers Observability is off, invocation logs are off, Workers Trace Events Logpush is off, Tail Worker consumers are empty, Streaming Tail Worker consumers are empty, and trace persistence is off in `packages/relay/wrangler.jsonc` for the `remote-control` Worker. Do not enable Workers Logs, Trace Events Logpush, Tail Workers, Streaming Tail Workers, or tracing for production unless the full log pipeline is reviewed to guarantee message bodies, media URLs, generated image bytes, and provider error payloads are excluded.
