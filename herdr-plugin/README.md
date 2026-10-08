# Pi Subagent Agent Visibility for Herdr

This companion Herdr plugin hides Pi Subagent-managed subs from the built-in Agents panel by default and provides actions to show, hide, or toggle them.

Pi Subagent marks each Herdr Sub pane with the metadata token `subagent_role=sub`. This plugin applies a transient `agent.view` filter; it does not affect `agent list`, notifications, lifecycle detection, or global attention counts.

## Link for development

```bash
herdr plugin link /absolute/path/to/pi-subagent/herdr-plugin
herdr plugin action invoke subagent.agent-visibility.hide-subs
```

## Actions

```bash
herdr plugin action invoke subagent.agent-visibility.toggle-subs
herdr plugin action invoke subagent.agent-visibility.hide-subs
herdr plugin action invoke subagent.agent-visibility.show-subs
```

The selected visibility is stored in `HERDR_PLUGIN_STATE_DIR` and restored when the Herdr server starts. The initial default is hidden.

Optional keybinding:

```toml
[[keys.command]]
key = "prefix+shift+a"
type = "plugin_action"
command = "subagent.agent-visibility.toggle-subs"
description = "toggle Pi Subagent subs"
```

After editing Herdr config, run `herdr server reload-config`.
