# Remote Control

Remote Control lets you continue a local Codex thread from iMessage. It has two parts:

- `remote-control`: the installable Codex skill and Stop hook scripts.
- `relay`: a Cloudflare relay that connects Codex with iMessage via [Sendblue](https://www.sendblue.com/).

The hosted relay is the default path. You can also deploy your own Cloudflare relay and point the skill at it.

## Install

Install the skill from Codex:

```text
$skill-installer install https://github.com/gragland/remote-control/tree/main/remote-control
```

After installing, open a Codex thread and say:

```text
$remote-control
```

On first use, Codex asks whether you want the hosted iMessage relay or your own relay, then asks permission to install the Codex Stop hook used to forward responses and wait for iMessage replies. Restart Codex once after the hook is installed.

If this is your first time, Codex prints a pairing code. Text that code to the phone number shown by Codex. After that, text normal instructions from iMessage.

## Configure

Configure it by invoking the skill in Codex:

```text
$remote-control show my config
$remote-control use my self-hosted relay at https://<your-worker-url>
$remote-control switch back to the hosted relay
$remote-control reset my install token
$remote-control uninstall yourself
```

## Uninstall

Ask `$remote-control uninstall yourself`. This removes the Codex Stop hook used for communication with the relay. You can then disable or remove the skill in Codex settings.

## How It Works

1. You choose the hosted relay or configure your own relay.
2. The skill asks permission to install the Codex Stop hook.
3. `$remote-control` registers the current `CODEX_THREAD_ID` with the relay.
4. When you text the pairing code, the relay links that local token to your phone number.
5. The local Stop hook waits on a WebSocket connection to the relay.
6. When an iMessage arrives from your paired phone, the relay wakes the waiting hook, the hook claims the message, and Codex continues the original thread.
7. For longer remote tasks, Codex is prompted to send occasional short progress updates through the relay.
8. Codex results are forwarded to iMessage through Sendblue.

The local Stop hook maintains a WebSocket connection with the relay while it waits for remote input.

## Commands

Local Codex:

```text
$remote-control
$remote-control stop
```

iMessage:

```text
threads
```

`threads` shows active remote threads and lets users switch which thread receives iMessage replies.

## Self-Hosting

See [relay](relay) for Cloudflare deployment instructions.

## Security Model

Remote Control is a relay for prompts into a local Codex thread. The local config contains the token that gets linked to your phone number when you pair with iMessage.

Keep `~/.codex/skills/remote-control/.state/config.json` private. If that token leaks, reset the install token and pair your phone again:

```text
$remote-control reset my install token
```

Remote Control is designed to store the minimum data needed to route messages. The relay avoids persisting conversation content, avoids logging message details, and stores only routing metadata such as thread state, pairing state, and phone bindings.

User message content is held only briefly while waiting for local Codex to claim it, then it is scrubbed. Codex replies and generated images are forwarded to Sendblue, our iMessage sending provider, and are not stored by the relay. Aside from this transient relay processing, Sendblue is the only system intended to persist iMessage content.

For added security, Cloudflare persisted logging is disabled for the `remote-control` relay so messages are not stored in Cloudflare logs.
