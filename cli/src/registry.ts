// Remembers which repos preview has served, so the bar widget can list them all.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dir = join(process.env.XDG_STATE_HOME || join(process.env.HOME || "~", ".local", "state"), "preview");
const file = join(dir, "repos");

export function readRegistry(): string[] {
  if (!existsSync(file)) return [];
  const paths = readFileSync(file, "utf8").split("\n").map((s) => s.trim()).filter(Boolean);
  const alive = paths.filter((p) => existsSync(p));
  if (alive.length !== paths.length) write(alive);
  return alive;
}
export function registerRepo(root: string) {
  const cur = readRegistry();
  if (!cur.includes(root)) write([...cur, root]);
}
function write(paths: string[]) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, paths.map((p) => p + "\n").join(""));
}
export const registryDir = dir;
