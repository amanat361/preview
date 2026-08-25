// The JSON contract the bar widget reads. Also backs `list`.
import { type Repo, findRepo } from "./config";
import { isAdopted, isWorktree, currentBranch, safety } from "./git";
import { isRunning, portOf, pidOf, portInUse, startedAt } from "./server";
import { infoLabel } from "./hooks";
import { readRegistry } from "./registry";
import { readdirSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";

export interface PreviewStatus {
  branch: string; worktree: string; port: number | null; pid: number | null; running: boolean;
  adopted: boolean; dirty: boolean; unpushed: number; info: string; startedAt: number | null;
}
export interface RepoStatus {
  name: string; path: string; main: { port: number; running: boolean; branch: string } | null; previews: PreviewStatus[];
}

export async function worktreeDirs(repo: Repo): Promise<string[]> {
  if (!existsSync(repo.wtRoot)) return [];
  const out: string[] = [];
  for (const name of readdirSync(repo.wtRoot)) {
    const wt = join(repo.wtRoot, name);
    try { if (!statSync(wt).isDirectory()) continue; } catch { continue; }
    if (await isWorktree(wt)) out.push(wt); // skip stray dirs
  }
  return out;
}

export async function previewStatus(repo: Repo, wt: string, withSafety = true): Promise<PreviewStatus> {
  const branch = await currentBranch(wt);
  const running = isRunning(wt);
  const port = portOf(wt) || null;
  const s = withSafety && !isAdopted(repo, wt) ? await safety(wt) : null;
  return {
    branch, worktree: wt, port, pid: running ? pidOf(wt) : null, running,
    adopted: isAdopted(repo, wt),
    dirty: !!s?.dirty, unpushed: s?.unpushedCount ?? 0,
    info: await infoLabel(repo, wt, branch, port || 0),
    startedAt: running ? startedAt(wt) : null,
  };
}

export async function repoStatus(repo: Repo): Promise<RepoStatus> {
  const previews = await Promise.all((await worktreeDirs(repo)).map((wt) => previewStatus(repo, wt)));
  previews.sort((a, b) => Number(b.running) - Number(a.running) || (a.port || 0) - (b.port || 0) || a.branch.localeCompare(b.branch));
  const mp = repo.config.mainPort;
  const main = mp ? { port: mp, running: await portInUse(mp), branch: await currentBranch(repo.root) } : null;
  return { name: repo.config.name, path: repo.root, main, previews };
}

export async function allRepoStatus(current: Repo | null, allRepos: boolean): Promise<RepoStatus[]> {
  const roots = new Set<string>();
  if (current) roots.add(current.root);
  if (allRepos) for (const r of readRegistry()) roots.add(r);
  const out: RepoStatus[] = [];
  for (const root of roots) {
    try { out.push(await repoStatus(root === current?.root ? current! : await findRepo(root))); } catch {}
  }
  return out;
}
