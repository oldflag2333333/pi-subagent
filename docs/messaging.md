# Message delivery and rendering

Main ↔ Sub messages remain custom inbox cards. Delivery uses the same `parentWake` wrapper in both directions:

- **Busy receiver:** `pi.sendMessage()` with `deliverAs: "followUp"` and `triggerTurn: true`, using Pi's native queue.
- **Idle receiver:** append the card with `pi.sendMessage(..., { triggerTurn: false })`, then start the run with a short, fixed `pi.sendUserMessage(..., { deliverAs: "steer" })` prompt. This goes through normal input preparation and `before_agent_start`.

The wake is a real, visible user-role message added by the extension, not a duplicate of the peer's message. It only asks the receiving agent to process its inbox within its existing task and authority. Peer text stays in the custom card and is never submitted as executable slash-command input.

## Delivery guarantees

- `content` carries the peer message and routing instructions; `details` carries rendering and receipt metadata and is not sent to the model.
- Custom cards retain their title, collapsed/expanded rendering, and saved-session rendering.
- A message file is removed only after its receipt appears in the receiving session. Legacy user-message receipts remain recognized.
- An idle burst shares one wake while that wake is starting. Reservations survive `/reload`, are scoped to the receiving session, and clear on `agent_start` or non-reload shutdown.
- If a wake never starts, a later idle delivery can request another wake after ten seconds. The deadline does not create a timer or promise autonomous retry after an input hook handles the wake.
- A synchronous wake failure keeps the message file retryable; retrying does not append the custom card again. Pi's fire-and-forget extension API does not expose asynchronous prompt failures as delivery receipts.

## Why the workaround exists

Pi 1.0.4 and 1.1.0 have an idle custom-message wake path that bypasses `before_agent_start` and can drop profile prompt sections:

- [#5581: custom-message starts bypass run preparation](https://github.com/earendil-works/pi/issues/5581)
- [#10267: contributed prompt sections are dropped](https://github.com/earendil-works/pi/issues/10267)

The implementation adapts [nicobailon/pi-subagents' parentWake](https://github.com/nicobailon/pi-subagents/blob/0c33ec7cb26ed1db270d72e746c3c975be880aeb/src/shared/parent-wake.ts), with retries for synchronous wake failures. Attribution and the MIT license are in [third-party notices](third-party-notices.md).

Real Pi SDK tests cover the first idle wake, subsequent turns, busy follow-ups, and reload. The previous upstream TODO is now a required passing regression test. This workaround does not patch Pi internals or claim to fix unrelated retry/resume paths in Pi itself.
