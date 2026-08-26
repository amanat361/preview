// Human UI: fzf pickers and the per-worktree action menu. Never used by agents or the widget.
import { existsSync } from "node:fs";
import { $ } from "bun";
import { type Repo, relpath } from "./config";
import { git, log, isAdopted, currentBranch } from "./git";
import { isRunning, portOf } from "./server";
import { worktreeDirs, previewStatus } from "./status";
import { openPrs } from "./github";
import * as cmd from "./commands";
import { adbReady } from "./android";

async function fzf(lines: string[], args: string[]): Promise<string | null> {
  if (!Bun.which("fzf")) {
    console.log("pick one:");
    lines.forEach((l, i) => console.log(`${i + 1}) ${l.split("\t").pop()}`));
    const n = Number(prompt("#") || 0);
    return lines[n - 1] ?? null;
  }
  const p = Bun.spawn(["fzf", ...args], { stdin: "pipe", stdout: "pipe", stderr: "inherit" });
  p.stdin.write(lines.join("\n") + "\n");
  await p.stdin.end();
  const out = (await new Response(p.stdout).text()).trim();
  return (await p.exited) === 0 && out ? out : null;
}

async function readKey(): Promise<string> {
  // raw single keypress from the tty; a bare Escape quits, arrow-key sequences are drained
  const tty = Bun.file("/dev/tty");
  const reader = tty.stream().getReader();
  await $`stty -icanon -echo min 1 < /dev/tty`.nothrow().quiet();
  try {
    const { value } = await reader.read();
    const s = new TextDecoder().decode(value || new Uint8Array());
    return s[0] === "\x1b" && s.length > 1 ? "" : s[0] || "";
  } finally {
    // cancel, not releaseLock: a released reader leaves a read pending on /dev/tty, which then
    // competes with a spawned shell for keystrokes and gets preview stopped with SIGTTIN
    await reader.cancel();
    await $`stty icanon echo < /dev/tty`.nothrow().quiet();
  }
}

export async function rows(repo: Repo): Promise<{ wt: string; label: string; running: boolean }[]> {
  const out = [];
  for (const wt of await worktreeDirs(repo)) {
    const s = await previewStatus(repo, wt, false);
    let flag = s.adopted ? " *" : "";
    if (s.info) flag += ` [${s.info}]`;
    const label = s.running ? `:${String(s.port).padEnd(5)} running  ${s.branch}${flag}` : `-      stopped  ${s.branch}${flag}`;
    out.push({ wt, label, running: s.running });
  }
  out.sort((a, b) => Number(b.running) - Number(a.running) || a.label.localeCompare(b.label));
  return out;
}

export async function list(repo: Repo) {
  const r = await rows(repo);
  if (!r.length) { console.log("no worktrees"); return; }
  if (!cmd.isTty() || !existsSync("/dev/tty")) {
    r.forEach((x) => console.log(x.label));
    console.log("(* = adopted, [..] = info from the repo's hook)");
    return;
  }
  const sel = await fzf(r.map((x) => `${x.wt}\t${x.label}`), ["--height=50%", "--reverse", "--prompt=worktree> ", "--delimiter=\t", "--with-nth=2", "--header=enter to manage  ·  * = adopted"]);
  if (!sel) return;
  await actionMenu(repo, sel.split("\t")[0]);
}

export async function actionMenu(repo: Repo, wt: string) {
  const branch = await currentBranch(wt);
  const adopted = isAdopted(repo, wt) ? " *" : "";
  // loops so several things can be done in one sitting; state is re-read every pass
  while (true) {
    if (!existsSync(wt)) { log("worktree is gone"); return; }
    const running = isRunning(wt);
    log("");
    log(`${branch}${adopted} — ${running ? `running :${portOf(wt) || "?"}` : "stopped"}`);
    if (running) {
      log("  [o] open browser   [r] restart      [R] hard restart   [s] stop");
      log("  [c] cd (shell)     [k] claude       [d] delete         [D] force delete");
      if (await adbReady()) log("  [a] open on android (firefox, over usb)");
    } else {
      log("  [u] start          [c] cd (shell)   [k] claude");
      log("  [d] delete         [D] force delete");
    }
    log("  [q] quit");
    process.stderr.write("> ");
    const k = await readKey();
    log("");
    try {
      switch (k) {
        case "u": await cmd.start(repo, wt); break;
        case "r": await cmd.reload(repo, wt); break;
        case "R": await cmd.reload(repo, wt, true); break;
        case "s": await cmd.stop(repo, wt); break;
        case "o": await cmd.openBrowser(wt); break;
        case "a": await cmd.openAndroid(wt); break;
        case "c": await exec(wt, [process.env.SHELL || "bash"]); return;
        case "k": await exec(wt, ["claude"]); return;
        case "d": await cmd.deleteGuarded(repo, wt); if (!existsSync(wt)) return; break;
        case "D": await cmd.deleteForce(repo, wt); if (!existsSync(wt)) return; break;
        case "q": case "Q": case "": case "\r": case "\n": case "\x1b": return;
        default: log(`unknown action '${k}'`);
      }
    } catch (e: any) { log(`error: ${e.message}`); }
  }
}

async function exec(cwd: string, argv: string[]) {
  const p = Bun.spawn(argv, { cwd, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  process.exit(await p.exited);
}

/** bare `preview`: pick an open PR or branch, start it, then offer cd / claude / browser */
export async function picker(repo: Repo) {
  if (!cmd.isTty()) throw new Error("interactive mode needs a terminal; use explicit subcommands");
  // list what we have locally right away; the fetch runs in the background and is only awaited
  // when the user picks something (a slow network must never block the picker)
  const fetching = $`git -C ${repo.root} fetch origin --prune --quiet`.nothrow().quiet();
  const prs = await openPrs(repo.root);
  const refs = (await git(repo.root, "for-each-ref", "refs/remotes/origin", "--sort=-committerdate", "--format=%(refname:lstrip=3)\t%(refname:lstrip=3)")).split("\n").filter((l) => l && !l.startsWith("HEAD\t"));
  const seen = new Set<string>(), entries: string[] = [];
  for (const l of [...prs, ...refs]) { const b = l.split("\t")[0]; if (!seen.has(b)) { seen.add(b); entries.push(l); } }
  const sel = await fzf(entries, ["--height=50%", "--reverse", "--prompt=preview> ", "--delimiter=\t", "--with-nth=2", "--preview", `git -C '${repo.root}' log --oneline -8 --color=always origin/{1}`]);
  if (!sel) return;
  const branch = sel.split("\t")[0];
  await fetching;
  await cmd.up(repo, branch);
  const wt = await cmd.wtFor(repo, branch);
  const port = portOf(wt);
  const android = (await adbReady()) ? "   [a] android" : "";
  process.stdout.write(`\n[c] cd   [k] claude   [o] open browser${android}   [enter] done > `);
  const k = (await readKey()).toLowerCase();
  console.log("");
  if (k === "c") await exec(wt, [process.env.SHELL || "bash"]);
  else if (k === "k") await exec(wt, ["claude"]);
  else if (k === "o") Bun.spawn(["xdg-open", `http://localhost:${port}`], { stdio: ["ignore", "ignore", "ignore"] }).unref();
  else if (k === "a") await cmd.openAndroid(wt);
}
