# Facets Agent Visibility for Herdr

This companion Herdr plugin hides Facets-managed subs from the built-in Agents panel by default and provides actions to show, hide, or toggle them.

Facets marks each Herdr Sub pane with the metadata token `facets_role=sub`. This plugin applies a transient `agent.view` filter; it does not affect `agent list`, notifications, lifecycle detection, or global attention counts.

## Link for development

```bash
herdr plugin link /absolute/path/to/facets/herdr-plugin
herdr plugin action invoke facets.agent-visibility.hide-subs
```

## Actions

```bash
herdr plugin action invoke facets.agent-visibility.toggle-subs
herdr plugin action invoke facets.agent-visibility.hide-subs
herdr plugin action invoke facets.agent-visibility.show-subs
```

The selected visibility is stored in `HERDR_PLUGIN_STATE_DIR` and restored when the Herdr server starts. The initial default is hidden.

Optional keybinding:

```toml
[[keys.command]]
key = "prefix+shift+a"
type = "plugin_action"
command = "facets.agent-visibility.toggle-subs"
description = "toggle Facets subs"
```

After editing Herdr config, run `herdr server reload-config`.
