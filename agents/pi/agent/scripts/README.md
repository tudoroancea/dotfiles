# Pi extension updates

Run `nub run check:extensions` from `agents/pi/` to inspect updates:

- `npm outdated --prefix ~/.pi/agent/npm` checks installed npm packages.
- The Git fetch and log inspect incoming `pi-context-usage` commits.

Package sources are pinned in `agent/settings.json`. Review release notes before changing a pin with `pi install`. FFF is pinned separately in `agent/extensions/fff/package.json` and installed through the Nub workspace.

The deployed package stores live under `~/.pi/agent`. Do not update shared stores from a secondary worktree.
