# Message delivery and rendering

Main ↔ Sub messages use `pi.sendMessage()` with `deliverAs: "followUp"` and `triggerTurn: true`. Pi owns queueing and agent-run preparation. The plugin does not send synthetic user wake messages, duplicate UI entries, or emulate Pi's lifecycle hooks.

- `content` contains the peer message and model-facing routing instructions.
- `details` carries the title, original message, direction, run ID, and message ID. Pi does not send these details to the model.
- The registered inbox renderer shows the title and original message, collapsed to three lines by default. Expanding shows the full message, not the internal routing envelope.
- A queued message is acknowledged only after its receipt appears in the session. Both custom-message receipts and the user-message markers used by v0.1.0 remain recognized, including after reload/resume.
- Existing v0.1.0 user messages are not rewritten into cards. Newly delivered custom messages and saved custom messages use the inbox renderer.

## Known upstream limitation

Pi 1.0.4 and 1.1.0 can drop prompt sections added by `before_agent_start` on later turns of an idle run started by a custom message. This is an upstream issue, not the desired messaging contract:

- [#5581: custom-message starts bypass run preparation](https://github.com/earendil-works/pi/issues/5581)
- [#10267: contributed prompt sections are dropped](https://github.com/earendil-works/pi/issues/10267)

Pi Subagent deliberately does not work around this by changing message roles or patching the host. The executable `upstream: idle custom wakes retain profile sections through subsequent turns` test in `test/queue-integration.test.ts` is marked TODO while this host bug remains unresolved. It asserts the desired preservation behavior; it does not assert that losing sections is correct. Remove the TODO after validating an upstream fix. Normal plugin delivery, recovery, and rendering tests remain required.
