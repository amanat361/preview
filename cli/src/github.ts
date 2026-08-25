// Turn a PR number / "#N" / PR URL into its head branch via gh. Plain branch names pass through.
import { $ } from "bun";

export async function resolveBranch(ref: string, repoRoot: string): Promise<string> {
  let num = "";
  if (ref.startsWith("#")) num = ref.slice(1);
  else if (/github\.com\/.*\/pull\//.test(ref)) num = (ref.split("/pull/")[1] || "").match(/^\d+/)?.[0] || "";
  else if (/^\d+$/.test(ref)) num = ref;
  if (!num) return ref;
  if (!/^\d+$/.test(num)) throw new Error(`cannot parse PR ref '${ref}'`);
  if (!Bun.which("gh")) throw new Error("gh CLI required for PR refs");
  const r = await $`gh pr view ${num} --json headRefName,isCrossRepository --jq ${'.headRefName + " " + (.isCrossRepository|tostring)'}`.cwd(repoRoot).quiet().nothrow();
  if (r.exitCode !== 0) throw new Error(`PR #${num} not found`);
  const [head, cross] = r.stdout.toString().trim().split(" ");
  if (cross === "true") throw new Error(`PR #${num} is from a fork — its head branch is not on origin`);
  console.error(`#${num} → ${head}`);
  return head;
}

/** "branch\t#N  title" lines for open same-repo PRs, or [] without gh */
export async function openPrs(repoRoot: string): Promise<string[]> {
  if (!Bun.which("gh")) return [];
  const r = await $`gh pr list --limit 50 --json number,title,headRefName,isCrossRepository --jq ${'.[] | select(.isCrossRepository|not) | .headRefName + "\t#" + (.number|tostring) + "  " + .title'}`.cwd(repoRoot).quiet().nothrow();
  return r.exitCode === 0 ? r.stdout.toString().split("\n").filter(Boolean) : [];
}
