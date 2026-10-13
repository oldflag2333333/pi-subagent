# Message delivery and rendering

Pi Subagent requires **Pi 1.2.0 or newer**. Main ↔ Sub messages use `pi.sendMessage()` with `deliverAs: "followUp"` and `triggerTurn: true` in both directions:

- **Busy receiver:** Pi queues the custom message behind its current work.
- **Idle receiver:** Pi prepares and starts the run, including `before_agent_start`, the tool loadout, and prompt sections. The event has `messageType: "custom"`, with the starting `message` rather than a user `prompt`.

There are no synthetic user-role wake messages, version fallbacks, or patches to Pi internals. Custom messages do not pass through user-input processing or execute peer text as slash commands or templates.

## Delivery guarantees

- `content` carries the peer message and routing instructions; `details` carries rendering and receipt metadata and is not sent to the model.
- Custom cards retain their title, collapsed/expanded rendering, and saved-session rendering.
- A message file is removed only after its receipt appears in the receiving session. Existing user-message receipts remain recognized to avoid redelivery of saved messages; this is data compatibility, not support for older Pi runtimes.
- In-flight message IDs prevent duplicate submission. Synchronous submission failures leave the file retryable. Pi owns run preparation and queueing; the plugin does not keep a separate wake reservation or retry timer.

Pi 1.2.0 includes the native custom-message preparation fix in [#10739](https://github.com/earendil-works/pi/pull/10739), resolving [#5581](https://github.com/earendil-works/pi/issues/5581) and [#10267](https://github.com/earendil-works/pi/issues/10267). Real SDK regression tests require profile sections to remain present on the first idle delivery, subsequent turns, busy follow-ups, and after reload. No upstream TODO or workaround is retained.
