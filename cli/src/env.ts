// Environment for spawned servers and hooks. A GUI process (the bar widget) has a much
// shorter PATH than a login shell, so add the usual per-user tool dirs when they exist.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Bun auto-loads these from the directory `preview` was launched in (usually the main
// checkout) straight into process.env. Passed on to a hook or dev server, those values
// outrank the worktree's own .env.local (env beats file for Next, the Convex CLI, and most
// tools), so every preview would silently use the main checkout's backend. Drop every
// key those files define; each worktree's copied .env.local is the only source.
const DOTENV_FILES = [".env", ".env.local", ".env.development", ".env.development.local", ".env.production", ".env.production.local"];

function launchDirDotenvKeys(): Set<string> {
  const keys = new Set<string>();
  for (const f of DOTENV_FILES) {
    const p = join(process.cwd(), f);
    if (!existsSync(p)) continue;
    for (const line of readFileSync(p, "utf8").split("\n")) {
      const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
      if (m) keys.add(m[1]);
    }
  }
  return keys;
}
const leaked = launchDirDotenvKeys();

export function spawnEnv(extra: Record<string, string> = {}): Record<string, string | undefined> {
  const home = process.env.HOME || "";
  const candidates = [
    join(home, ".bun", "bin"),
    join(home, ".local", "bin"),
    join(home, ".local", "share", "mise", "shims"),
    join(home, ".cargo", "bin"),
    join(home, ".volta", "bin"),
    join(home, ".nvm", "current", "bin"),
    "/usr/local/bin",
  ];
  const parts = (process.env.PATH || "").split(":").filter(Boolean);
  for (const c of candidates) if (existsSync(c) && !parts.includes(c)) parts.unshift(c);
  const base: Record<string, string | undefined> = { ...process.env };
  for (const k of leaked) delete base[k];
  return { ...base, ...extra, PATH: parts.join(":") };
}
