// git worktree helpers: create/adopt/fast-forward, lookups, dirty/unpushed checks.
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { $ } from "bun";
import { type Repo, slugify } from "./config";

export const log = (msg: string) => console.error(msg);

export async function git(cwd: string, ...args: string[]): Promise<string> {
  const r = await $`git -C ${cwd} ${args}`.quiet().nothrow();
  if (r.exitCode !== 0) throw new Error(r.stderr.toString().trim() || `git ${args[0]} failed`);
  return r.stdout.toString().trim();
}
export async function gitOk(cwd: string, ...args: string[]): Promise<boolean> {
  return (await $`git -C ${cwd} ${args}`.quiet().nothrow()).exitCode === 0;
}

export function canonicalWt(repo: Repo, branch: string): string {
  return join(repo.wtRoot, repo.config.worktreePrefix + slugify(branch));
}

/** true unless preview created it: only <prefix>* dirs are ours to delete */
export function isAdopted(repo: Repo, wt: string): boolean {
  return existsSync(join(wt, ".preview.external")) || !basename(wt).startsWith(repo.config.worktreePrefix);
}

/** path of the worktree that has `branch` checked out, if any */
export async function findCheckout(repo: Repo, branch: string): Promise<string | null> {
  const out = await git(repo.root, "worktree", "list", "--porcelain");
  let cur = "";
  for (const line of out.split("\n")) {
    if (line.startsWith("worktree ")) cur = line.slice(9);
    else if (line === `branch refs/heads/${branch}`) return cur;
  }
  return null;
}

export async function listWorktrees(repo: Repo): Promise<string[]> {
  const out = await git(repo.root, "worktree", "list", "--porcelain");
  return out.split("\n").filter((l) => l.startsWith("worktree ")).map((l) => l.slice(9)).filter((p) => p !== repo.root);
}

export async function currentBranch(wt: string): Promise<string> {
  return (await $`git -C ${wt} rev-parse --abbrev-ref HEAD`.quiet().nothrow()).stdout.toString().trim() || "?";
}

export async function isWorktree(dir: string): Promise<boolean> {
  return gitOk(dir, "rev-parse", "--is-inside-work-tree");
}

export interface Safety { dirty: string; unpushed: string; unpushedCount: number; noUpstream: boolean }
/** what would be lost if the worktree were deleted. Compares against @{u}, else origin/<branch>. */
export async function safety(wt: string): Promise<Safety> {
  const dirty = (await $`git -C ${wt} status --porcelain`.quiet().nothrow()).stdout.toString().trimEnd();
  let base = "";
  if (await gitOk(wt, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}")) base = "@{u}";
  else {
    const branch = await currentBranch(wt);
    if (await gitOk(wt, "show-ref", "--verify", "--quiet", `refs/remotes/origin/${branch}`)) base = `origin/${branch}`;
  }
  if (!base) return { dirty, unpushed: "(branch is not on origin — cannot confirm its commits are safe)", unpushedCount: 1, noUpstream: true };
  const unpushed = (await $`git -C ${wt} log --oneline ${base + "..HEAD"}`.quiet().nothrow()).stdout.toString().trimEnd();
  return { dirty, unpushed, unpushedCount: unpushed ? unpushed.split("\n").length : 0, noUpstream: false };
}

/** keep .preview.* out of `git status` in every worktree (branch-independent) */
export async function ignorePreviewFiles(repo: Repo) {
  const common = await git(repo.root, "rev-parse", "--path-format=absolute", "--git-common-dir");
  const excl = join(common, "info", "exclude");
  const { mkdirSync, readFileSync, appendFileSync } = await import("node:fs");
  mkdirSync(join(common, "info"), { recursive: true });
  const cur = existsSync(excl) ? readFileSync(excl, "utf8") : "";
  const lines = cur.split("\n");
  const want = [".preview.*", repo.config.worktreeDir.replace(/\/?$/, "/")];
  for (const w of want) if (!lines.includes(w)) appendFileSync(excl, w + "\n");
}
