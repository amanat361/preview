// preview — run any branch on its own dev server in an ephemeral worktree, and manage them.
import { findRepo, type Repo } from "./config";
import { ignorePreviewFiles, log } from "./git";
import { setPassthroughFlags } from "./hooks";
import { resolveBranch } from "./github";
import { allRepoStatus } from "./status";
import { readRegistry } from "./registry";
import * as cmd from "./commands";
import { list, picker } from "./interactive";

const HELP = `preview: run a branch on its own dev server, in its own worktree.

  preview                 pick a PR or branch and start it
  preview up <ref>        start one (branch, PR number, or PR URL)
  preview list            see them all, pick one to manage
  preview down <ref>      delete one (keeps anything unpushed)

  preview logs <ref>      last 50 log lines
  preview start|stop|restart|open <ref>
  preview status          plain table, or --json

More: preview help all`;

const HELP_ALL = `${HELP}

  preview up <ref> [port] [flags]   flags the tool doesn't know go to the repo's hooks
  preview down --all                delete every preview (same guard)
  preview down <ref> --force        skip the guard
  preview restart <ref> --hard      clear the build cache first
  preview status --json --all-repos every repo this tool has been used in
  preview repos                     list those repos
  --repo <path>                     act on that repo instead of the current one

Worktrees live in .preview-worktrees/ (or wherever .previewrc.json says), get a free port
from 3001-3019, .env.local copied in and node_modules linked. Running "up" again on the
same branch pulls and restarts it.

Config is optional: a .previewrc.json in the repo root with any of
  name, start, readyPattern, portRange, mainPort, worktreeDir, worktreePrefix,
  copyFiles, linkDirs, hooks.setup / hooks.stop / hooks.info
See https://github.com/amanat361/preview`;

const KNOWN = new Set(["--json", "--all-repos", "--force", "--hard", "--all", "-h", "--help"]);
const argv = process.argv.slice(2);
const pos: string[] = [], flags = new Set<string>(), passthrough: string[] = [];
let repoArg = "";
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--repo") { repoArg = argv[++i] || ""; continue; }
  if (KNOWN.has(a)) flags.add(a);
  else if (a.startsWith("-")) passthrough.push(a);
  else pos.push(a);
}
setPassthroughFlags(passthrough);

const [verb, ...rest] = pos;

async function repoOrNull(): Promise<Repo | null> {
  try { return await findRepo(repoArg || process.cwd()); } catch { return null; }
}
async function repo(): Promise<Repo> {
  const r = await findRepo(repoArg || process.cwd());
  await ignorePreviewFiles(r); // self-heal the shared git exclude before doing anything
  return r;
}
async function target(r: Repo, ref: string | undefined, usage: string) {
  if (!ref) throw new Error(usage);
  const branch = await resolveBranch(ref, r.root);
  return { branch, wt: await cmd.wtFor(r, branch) };
}

try {
  if (flags.has("-h") || flags.has("--help") || verb === "help") { console.log(rest[0] === "all" || flags.has("--all") ? HELP_ALL : HELP); process.exit(0); }
  switch (verb) {
    case undefined: await picker(await repo()); break;
    case "up": {
      const r = await repo();
      if (!rest[0]) throw new Error("usage: preview up <branch|#PR|PR-url> [port]");
      await cmd.up(r, rest[0], rest[1] ? Number(rest[1]) : undefined);
      break;
    }
    case "list": await list(await repo()); break;
    case "logs": {
      const r = await repo();
      const { wt } = await target(r, rest[0], "usage: preview logs <ref> [n]");
      console.log(cmd.logs(wt, rest[1] ? Number(rest[1]) : 50));
      break;
    }
    case "start": { const r = await repo(); const { wt } = await target(r, rest[0], "usage: preview start <ref>"); await cmd.start(r, wt); break; }
    case "stop": { const r = await repo(); const { wt } = await target(r, rest[0], "usage: preview stop <ref>"); await cmd.stop(r, wt); break; }
    case "restart": { const r = await repo(); const { wt } = await target(r, rest[0], "usage: preview restart <ref> [--hard]"); await cmd.reload(r, wt, flags.has("--hard")); break; }
    case "open": { const r = await repo(); const { wt } = await target(r, rest[0], "usage: preview open <ref>"); await cmd.openBrowser(wt); break; }
    case "down": {
      const r = await repo();
      if (flags.has("--all")) {
        const { worktreeDirs } = await import("./status");
        const { existsSync } = await import("node:fs");
        let found = false;
        for (const wt of await worktreeDirs(r)) {
          if (!existsSync(`${wt}/.preview.port`)) continue; // only worktrees this tool serves
          found = true; await cmd.deleteGuarded(r, wt);
        }
        if (!found) console.log("no previews");
        break;
      }
      if (!rest[0]) {
        console.log("preview down <branch>|--all   deletes a preview (guarded).");
        console.log("to start / stop / restart / cd / open / delete any worktree, run: preview list");
        break;
      }
      const { wt } = await target(r, rest[0], "usage: preview down <ref>");
      if (flags.has("--force")) await cmd.deleteForce(r, wt); else await cmd.deleteGuarded(r, wt);
      break;
    }
    case "status": {
      const repos = await allRepoStatus(await repoOrNull(), flags.has("--all-repos"));
      if (flags.has("--json")) { console.log(JSON.stringify({ repos }, null, 2)); break; }
      for (const rs of repos) {
        console.log(`${rs.name}  ${rs.path}${rs.main ? `  (main :${rs.main.port} ${rs.main.running ? "running" : "stopped"})` : ""}`);
        for (const p of rs.previews) {
          const marks = [p.adopted && "adopted", p.dirty && "uncommitted", p.unpushed && `${p.unpushed} unpushed`, p.info].filter(Boolean).join(" · ");
          console.log(`  ${p.running ? `:${p.port}`.padEnd(6) : "-".padEnd(6)} ${p.running ? "running" : "stopped"}  ${p.branch}${marks ? `  [${marks}]` : ""}`);
        }
        if (!rs.previews.length) console.log("  (no previews)");
      }
      break;
    }
    case "repos": readRegistry().forEach((p) => console.log(p)); break;
    default: log(HELP); process.exit(1);
  }
} catch (e: any) {
  log(`error: ${e?.message || e}`);
  process.exit(process.exitCode || 1);
}
