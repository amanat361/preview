# preview

Run any git branch on its own dev server, in its own worktree, without touching the checkout you're working in. Plus an Omarchy bar widget so you can see what's running and click things.

```
preview                    pick an open PR or branch, start it, then cd / claude / open it
preview up <ref>           start a preview (branch name, PR number, or PR URL)
preview list               see them all, act on one (start, stop, restart, cd, claude, delete)
preview logs <ref>
preview down <ref>         delete it (won't throw away uncommitted or unpushed work)
```

Each preview gets a worktree under `.preview-worktrees/`, a free port in 3001-3019, `.env.local` copied in, `node_modules` linked. Run `up` again on the same branch and it pulls and restarts. `down` removes the worktree and the local branch; the branch stays on origin.

## Install

Needs [bun](https://bun.sh). Builds a single binary into `~/.local/bin/preview`. On Omarchy it also installs the bar widget.

```
git clone https://github.com/amanat361/preview
cd preview && ./install.sh
```

`./install.sh --uninstall` puts everything back. Running install twice is fine.

## Per-repo config

Optional. Drop a `.previewrc.json` in the repo root when the defaults don't fit:

```json
{
  "name": "myapp",
  "start": "bun dev",
  "readyPattern": "Ready in",
  "portRange": [3001, 3019],
  "mainPort": 3000,
  "worktreeDir": ".preview-worktrees",
  "worktreePrefix": "preview-",
  "copyFiles": [".env.local"],
  "linkDirs": ["node_modules"],
  "hooks": { "setup": "scripts/preview-setup.sh", "stop": "scripts/preview-stop.sh", "info": "scripts/preview-info.sh" }
}
```

Every key is optional. Without the file: `bun dev` (or `npm run dev`), ready when "Ready in" shows up or the port answers, ports 3001-3019.

Hooks are plain scripts for whatever your project needs around a preview (point it at a backend, seed a database, that kind of thing). `setup` runs after the worktree is ready and before the server starts, `stop` after it stops, `info` prints a short label for the list. They get `PREVIEW_REPO`, `PREVIEW_WT`, `PREVIEW_BRANCH`, `PREVIEW_PORT`, `PREVIEW_ADOPTED`, and `PREVIEW_FLAGS` (any flags the tool didn't recognise, like `preview up foo --staging`).

## The bar widget

Shows how many previews are running. Click it for the list: open in the browser, start, stop, restart, terminal, claude, logs, delete. Works across every repo you've used `preview` in. Settings (refresh interval, terminal) live in your Omarchy bar config.

To install just the widget on another Omarchy machine: `omarchy plugin add https://github.com/amanat361/preview.git --enable`. It expects `preview` on your PATH.

## Scripting

```
preview status --json [--all-repos]
preview start|stop|restart [--hard]|open <ref> [--repo <path>]
preview down <ref> --force
```
