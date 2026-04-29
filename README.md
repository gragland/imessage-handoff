# Remote Control

Remote Control lets you continue a local Codex thread from iMessage. It has two parts:

- `packages/skill`: the installable Codex skill and Stop hook scripts.
- `packages/relay`: a Cloudflare relay that connects Codex with iMessage via [Sendblue](https://www.sendblue.com/).

The hosted relay is the default path. You can also deploy your own Cloudflare relay and point the skill at it.

## Install

Install the skill with the Skills CLI:

```bash
npx skills add https://github.com/gragland/remote-control --skill remote-control
```

From a local checkout:

```bash
npx skills add . --skill remote-control
```

The first `start remote` run completes setup automatically by creating the local relay config and installing the Codex Stop hook. Add `--global` if you want the skill available outside the current project.

After installing, open a Codex thread and say:

```text
start remote
```

If this is your first time, Codex prints a pairing code. Text that code to the phone number shown by Codex. After that, text normal instructions from iMessage.

## Configure

Configure Remote Control by asking the skill in Codex:

```text
Remote Control show my config.
Remote Control use my self-hosted relay at https://<your-worker-url>.
Remote Control switch back to the hosted relay.
Remote Control reset my install token.
Remote Control uninstall yourself.
```

## Uninstall

Ask `Remote Control uninstall yourself.` This removes the Codex Stop hook used for communication with the relay. You can then disable or remove the skill in Codex settings.

## How It Works

1. The installer asks the relay for a token and stores it locally in the installed skill directory.
2. `start remote` registers the current `CODEX_THREAD_ID` with the relay.
3. When you text the pairing code, the relay links that local token to your phone number.
4. The local Stop hook waits on a WebSocket connection to the relay.
5. When an iMessage arrives from your paired phone, the relay wakes the waiting hook, the hook claims the message, and Codex continues the original thread.
6. Codex results are forwarded to iMessage through Sendblue.

The local Stop hook maintains a WebSocket connection with the relay while it waits for remote input.

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

See [packages/relay](packages/relay) for Cloudflare deployment instructions.

## Security Model

Remote Control is a relay for prompts into a local Codex thread. The local config contains the token that gets linked to your phone number when you pair with iMessage.

Keep `~/.codex/skills/remote-control/.state/config.json` private. If that token leaks, reset the install token and pair your phone again:

```text
Remote Control reset my install token.
```

Remote Control is designed to store the minimum data needed to route messages. The relay avoids persisting conversation content, avoids logging message details, and stores only routing metadata such as thread state, pairing state, and phone bindings.

User message content is held only briefly while waiting for local Codex to claim it, then it is scrubbed. Codex replies and generated images are forwarded to Sendblue, our iMessage sending provider, and are not stored by the relay. Aside from this transient relay processing, Sendblue is the only system intended to persist iMessage content.

For added security, Cloudflare persisted logging is disabled for the `remote-control` relay so messages are not stored in Cloudflare logs.
