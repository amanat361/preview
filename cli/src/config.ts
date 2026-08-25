// Repo discovery + .previewrc.json loading with defaults.
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { $ } from "bun";

export interface Hooks {
  setup?: string;
  stop?: string;
  info?: string;
}

export interface Config {
  name: string;
  start: string;
  readyPattern: string;
  readyTimeoutSec: number;
  portRange: [number, number];
  mainPort: number | null;
  worktreeDir: string;
  worktreePrefix: string;
  copyFiles: string[];
  linkDirs: string[];
  hooks: Hooks;
}

export interface Repo {
  root: string; // main checkout (git common dir parent)
  wtRoot: string; // absolute worktree dir
  config: Config;
}

export const CONFIG_FILE = ".previewrc.json";

function defaults(root: string): Config {
  const hasBun = existsSync(join(root, "bun.lock")) || existsSync(join(root, "bun.lockb"));
  return {
    name: root.split("/").pop() || "repo",
    start: hasBun ? "bun dev" : "npm run dev",
    readyPattern: "Ready in",
    readyTimeoutSec: 60,
    portRange: [3001, 3019],
    mainPort: 3000,
    worktreeDir: ".preview-worktrees",
    worktreePrefix: "preview-",
    copyFiles: [".env.local"],
    linkDirs: ["node_modules"],
    hooks: {},
  };
}

export function loadConfig(root: string): Config {
  const base = defaults(root);
  const file = join(root, CONFIG_FILE);
  if (!existsSync(file)) return base;
  let raw: any;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (e: any) {
    throw new Error(`${CONFIG_FILE}: ${e.message}`);
  }
  const cfg: Config = { ...base, ...raw, hooks: { ...raw.hooks } };
  if (raw.mainPort === false) cfg.mainPort = null;
  if (!Array.isArray(cfg.portRange) || cfg.portRange.length !== 2) throw new Error(`${CONFIG_FILE}: portRange must be [from, to]`);
  return cfg;
}

/** Resolve the MAIN repo for a directory (works from inside a worktree). */
export async function findRepo(dir: string = process.cwd()): Promise<Repo> {
  const res = await $`git -C ${dir} rev-parse --path-format=absolute --git-common-dir`.quiet().nothrow();
  if (res.exitCode !== 0) throw new Error(`not a git repository: ${dir}`);
  const common = res.stdout.toString().trim();
  const root = resolve(common, "..");
  const config = loadConfig(root);
  return { root, wtRoot: resolve(root, config.worktreeDir), config };
}

export function relpath(repo: Repo, p: string): string {
  return p.startsWith(repo.root + "/") ? p.slice(repo.root.length + 1) : p;
}

export function slugify(branch: string): string {
  return branch.replace(/\//g, "-");
}
