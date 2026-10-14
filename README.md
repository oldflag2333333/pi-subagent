# Pi Subagent

English | [简体中文](README.zh-CN.md)

Give Pi reusable specialists for code review, research, and other focused tasks. Each specialist runs in its own Herdr tab and reports back to your main conversation, without inheriting its chat history.

A **profile** defines a specialist's instructions, tools, and optional skills or model. You can invoke it yourself or let your main Pi delegate work to it.

## Install

You need **Node.js 22.19+**, **[Pi](https://pi.dev) 1.2.0+**, and **Herdr**. To launch specialists, run Pi inside a Herdr workspace with the `herdr` command available.

```bash
pi install npm:@oldflag2333333/pi-subagent
```

Restart Pi or run `/reload`. Pi Subagent uses your existing Pi provider credentials; make sure Pi can already run a normal conversation.

To update later:

```bash
pi update npm:@oldflag2333333/pi-subagent
```

Restart Pi or run `/reload` after updating.

## Try it: a code reviewer

Pi Subagent ships without built-in profiles. Create your first one:

```bash
mkdir -p ~/.pi/agent/subagent/profiles/reviewer
```

Save this as `~/.pi/agent/subagent/profiles/reviewer/config.json`:

```json
{
  "version": 1,
  "name": "reviewer",
  "description": "Review code for bugs and missing tests without modifying files.",
  "tools": ["read", "grep", "find", "ls"]
}
```

Save this beside it as `instructions.md`:

```markdown
Review the requested code for bugs, regressions, and missing tests.
Do not modify files. Report actionable findings with file paths and
line numbers. If nothing stands out, say so and note any testing gaps.
```

In Pi, run `/reload`, then:

```text
/sub:reviewer Review the authentication code in src/auth.
```

Replace `src/auth` with a path in your project. The reviewer opens in a separate Herdr tab and sends its findings back to your main conversation. You can keep working while it runs.

Or ask your main Pi to delegate:

```text
Ask the reviewer profile to review src/auth for bugs and missing tests.
```

## Everyday use

| What you want | How to do it |
| --- | --- |
| See available profiles or configuration errors | `/profiles` |
| Start a specialist or send it another task | `/sub:reviewer <task>` |
| Let Pi choose a specialist | Ask Pi to delegate the task to an appropriate profile |
| Check progress | Ask Pi to list its Subs, or open the specialist's Herdr tab |
| Stop its current task without closing it | Ask Pi to interrupt the Sub |
| Finish with a specialist | Ask Pi to close the Sub, or close its Herdr tab |
| Remove Sub sessions and communication files left by deleted Mains | `/clean-sub` |

Within the same Main session, repeated `/sub:reviewer` commands reuse that profile's open Sub. If it is busy, your next task is queued. Finishing a task does not automatically close the tab.

The **Sub-agents** list shows only assistants created by the current Main: all **Open** Subs (including idle or unknown status) and **Resumable** persistent sessions confirmed closed with saved files still available. Other Main sessions and forks do not inherit them or gain access to resume them. Reloading or resuming the same Main preserves ownership.

To use a profile in your current Pi instead of opening a Sub, start Pi with:

```bash
pi --profile reviewer
```

Starting Pi without `--profile` leaves your existing tools, model, and skills unchanged.

## Customize a profile

### Where profiles live

- **Personal:** `~/.pi/agent/subagent/profiles/<name>/`
- **Project:** `.pi/subagent/profiles/<name>/` in your project or an ancestor directory; loaded only when the project is trusted.

Each directory needs a `config.json`, with a `name` matching the directory name. A nearer project profile replaces a same-named ancestor or personal profile; settings are not merged. Legacy `<name>.json` profiles are also supported.

### Instructions

Write the role in `instructions.md` beside `config.json`. It takes precedence over an inline `"instructions": "..."` field; if the file is absent, the inline field is used instead. Instructions add to Pi's normal project context, rather than replacing it.

Instruction files must be non-empty and no longer than 65,536 characters. An invalid or unreadable file is reported as an error, not silently ignored.

Run `/reload` after editing profiles. Already-open Subs keep their launch configuration; close and reopen them to use changes.

### Optional settings

Add these fields to `config.json` as needed:

| Field | Use it to… |
| --- | --- |
| `"invocation": "manual"` | Allow only user commands such as `/sub:reviewer` to start this specialist. Default: `"both"`, allowing Pi delegation too. |
| `"sessionPersistence": "persistent"` | Save the Sub's conversation so it can be resumed after closing. Default: `"ephemeral"`, which keeps it only in memory. |
| `"model": "provider/model-id"` | Choose a model available in your Pi configuration. |
| `"thinkingLevel": "high"` | Request a thinking level supported by the selected model. |
| `"skills": ["skill-name", "./path/to/SKILL.md"]` | Include installed skills or paths relative to the profile. |
| `"extensions": ["npm:pi-model-calibration", "./hooks.ts"]` | Explicitly load extra extensions in Subs, including prompt/event plugins that provide no tools. |

For a persistent specialist started with `/sub:reviewer`, invoking the command again from the same saved Main session resumes it after closure. A different Main session gets its own specialist. Manual-only profiles are not available for Pi to delegate on its own.

### Sub extension allowlist

Add this to the profile's `config.json`, for example:

```json
"extensions": ["npm:pi-model-calibration"]
```

Entries accept Pi's npm, `git:`, HTTP(S) repository URLs, `builtin:` identifiers, and local extension files or package directories. Relative local paths resolve from the **configuration file's directory**; absolute paths and `~/` work too. Missing local paths fail startup; repeated entries load once. Package specs are resolved by Pi in the Sub and may download or install packages, never while Main reads the profile.

`npm:` / `git:` entries use Pi's temporary package cache; a globally installed package may not be present there. For offline use, list the installed entry file directly, for example `"extensions": ["~/.pi/agent/npm/node_modules/pi-model-calibration/index.ts"]`, to avoid another download.

Omitting the field or using `[]` loads no extra plugins. Subs still use `--no-extensions`: only communication/Herdr integration, normal MCP support, selected tools' extension dependencies, and this allowlist load explicitly. Other Main plugins are not inherited. Project profiles still require project trust; same-named overrides replace rather than merge allowlists.

This field controls **Sub launches only**; it does not dynamically load extensions in the current process started with `pi --profile`. Use Pi's `-e` or normal extension configuration for that case. Loading an extension does not automatically add its tools to the profile's `tools`; custom non-MCP tools must still be available in Main.

Extensions can execute code, read context, and change prompts. **This is not a sandbox**; list only trusted plugins. After editing, reload Main and close/reopen affected Subs. For `model-calibration`, its rules must also match the Sub's selected model before calibration text is injected.

### Profile-specific skills

Put skills inside the profile directory to load them only when that profile is selected. No `skills` field is needed:

```text
reviewer/
├── config.json
├── instructions.md
└── skills/
    └── code-review/
        └── SKILL.md
```

### Delegation rules for your main Pi

Use `~/.pi/agent/subagent/MAIN.md` or a trusted project's `.pi/subagent/MAIN.md` for rules such as:

```markdown
Ask the reviewer profile to review code changes before declaring a task complete.
```

These instructions apply only to your main Pi, not to its Subs. Keep shared project rules in `AGENTS.md`.

## Clean up deleted sessions

Persistent Sub histories are grouped by their owning Main, using Pi's native `--session-dir`:

```text
~/.pi/agent/subagent/sessions/<main-session-id>/*.jsonl
```

Run `/clean-sub` to immediately delete both the Sub session directory and runtime communication directory for any Main ID no longer found among saved Pi sessions. It checks Pi's default session store and the current session directory, always preserves the current Main, and creates no index. Unreadable session files or invalid headers stop cleanup instead of being treated as deleted.

Close any orphaned Sub tabs before cleaning; the command only deletes files. Profiles and global settings are untouched. Older Sub files outside the managed directory still need manual deletion. If you moved Main files or use other custom session directories, make them available in the scanned locations before cleaning.

## Things to know

Messages use custom inbox cards and Pi’s native run preparation, without extra user-role wake messages. See [messaging behavior](docs/messaging.md).

- **Herdr is required for Subs.** There is no headless fallback. Up to four Subs can be open at once, and Subs cannot delegate further.
- **Profiles are not a sandbox.** Subs run as your OS user. A read-only role is not a filesystem permission boundary.
- **MCP follows Pi's normal configuration.** Profiles select non-MCP tools; they do not isolate or filter MCP servers. Custom non-MCP tools must come from extensions already loaded in Main.
- **Subs have separate conversations.** They receive their task, profile, and normal project context—not Main's chat history. Include the details they need in the task.
- **Reloading Main does not close Subs.** Close tabs you no longer need. Hard crashes may require manual cleanup.

Before a fresh or resumed Sub launch, the plugin submits a short shell probe and waits up to 60 seconds for it to execute before submitting the full Pi command. This avoids macOS truncating long commands (especially resume paths) and dropping Enter while the shell is still initializing. The wait is cancellable; launch failure attempts to close the new tab rather than sending Enter to a partial command. See [Herdr issue #4950](https://github.com/herdrdev/herdr/issues/4950).

If a profile is missing or fails to start, run `/profiles` first. Check its directory/name match, project trust, and any referenced tools, skills, or extensions. If Herdr is unavailable, confirm Pi is running inside a Herdr workspace.

To hide or show Pi Subagent Subs in Herdr's Agents panel, see the optional [Herdr companion plugin](herdr-plugin/README.md).

## Development

```bash
npm install
npm run check
pi -e ./src/index.ts
```

Maintainers: see [the release guide](docs/releasing.md) for CI and automatic npm publishing.
