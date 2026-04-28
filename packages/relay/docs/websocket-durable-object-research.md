# WebSocket Durable Object Research

Research note for replacing or augmenting the current polling-based remote reply delivery path.

## Summary

Using a WebSocket connection from the local Stop hook to a Cloudflare Durable Object is possible and fits Cloudflare's intended Durable Object WebSocket model. A Durable Object can coordinate long-lived WebSocket clients, and Cloudflare recommends the hibernation WebSocket API for idle WebSocket servers because connected clients can remain attached while the Durable Object is evicted from memory and later woken by events.

The important catch is delivery semantics. A pure "do not store inbound messages" design only works when the local Codex Stop hook is connected at the exact moment Sendblue delivers the webhook. If the local machine sleeps, the Stop hook is not currently running, the network drops, Codex is busy responding, or the WebSocket reconnect has not completed yet, the relay has nowhere durable to put the message. The Worker cannot initiate a connection back to the local machine; the local process must already be connected.

Recommended direction: keep the current D1-backed pending reply path as the reliable fallback, and add a Durable Object WebSocket fast path later if latency or polling load becomes a real problem.

## Current Experiment

The relay includes a minimal WebSocket probe at `GET /threads/:threadId/events`.

- The endpoint authenticates the thread, then proxies the WebSocket upgrade to a `RemoteThreadSocket` Durable Object keyed by thread ID.
- The local Stop hook opens this socket when it starts waiting for remote input.
- The Stop hook sends a `stop-hook-connected` probe message.
- The Durable Object replies with an `ack` message confirming receipt.
- The Stop hook ignores the ack for delivery and keeps polling as the source of truth.
- The Stop hook closes the socket when that Stop hook exits; it does not keep a daemon connection open across assistant turns.

This validates connection setup, upgrade routing, and per-stop teardown without changing Sendblue delivery.

## Current Path

Today, inbound delivery is intentionally durable but short-lived:

1. Sendblue posts to `POST /webhooks/sendblue`.
2. The Worker authenticates the webhook, finds the active thread, and inserts a pending `remote_replies` row.
3. The local Stop hook publishes status, then polls `GET /threads/:threadId/pending`.
4. When a reply appears, the Stop hook claims it with `POST /threads/:threadId/replies/:replyId/claim`.
5. The Worker returns the content and immediately scrubs body/media from D1, leaving only content-free markers for dedupe.

This means inbound prompt content is retained only until Codex fetches it, but delivery survives temporary local disconnects.

## Feasibility

Cloudflare supports this shape:

- Durable Objects can act as WebSocket servers and coordinate multiple clients per object.
- The hibernation WebSocket API lets idle Durable Objects sleep without disconnecting clients, reducing duration charges.
- Workers and Durable Objects can accept inbound WebSocket upgrades. A normal Worker route can authenticate and proxy the upgraded request to a Durable Object instance.
- A Sendblue webhook can route to the same Durable Object instance and ask it to deliver the inbound message to any currently connected local Stop hook socket.

The Stop hook can open a WebSocket while it is waiting for remote input, then close it when one of these happens:

- A remote message arrives and the hook emits the Codex block decision.
- The hook timeout expires.
- `stop remote` or a local follow-up disables the active remote thread.
- The process exits or the socket errors.

On the next assistant stop, the Stop hook can open a fresh WebSocket. Keeping a socket open outside Stop hook execution would require a separate persistent local daemon, which is a larger installer and lifecycle change.

## Design Options

### Option A: WebSocket Fast Path With D1 Fallback

This is the safest production option.

- Add a Durable Object per owner or per active thread.
- When the Stop hook begins waiting, it opens `wss://.../threads/:threadId/events` with token auth.
- The Durable Object records the connected socket for that thread.
- On Sendblue webhook:
  - Keep existing command, pairing, thread-switching, dedupe, and media-group handling.
  - If a matching Stop hook socket is connected, send the reply over WebSocket immediately.
  - Also preserve or quickly create a D1 fallback row until the local hook acknowledges receipt.
- The local hook acknowledges the delivered reply over the WebSocket or via an HTTP claim endpoint.
- If no socket is connected, keep using the existing pending reply row.

Pros:

- Reduces average delivery latency.
- Preserves reliable delivery across disconnects.
- Keeps current privacy posture: content is still scrubbed after claim/ack.
- Allows incremental rollout behind a config flag.

Cons:

- More moving parts: Durable Object binding, WebSocket auth, ack protocol, reconnect handling, and additional tests.
- Does not remove D1 from the inbound message path.

### Option B: Pure Transient WebSocket Delivery

This is the most privacy-minimal but least reliable option.

- Sendblue webhook routes to a Durable Object.
- If the local Stop hook socket is connected, the Durable Object sends the message directly.
- If no socket is connected, the message is dropped or a generic "Codex is not connected" response is sent back through Sendblue.
- Store only content-free external IDs/tombstones for dedupe, if needed.

Pros:

- Avoids storing inbound prompt bodies/media URLs in D1.
- Very small runtime data footprint when connected.

Cons:

- Loses messages during common real-world gaps.
- Multi-image grouping still needs a short quiet window; doing that without any storage depends on the Durable Object staying alive and keeping in-memory state.
- Hibernation resets in-memory state, so any state needed across hibernation must be serialized with the WebSocket or stored.
- Sendblue webhook retries could create confusing duplicate/drop behavior unless content-free dedupe remains.

### Option C: Persistent Local Daemon

This is technically possible but not a good next step.

- Installer or `start remote` starts a background process that keeps the WebSocket open across turns.
- Stop hook communicates with that daemon instead of connecting directly.

Pros:

- Best chance of being connected when Sendblue arrives.
- Avoids reconnecting after every assistant turn.

Cons:

- Adds process management, upgrades, crash recovery, logs, user controls, and uninstall behavior.
- Makes the skill much less transparent than the current hook-only model.
- Still needs fallback for machine sleep/offline states.

## Recommendation

Do not replace polling with a pure no-storage WebSocket design for launch. It trades a small amount of short-lived D1 retention for real message loss.

If polling becomes a real product or cost issue, implement Option A as an incremental fast path:

1. Keep all current HTTP endpoints and D1 semantics.
2. Add a Durable Object binding and class dedicated to live thread connections.
3. Add a Stop hook WebSocket wait path behind config, falling back to current polling on any socket failure.
4. Add an ack step before scrubbing content or marking a reply delivered.
5. Keep content-free Sendblue `message_handle` tombstones for retry dedupe.

This gives the latency benefit without weakening reliability.

## Open Questions Before Implementation

- Which auth shape should the WebSocket handshake use? Query tokens are simple but leak more easily into logs; a WebSocket subprotocol token avoids query strings but is a little more custom.
- Should the Durable Object be keyed by owner ID or thread ID? Owner ID simplifies active-thread switching; thread ID isolates state more tightly.
- What is the acceptable behavior if a message arrives while Codex is actively generating and the Stop hook is not yet running?
- Should generated-image outbound delivery remain HTTP-only, or should the same WebSocket path eventually carry local status events too?

## Sources

- Cloudflare Durable Objects WebSockets: https://developers.cloudflare.com/durable-objects/best-practices/websockets/
- Cloudflare WebSocket hibernation example: https://developers.cloudflare.com/durable-objects/examples/websocket-hibernation-server/
- Cloudflare Workers WebSockets API: https://developers.cloudflare.com/workers/runtime-apis/websockets/
- Cloudflare Workers supported protocols: https://developers.cloudflare.com/workers/reference/protocols/
