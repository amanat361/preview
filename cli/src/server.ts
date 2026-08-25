// Start/stop dev servers as killable process groups; ports; ready wait; RAM gate.
import { existsSync, readFileSync, rmSync, statSync, writeFileSync, symlinkSync, copyFileSync } from "node:fs";
import { join, relative, dirname } from "node:path";
import { $ } from "bun";
import { type Repo, relpath } from "./config";
import { log } from "./git";
import { runHook } from "./hooks";
import { adbReverse, adbUnreverse } from "./android";
import { spawnEnv } from "./env";

export const readText = (p: string) => (existsSync(p) ? readFileSync(p, "utf8").trim() : "");
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function pidAlive(pid: number): boolean {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}
export function pidOf(wt: string): number { return Number(readText(join(wt, ".preview.pid"))) || 0; }
export function portOf(wt: string): number { return Number(readText(join(wt, ".preview.port"))) || 0; }
export function isRunning(wt: string): boolean { return pidAlive(pidOf(wt)); }
export function startedAt(wt: string): number | null {
  try { return Math.floor(statSync(join(wt, ".preview.pid")).mtimeMs / 1000); } catch { return null; }
}

export async function portInUse(port: number): Promise<boolean> {
  try {
    const s = await Bun.connect({ hostname: "127.0.0.1", port, socket: { data() {}, open(sock) { sock.end(); } } });
    s.end();
    return true;
  } catch { return false; }
}

export async function pickPort(repo: Repo): Promise<number> {
  const [from, to] = repo.config.portRange;
  for (let p = from; p <= to; p++) if (!(await portInUse(p))) return p;
  throw new Error(`no free port in ${from}-${to}`);
}

/** gate server starts on memory pressure (MemAvailable, not buff/cache-inflated "used") */
export async function checkRam(interactive: boolean) {
  let total = 0, avail = 0;
  try {
    for (const line of readFileSync("/proc/meminfo", "utf8").split("\n")) {
      if (line.startsWith("MemTotal:")) total = Number(line.split(/\s+/)[1]) / 1024;
      if (line.startsWith("MemAvailable:")) avail = Number(line.split(/\s+/)[1]) / 1024;
    }
  } catch { return; }
  if (!total) return;
  const pct = Math.round(((total - avail) * 100) / total);
  const human = `ram: ${pct}% used, ${(avail / 1024).toFixed(1)}GB of ${(total / 1024).toFixed(0)}GB available`;
  if (pct >= 95) {
    log(`refusing to start a server — ${human}`);
    log("free up memory first (try: preview list, then stop or delete one)");
    process.exit(1);
  } else if (pct >= 85) {
    log(`WARNING: memory is tight — ${human}`);
    if (interactive) {
      const reply = prompt("start the server anyway? [y/N]") || "";
      if (!/^y/i.test(reply)) process.exit(1);
    } else if (process.env.PREVIEW_FORCE !== "1") {
      log("refusing (non-interactive); set PREVIEW_FORCE=1 to override");
      process.exit(1);
    }
  } else if (pct >= 70) log(`warning: ${human}`);
  else log(human);
}

/** env + linked dirs so the start command can run (idempotent) */
export function ensureSetup(repo: Repo, wt: string) {
  for (const f of repo.config.copyFiles) {
    const dst = join(wt, f), src = join(repo.root, f);
    if (!existsSync(dst) && existsSync(src)) copyFileSync(src, dst);
  }
  for (const d of repo.config.linkDirs) {
    const dst = join(wt, d), src = join(repo.root, d);
    if (!existsSync(dst) && existsSync(src)) symlinkSync(relative(dirname(dst), src), dst);
  }
}

async function killGroup(pid: number) {
  if (!pidAlive(pid)) return;
  try { process.kill(-pid, "SIGTERM"); } catch { try { process.kill(pid, "SIGTERM"); } catch {} }
  for (let i = 0; i < 40 && pidAlive(pid); i++) await sleep(250);
  try { process.kill(-pid, "SIGKILL"); } catch {}
}

export async function stopServer(repo: Repo, wt: string) {
  await adbUnreverse(portOf(wt));
  const pidfile = join(wt, ".preview.pid");
  await killGroup(pidOf(wt));
  rmSync(pidfile, { force: true });
  await runHook(repo, "stop", wt, await branchOf(wt), portOf(wt));
  // belt-and-suspenders: anything still running out of this worktree. Never match the linked
  // node_modules target: `pkill -f "<wt>/node_modules/.bin/next"` is what the bash version did;
  // we match the worktree path itself, which a linked dir resolves away from.
  await $`pkill -f ${wt + "/node_modules/.bin/"}`.quiet().nothrow();
}

async function branchOf(wt: string) {
  return (await $`git -C ${wt} rev-parse --abbrev-ref HEAD`.quiet().nothrow()).stdout.toString().trim() || "?";
}

/** start (restarting if needed); desired port empty → reuse last, else pick free */
export async function startServer(repo: Repo, wt: string, wanted?: number): Promise<number> {
  await stopServer(repo, wt);
  let port = wanted || 0;
  // the repo's setup hook runs between stop and start, so anything it launches (a backend
  // watcher, say) is not killed by the stop that precedes every start
  await runHook(repo, "setup", wt, await branchOf(wt), port || portOf(wt));
  if (!port) {
    port = portOf(wt);
    if (port) {
      for (let i = 0; i < 20 && (await portInUse(port)); i++) await sleep(250);
      if (await portInUse(port)) port = 0;
    }
    if (!port) port = await pickPort(repo);
  }
  writeFileSync(join(wt, ".preview.port"), `${port}\n`);
  const pidfile = join(wt, ".preview.pid"), logfile = join(wt, ".preview.log");
  rmSync(pidfile, { force: true });
  writeFileSync(logfile, "");

  // the bash -c session leader records its own pid, then exec keeps that pid for the server,
  // so .preview.pid is always the killable process-group id
  const child = Bun.spawn(["setsid", "bash", "-c", 'echo $$ >"$1"; cd "$2"; eval "exec $3"', "bash", pidfile, wt, repo.config.start], {
    cwd: wt,
    env: spawnEnv({ PORT: String(port) }),
    stdin: "ignore",
    stdout: Bun.file(logfile),
    stderr: Bun.file(logfile),
  });
  child.unref();

  for (let i = 0; i < 50 && !readText(pidfile); i++) await sleep(100);
  const pid = Number(readText(pidfile)) || 0;

  const deadline = Date.now() + repo.config.readyTimeoutSec * 1000;
  let ready = false;
  while (Date.now() < deadline) {
    if (readText(logfile).includes(repo.config.readyPattern)) { ready = true; break; }
    if (await portInUse(port)) { ready = true; break; } // repos without the pattern
    if (pid && !pidAlive(pid)) {
      log("error: server died, last log lines:");
      log(readText(logfile).split("\n").slice(-20).join("\n"));
      throw new Error("server died");
    }
    await sleep(500);
  }
  if (!ready) log(`warning: server not ready after ${repo.config.readyTimeoutSec}s — check ${relpath(repo, logfile)}`);

  // confirm it is actually listening on OUR port (Next silently hops ports if busy)
  for (let i = 0; i < 20 && !(await portInUse(port)); i++) await sleep(500);
  if (!(await portInUse(port))) {
    log(`warning: server reported ready but :${port} is not listening — check ${relpath(repo, logfile)}`);
    const m = readText(logfile).split("\n").find((l) => /port/i.test(l));
    if (m) log(m);
    throw new Error("port not listening");
  }
  if (pid && !pidAlive(pid)) {
    log("error: server exited right after starting, last log lines:");
    log(readText(logfile).split("\n").slice(-20).join("\n"));
    throw new Error("server died");
  }
  console.log(`✓ http://localhost:${port}`);
  await adbReverse(port);
  return port;
}
