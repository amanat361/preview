// Run a repo's optional hook scripts with PREVIEW_* env. Project specifics live there, not here.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { type Repo } from "./config";
import { isAdopted } from "./git";
import { spawnEnv } from "./env";

export let passthroughFlags: string[] = [];
export function setPassthroughFlags(flags: string[]) { passthroughFlags = flags; }

export function hookEnv(repo: Repo, wt: string, branch: string, port: number) {
  return spawnEnv({
    PREVIEW_REPO: repo.root,
    PREVIEW_WT: wt,
    PREVIEW_WT_ROOT: repo.wtRoot,
    PREVIEW_BRANCH: branch,
    PREVIEW_PORT: port ? String(port) : "",
    PREVIEW_ADOPTED: isAdopted(repo, wt) ? "1" : "0",
    PREVIEW_FLAGS: passthroughFlags.join(" "),
  });
}

/** Run hook `name` if configured. Output goes to the terminal; non-zero exit throws. */
export async function runHook(repo: Repo, name: "setup" | "stop", wt: string, branch: string, port: number) {
  const rel = repo.config.hooks[name];
  if (!rel) return;
  const script = join(repo.root, rel);
  if (!existsSync(script)) throw new Error(`hook ${name}: ${rel} not found`);
  const p = Bun.spawn(["bash", script], { cwd: wt, env: hookEnv(repo, wt, branch, port), stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  const code = await p.exited;
  if (code !== 0) throw new Error(`hook ${name} failed (exit ${code})`);
}

/** `info` hook: one short label for list/status, "" if none */
export async function infoLabel(repo: Repo, wt: string, branch: string, port: number): Promise<string> {
  const rel = repo.config.hooks.info;
  if (!rel) return "";
  const script = join(repo.root, rel);
  if (!existsSync(script)) return "";
  const p = Bun.spawn(["bash", script], { cwd: wt, env: hookEnv(repo, wt, branch, port), stdin: "ignore", stdout: "pipe", stderr: "ignore" });
  const text = await new Response(p.stdout).text();
  await p.exited;
  return text.trim().split("\n")[0] || "";
}
