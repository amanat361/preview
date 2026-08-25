// Environment for spawned servers and hooks. A GUI process (the bar widget) has a much
// shorter PATH than a login shell, so add the usual per-user tool dirs when they exist.
import { existsSync } from "node:fs";
import { join } from "node:path";

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
  return { ...process.env, ...extra, PATH: parts.join(":") };
}
