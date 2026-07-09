# Focus Planner — Copilot CLI plugin marketplace

This repository doubles as a **GitHub Copilot CLI plugin marketplace**. Alongside
the planner web app, it publishes installable plugins that pair with your Focus
Planner workflow.

A marketplace is a registry Copilot CLI can browse and install from. This one is
defined by [`.github/plugin/marketplace.json`](../.github/plugin/marketplace.json),
and each plugin lives in its own subdirectory here under `plugins/`.

## Available plugins

| Plugin | Description |
| --- | --- |
| [`overnight-agent`](./overnight-agent) | Autonomously makes progress on your planner tasks overnight using a per-task plan → approve → execute loop. |

## Using the marketplace

Register the marketplace once, then install any plugin from it:

```shell
# Register this repo as a marketplace
copilot plugin marketplace add shivbijlani/focus-planner

# See what it offers
copilot plugin marketplace browse focus-planner

# Install a plugin from it
copilot plugin install overnight-agent@focus-planner
```

You can also install a plugin directly, without registering the marketplace:

```shell
copilot plugin install shivbijlani/focus-planner:plugins/overnight-agent
```

Or declaratively, by adding it to the `enabledPlugins` field of your
`~/.copilot/settings.json` (user-level) or a repo's `.github/copilot/settings.json`.

## Adding a new plugin to this marketplace

1. Create `plugins/<your-plugin>/` with a `plugin.json` manifest at its root.
2. Add its components (skills in `skills/<name>/SKILL.md`, agents in `agents/`,
   `hooks.json`, `.mcp.json`, etc.).
3. Register it by adding an entry to the `plugins` array in
   `.github/plugin/marketplace.json`, with `source` pointing at the plugin dir
   (e.g. `"./plugins/your-plugin"`).

See the official docs:
[Creating a plugin](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/plugins-creating)
and
[Creating a plugin marketplace](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/plugins-marketplace).

## Note on personal data

Skills that need per-user configuration (paths, accounts, email allow-lists) ship
a **placeholder `user-settings.md` template**. Because this repository is public,
never commit real personal data into a plugin here — fill in your own values only
in your local install.
