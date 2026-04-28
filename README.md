# Remote Control

Remote Control lets you continue a local Codex thread from iMessage. It has two parts:

- `packages/skill`: the installable Codex skill and Stop hook scripts.
- `packages/relay`: a plain Cloudflare Worker relay with D1 metadata, a Durable Object message buffer, and iMessage transport.

The hosted relay is the default path. You can also deploy your own relay with Wrangler and point the skill at it.

## Install

Current GitHub install, for testing before npm publish:

```bash
npx github:gragland/remote-control install
```

After the package is published to npm, the install command will be:

```bash
npx @gaberagland/remote-control install
```

Installer options:

```bash
npx github:gragland/remote-control install --transport=websocket
npx github:gragland/remote-control install --transport=poll
npx github:gragland/remote-control install --relay-url=https://<your-worker-url>
npx github:gragland/remote-control install --reset-token
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
6. Codex results are forwarded to iMessage through Sendblue.

Both transports use the same relay Durable Object buffer. Polling checks the buffer over HTTP; WebSocket mode waits for the Durable Object to send a `reply-pending` event, then claims the reply over the same HTTP claim endpoint. Because message bodies are only held in Durable Object memory, pending remote messages can be lost if the Worker/Durable Object is evicted or restarted before Codex claims them.

## Commands

Local Codex:

```text
start remote
stop remote
```

The local transport defaults to WebSocket delivery. To use polling instead, run the installer with `--transport=poll` or set `REMOTE_CONTROL_TRANSPORT=poll`; use `websocket` to switch back.

iMessage:

```text
threads
```

`threads` shows active remote threads and lets users switch which thread receives iMessage replies.

## Self-Hosting

See [packages/relay](packages/relay) for Cloudflare deployment instructions.

## Security Model

Remote Control is a relay for prompts into a local Codex thread. The local config contains the token that gets linked to your phone number when you pair with iMessage.

Keep `~/.codex/skills/remote-control/.state/config.json` private. If that token leaks, reset the install token and pair your phone again:

```bash
npx github:gragland/remote-control install --reset-token
```

Remote Control is designed to store the minimum data needed to route messages. The relay avoids persisting conversation content, avoids logging message details, and keeps durable storage limited to routing metadata such as thread state, pairing state, phone bindings, and delivery dedupe ids.

User message content is only held transiently in memory while waiting for local Codex to claim it, then it is scrubbed. Codex replies and generated images are forwarded directly to Sendblue and are not stored by the relay. Aside from this transient relay processing, the only persistent third-party system that stores iMessage content is the message provider, Sendblue.

Cloudflare persisted logging is disabled for the `remote-control` Worker in `packages/relay/wrangler.jsonc`. Do not enable Worker logs, log exports, Tail Workers, or tracing in production unless the full pipeline is reviewed to make sure message content cannot be captured.
