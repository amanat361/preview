// The verbs: up, start, stop, restart, open, logs, down. Shared by the CLI, the menu and the widget.
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { $ } from "bun";
import { type Repo, relpath } from "./config";
import { git, gitOk, log, canonicalWt, findCheckout, isAdopted, currentBranch, safety } from "./git";
import { startServer, stopServer, checkRam, ensureSetup, isRunning, portOf, pidOf, portInUse, readText } from "./server";
import { registerRepo } from "./registry";
import { resolveBranch } from "./github";
import { adbReady, openOnAndroid } from "./android";

export const isTty = () => Boolean(process.stdin.isTTY && process.stdout.isTTY);

/** the worktree for a branch (canonical or adopted) */
export async function wtFor(repo: Repo, branch: string): Promise<string> {
  const c = canonicalWt(repo, branch);
  if (existsSync(c)) return c;
  const found = await findCheckout(repo, branch);
  if (found && existsSync(found)) return found;
  throw new Error(`no preview for ${branch}`);
}

export async function up(repo: Repo, ref: string, wantedPort?: number) {
  await checkRam(isTty());
  const branch = await resolveBranch(ref, repo.root);
  let wt = canonicalWt(repo, branch), external = false;

  log(`fetching origin/${branch}…`);
  await git(repo.root, "fetch", "origin", "--quiet", branch);

  const existing = await findCheckout(repo, branch);
  if (existing && existing !== wt) {
    if (existing === repo.root) throw new Error(`${branch} is checked out in the main repo — the main dev server already serves it`);
    // branch is live in another worktree (e.g. an agent mid-task): adopt it, never remove it on down
    wt = existing; external = true;
    log(`adopting: branch is already checked out in ${relpath(repo, wt)} — serving that worktree's live state`);
  } else if (!existsSync(wt)) {
    log(`creating worktree ${relpath(repo, wt)}`);
    if (await gitOk(repo.root, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`)) await git(repo.root, "worktree", "add", "--quiet", wt, branch);
    else await git(repo.root, "worktree", "add", "--quiet", "--track", "-b", branch, wt, `origin/${branch}`);
  } else {
    const before = await git(wt, "rev-parse", "HEAD");
    if (!(await gitOk(wt, "merge", "--ff-only", "--quiet", `origin/${branch}`))) log("note: could not fast-forward, previewing local state");
    const after = await git(wt, "rev-parse", "HEAD");
    if (before !== after) log(`updated: ${await git(wt, "rev-list", "--count", `${before}..${after}`)} new commit(s) from origin/${branch}`);
  }

  ensureSetup(repo, wt);
  if (external) writeFileSync(join(wt, ".preview.external"), "");
  registerRepo(repo.root);

  const oldpid = pidOf(wt);
  if (oldpid && isRunning(wt)) log(`restarting: stopped previous server on :${portOf(wt) || "?"}`);
  await startServer(repo, wt, wantedPort);
  console.log(`  branch:   ${branch}`);
  console.log(`  worktree: ${relpath(repo, wt)}`);
  const { infoLabel } = await import("./hooks");
  const info = await infoLabel(repo, wt, branch, portOf(wt));
  if (info) console.log(`  info:     ${info}`);
}

export async function start(repo: Repo, wt: string) {
  if (isAdopted(repo, wt)) writeFileSync(join(wt, ".preview.external"), ""); // never auto-delete it
  ensureSetup(repo, wt);
  await checkRam(isTty());
  await startServer(repo, wt); // reuse its last port, or pick a free one
}

export async function reload(repo: Repo, wt: string, hard = false) {
  const branch = await currentBranch(wt);
  if (hard) { log("clearing .next for a full rebuild…"); rmSync(join(wt, ".next"), { recursive: true, force: true }); }
  log(`reloading ${branch}…`);
  await checkRam(isTty());
  await startServer(repo, wt, portOf(wt) || undefined);
}

export async function stop(repo: Repo, wt: string) {
  const branch = await currentBranch(wt);
  await stopServer(repo, wt);
  console.log(`✓ stopped ${branch} (kept — start it again from 'preview list')`);
}

export async function openBrowser(wt: string) {
  const port = portOf(wt);
  if (!port || !(await portInUse(port))) { log("not running — start it first"); return; }
  Bun.spawn(["xdg-open", `http://localhost:${port}`], { stdio: ["ignore", "ignore", "ignore"] }).unref();
  console.log(`opened http://localhost:${port}`);
}

export async function openAndroid(wt: string) {
  const port = portOf(wt);
  if (!port || !(await portInUse(port))) { log("not running — start it first"); return; }
  await openOnAndroid(port);
}

export function logs(wt: string, n = 50): string {
  const f = join(wt, ".preview.log");
  if (!existsSync(f)) throw new Error("no preview log");
  return readText(f).split("\n").slice(-n).join("\n");
}

/** remove worktree + local branch; adopted → stop only + print the manual command */
export async function deleteForce(repo: Repo, wt: string) {
  if (!existsSync(wt)) throw new Error(`no preview at ${wt}`);
  const branch = await currentBranch(wt);
  const wasRunning = isRunning(wt);
  await stopServer(repo, wt);
  if (isAdopted(repo, wt)) {
    for (const f of [".preview.port", ".preview.log", ".preview.external"]) rmSync(join(wt, f), { force: true });
    if (wasRunning) console.log("server stopped.");
    console.log(`keeping ${branch} — it wasn't created by preview, so it was NOT deleted.`);
    console.log("to remove it yourself:");
    console.log(`  git worktree remove --force '${wt}' && git branch -D '${branch}'`);
    return;
  }
  await git(repo.root, "worktree", "remove", "--force", wt);
  if (!["dev", "main", "master", "?", ""].includes(branch)) {
    if (await gitOk(repo.root, "branch", "-D", branch)) console.log(`  deleted local branch ${branch} (still on origin)`);
  }
  console.log(`✓ removed ${wt.split("/").pop()}`);
}

/** like force, but refuse to silently lose unpushed/uncommitted work. Exit 2 when unsafe + non-interactive. */
export async function deleteGuarded(repo: Repo, wt: string): Promise<boolean> {
  if (!existsSync(wt)) throw new Error(`no preview at ${wt}`);
  if (isAdopted(repo, wt)) { await deleteForce(repo, wt); return true; }
  const s = await safety(wt);
  let warn = "";
  if (s.dirty) warn += `  • uncommitted changes:\n${s.dirty.replace(/^/gm, "      ")}\n`;
  if (s.unpushed) warn += `  • commits not on origin:\n${s.unpushed.replace(/^/gm, "      ")}\n`;
  if (warn) {
    log("⚠ deleting this worktree PERMANENTLY LOSES the following — a later 'preview up' would NOT restore it:");
    process.stderr.write(warn);
    if (isTty()) {
      const reply = prompt("delete anyway? [y/N]") || "";
      if (!/^y/i.test(reply)) { console.log("kept."); return false; }
    } else {
      log("refusing to delete (unsafe, non-interactive)");
      process.exit(2);
    }
  }
  await deleteForce(repo, wt);
  return true;
}

export { adbReady };
