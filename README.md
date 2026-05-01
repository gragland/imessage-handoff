# Codex iMessage Handoff

iMessage Handoff lets you continue a local Codex thread from iMessage. It has two parts:

- `imessage-handoff`: the installable Codex skill.
- `relay`: a relay that connects Codex with iMessage (use our hosted relay or deploy your own).

<img width="1836" height="508" alt="image 1" src="https://github.com/user-attachments/assets/c1bacc76-a832-4de2-8a77-ded1e319dde3" />

## Install

Install the skill from Codex:

```text
$skill-installer install https://github.com/gragland/codex-imessage-handoff/tree/main/imessage-handoff
```

After installing, open a Codex thread and say:

```text
$imessage-handoff
```

On first use, Codex asks whether you want the hosted iMessage relay or your own relay, then asks permission to install the Codex Stop hook used to forward responses and wait for iMessage replies. Restart Codex once after the hook is installed.

If this is your first time, Codex prints a pairing code. Text that code to the phone number shown by Codex within 15 minutes. After that, text normal instructions from iMessage.

## How It Works

1. You choose the hosted relay or configure your own relay.
2. The skill asks permission to install the Codex Stop hook.
3. `$imessage-handoff` registers the current `CODEX_THREAD_ID` with the relay.
4. When you text the pairing code, the relay links that local token to your phone number.
5. The local Stop hook waits on a WebSocket connection to the relay.
6. When an iMessage arrives from your paired phone, the relay wakes the waiting hook, the hook claims the message, and Codex continues the original thread.
7. For longer iMessage handoff tasks, Codex is prompted to send occasional short progress updates through the relay.
8. Codex results are forwarded to iMessage through Sendblue.

The local Stop hook maintains a WebSocket connection with the relay while it waits for iMessage input.

## Commands

Local Codex:

```text
$imessage-handoff
$imessage-handoff stop
```

iMessage:

```text
threads
```

`threads` shows active iMessage handoff threads and lets users switch which thread receives iMessage replies.

## Self-Hosting

See [relay](relay) for Cloudflare deployment instructions.

## Configure

Configure it by invoking the skill in Codex:

```text
$imessage-handoff show my config
$imessage-handoff use my self-hosted relay at https://<your-worker-url>
$imessage-handoff switch back to the hosted relay
$imessage-handoff reset my install token
$imessage-handoff remove hook
```

## Uninstall

Ask `$imessage-handoff remove hook`. This removes the Codex Stop hook used for communication with the relay. You can then disable or remove the skill in Codex settings.

## Security Model

iMessage Handoff is a relay for prompts into a local Codex thread. The local config contains the token that gets linked to your phone number when you pair with iMessage.

Keep `~/.codex/skills/imessage-handoff/.state/config.json` private. If that token leaks, reset the install token and pair your phone again:

```text
$imessage-handoff reset my install token
```

iMessage Handoff is designed to store the minimum data needed to route messages. The relay avoids persisting conversation content, avoids logging message details, and stores only routing metadata such as thread state, pairing state, and phone bindings.

User message content is held only briefly while waiting for local Codex to claim it, then it is scrubbed. Codex replies and generated images are forwarded to Sendblue, our iMessage sending provider, and are not stored by the relay. Aside from this transient relay processing, Sendblue is the only system intended to persist iMessage content.

For added security, Cloudflare persisted logging is disabled for the `imessage-handoff` relay so messages are not stored in Cloudflare logs.
