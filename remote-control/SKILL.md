---
name: remote-control
description: Start or stop remote continuation for the current Codex thread. Use when the user invokes Remote Control, mentions $remote-control, says "start remote", "go remote", "stop remote", or asks to continue the current thread from iMessage.
---

# Remote Control

Use this skill when the user invokes Remote Control, mentions `$remote-control`, says "start remote", "go remote", "stop remote", or asks to continue the current Codex thread from iMessage.

If this skill is invoked without additional instructions, start remote for the current thread.

## Start Remote

When starting remote, run the starter script yourself. Do not tell the user to run it.

Before running `scripts/start-remote.js`, check whether Remote Control has local relay config and a ready Codex Stop hook:

1. Run `node scripts/configure.js show`, resolving `scripts/configure.js` relative to this `SKILL.md`.
2. If `configured` is false, do not run `scripts/start-remote.js`. Ask exactly:

   ```text
   Remote Control needs a couple one-time setup steps before it can start.

   First, choose an iMessage relay:

   1. Use the hosted relay
      Your messages pass through our server so we can forward them to iMessage. We avoid storing message content in our database.

   2. Deploy your own relay
      Follow the instructions here: https://github.com/gragland/remote-control

   Reply with 1 or 2. You can switch relays any time by asking Remote Control to switch.
   ```

3. If the user replies with `1`, "hosted", "use yours", "use hosted", or similar, run `node scripts/configure.js use-default-relay`, then ask the hook consent question below.
4. If the user replies with `2`, "deploy my own", "self-hosted", or similar without a relay URL, reply exactly:

   ```text
   Okay. Follow the instructions here: https://github.com/gragland/remote-control

   When you’re done, paste in your relay URL. Or just let me know if you’d like to use the hosted relay for now.
   ```

5. If the user provides a relay URL, run `node scripts/configure.js set-relay --url="URL"`, then ask the hook consent question below.

After relay config exists, run `node scripts/configure.js hook-status`. If `ready` is false, ask exactly:

```text
Next, Remote Control needs to install a one-time Codex Stop hook. After Codex responds, this hook forwards the response to the relay and waits for iMessage replies.

With your permission, I’ll install it now. After installation, restart Codex once. If you ever want to stop Remote Control from communicating with the relay, tell it to remove its hook.

Reply yes to install the hook.
```

Only install the hook after the user says yes or gives an equivalent confirmation. If they do not confirm, do not run `scripts/start-remote.js`.

After the user confirms, run `node scripts/configure.js install-hook`, then reply exactly and stop:

```text
Remote Control hook is installed. Restart Codex once, then invoke `$remote-control` again to start remote control.
```

Do not run `scripts/start-remote.js` in the same turn that installs the hook. The restart lets Codex load the new hook before the pairing message is shown, so the Stop hook can wait for the iMessage reply.

Once relay config exists and `node scripts/configure.js hook-status` reports `ready: true`:

1. Write a one-sentence handoff summary for iMessage before running the script.
   - Summarize only what this thread was about immediately before starting remote control.
   - Prefer natural recap wording like `We last discussed ...` when it fits.
   - Summarize the work itself, not the setup or delivery mechanism.
   - Keep it plain text and very short, ideally under 140 characters.
   - If there is not enough useful context, use no summary.
2. Run the bundled `scripts/start-remote.js` from this skill's installed directory with `--handoff-summary="SUMMARY"` when you have a useful summary, or with no arguments when you do not. This registers the thread.
3. Use Node to run the script, for example `node scripts/start-remote.js` after resolving `scripts/start-remote.js` relative to this `SKILL.md`.
4. If that fails with a sandbox or network error such as `fetch failed`, retry with approval using the same command. Do not request escalation before trying the normal command first.
5. Read the JSON output.
6. Respond with `localMessage` exactly and nothing else. Do not include debug details unless the user explicitly asks for them.

   Do not present the Codex thread id, CLI commands, hook details, or implementation internals as part of the public/product-facing message.

   A paired phone can have multiple active remote threads. Starting remote for this thread switches iMessage to this thread. The user can text `threads` to the printed phone number to see numbered active threads, then text a bare number such as `2` to switch.

## Stop Remote

When the user says "stop remote":

1. Run the bundled `scripts/stop-remote.js` from this skill's installed directory with Node, resolving the script path relative to this `SKILL.md`.
2. Tell the user:

   ```text
   Remote control is stopped.
   ```

Do not include debug details unless the user asks for them. The running Stop hook re-checks local active-thread state while waiting and exits shortly after this command disables the thread.

## Configure Remote Control

Use `scripts/configure.js` for configuration requests. Resolve the script path relative to this `SKILL.md` and run it with Node.

- If the user asks to show current config, run `node scripts/configure.js show`, then summarize the relay URL and whether config exists. Never print the token value.
- If the user asks to use a self-hosted relay or set/change the relay URL, run `node scripts/configure.js set-relay --url="https://..."`. Tell the user the relay was updated and that they can now start remote.
- If the user asks to switch back to the hosted relay, run `node scripts/configure.js use-default-relay`.
- If the user asks to reset the install token, run `node scripts/configure.js reset-token`. Tell the user the token was reset and that they may need to pair iMessage again.
- If the user asks to remove the hook, remove the Codex hook, or uninstall Remote Control, run `node scripts/configure.js uninstall`. Tell the user the Codex Stop hook was removed and they can disable or remove the skill in Codex settings.

## Stop Hook Behavior

The global Stop hook publishes status, then waits for the active remote thread over WebSocket.

- If no reply arrives before the Stop hook timeout, Codex stays idle quietly.
- If a reply arrives, the Stop hook claims exactly one reply and continues the thread with that reply.
- Treat continued remote messages exactly as if the user typed them directly into this chat.
- Answer the user's remote message normally; delivery details are not part of the response unless the user asks about them.
- When done, stop normally. The global Stop hook publishes the result and waits for the next reply.
- If the user continues locally in the same Codex thread, the Stop hook disables remote control silently so the local message can run normally.

## Local Config

Config lives in the installed skill directory at `.state/config.json`.

Required shape:

```json
{
  "apiBaseUrl": "https://remote-control.example.workers.dev",
  "token": "dev-token",
  "stopWaitSeconds": 86400
}
```

If config is missing, ask the relay-choice question from Start Remote. Do not run `start-remote.js` until the user chooses hosted or provides a self-hosted relay URL.

For self-hosting, set the relay before starting remote by asking Remote Control to use the self-hosted relay URL.

## iMessage Testing

If `start remote` prints a pairing code, text it to the printed phone number once. After the phone is paired, future `start remote` runs should let you text normal instructions directly without another pairing code.

Text `threads` to the printed phone number to see all active remote threads for the paired phone. Text a number from that list to switch which thread receives normal remote messages.

Read the latest published Codex result/status:

```bash
curl -sS \
  -H "Authorization: Bearer $(node -p 'JSON.parse(require("fs").readFileSync(process.env.HOME + "/.codex/skills/remote-control/.state/config.json", "utf8")).token')" \
  "$(node -p 'JSON.parse(require("fs").readFileSync(process.env.HOME + "/.codex/skills/remote-control/.state/config.json", "utf8")).apiBaseUrl')/threads/019dc..."
```
