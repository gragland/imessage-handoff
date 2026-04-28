# Remote Control

Remote Control lets you continue a local Codex thread from iMessage. It has two parts:

- `packages/skill`: the installable Codex skill and Stop hook scripts.
- `packages/relay`: a plain Cloudflare Worker relay with D1 metadata, a Durable Object message buffer, and iMessage transport.

The hosted relay is the default path. You can also deploy your own relay with Wrangler and point the skill at it.

## Install

```bash
npx @gaberagland/remote-control install
```

Until the package is published, install from a local checkout:

```bash
git clone https://github.com/gragland/remote-control.git
cd remote-control
pnpm install
node packages/skill/bin/remote-control.mjs install
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
5. The local Stop hook long-polls the relay, claims a reply, and continues the original Codex thread.
6. Codex results are sent back to iMessage.

## Commands

Local Codex:

```text
start remote
stop remote
```

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

The relay keeps thread, pairing, and phone metadata in D1. Inbound iMessage bodies and media URLs are kept only in the relay Durable Object's in-memory buffer until Codex claims them. Codex replies are not stored by the relay; they are forwarded to iMessage when the Stop hook publishes them.
