// Pure helpers for the Preview bar widget: parsing `preview status --json`,
// formatting row labels and relative times, shell quoting, and flat row lists.

function shellQuote(value) {
  var text = String(value === undefined || value === null ? "" : value)
  return "'" + text.replace(/'/g, "'\\''") + "'"
}

function shellJoin(argv) {
  var parts = []
  for (var i = 0; i < (argv || []).length; i++) parts.push(shellQuote(argv[i]))
  return parts.join(" ")
}

function emptyStatus() {
  return { ok: true, repos: [], lastError: "" }
}

// `preview status --json --all-repos` prints { repos: [...] }. Anything else --
// empty output, half-written JSON, a stray log line -- is a parse failure rather
// than an empty machine, so the panel can say so instead of showing "no repos".
function parseStatus(raw) {
  var text = String(raw || "").trim()
  if (text === "") return emptyStatus()
  try {
    var parsed = JSON.parse(text)
    if (!parsed || typeof parsed !== "object") return emptyStatus()
    return { ok: true, repos: normalizeRepos(parsed.repos), lastError: "" }
  } catch (e) {
    return { ok: false, repos: [], lastError: "Could not read preview status" }
  }
}

function normalizeRepos(rawRepos) {
  var list = Array.isArray(rawRepos) ? rawRepos : []
  var out = []
  for (var i = 0; i < list.length; i++) {
    var repo = list[i] || {}
    var path = String(repo.path || "")
    out.push({
      name: String(repo.name || basename(path) || "repo"),
      path: path,
      main: normalizeMain(repo.main),
      previews: sortPreviews(repo.previews)
    })
  }
  return out
}

function normalizeMain(main) {
  if (!main || typeof main !== "object") return null
  return { port: toPort(main.port), running: main.running === true }
}

function normalizePreview(raw) {
  var p = raw || {}
  return {
    branch: String(p.branch || ""),
    worktree: String(p.worktree || ""),
    port: toPort(p.port),
    pid: Number(p.pid || 0),
    running: p.running === true,
    adopted: p.adopted === true,
    dirty: p.dirty === true,
    unpushed: Math.max(0, Number(p.unpushed || 0)),
    info: String(p.info || ""),
    startedAt: p.startedAt === null || p.startedAt === undefined ? 0 : Number(p.startedAt)
  }
}

// Running first, then by port so the list keeps a stable order across polls
// even when the CLI reorders its output.
function sortPreviews(rawPreviews) {
  var list = Array.isArray(rawPreviews) ? rawPreviews : []
  var out = []
  for (var i = 0; i < list.length; i++) out.push(normalizePreview(list[i]))
  out.sort(function(a, b) {
    if (a.running !== b.running) return a.running ? -1 : 1
    if (a.port !== b.port) return a.port - b.port
    return a.branch < b.branch ? -1 : (a.branch > b.branch ? 1 : 0)
  })
  return out
}

function toPort(value) {
  var n = parseInt(String(value === undefined || value === null ? "" : value), 10)
  return isFinite(n) && n > 0 ? n : 0
}

function basename(path) {
  var parts = String(path || "").replace(/\/+$/, "").split("/")
  return parts.length > 0 ? parts[parts.length - 1] : ""
}

// Compact uptime: seconds collapse to "just now", then m / h / d. Panels are
// glanced at, so one unit is enough.
function relativeTime(timestampSec, nowMs) {
  var ts = Number(timestampSec || 0)
  if (!isFinite(ts) || ts <= 0) return ""
  var now = nowMs === undefined ? Date.now() : Number(nowMs)
  var diff = Math.max(0, Math.floor((now - ts * 1000) / 1000))
  if (diff < 60) return "just now"
  var minutes = Math.floor(diff / 60)
  if (minutes < 60) return minutes + "m"
  var hours = Math.floor(minutes / 60)
  if (hours < 24) return hours + "h"
  return Math.floor(hours / 24) + "d"
}

function portLabel(port) {
  return Number(port || 0) > 0 ? ":" + port : ""
}

var SEP = " · "

// Second line of a preview row. Running previews lead with port and uptime;
// stopped ones just say so. Worktree markers always trail, because they decide
// whether delete is allowed and the user should see why it is greyed out.
function previewSubtitle(preview, nowMs) {
  var p = preview || {}
  var parts = []
  if (p.running) {
    if (Number(p.port || 0) > 0) parts.push(portLabel(p.port))
    var age = relativeTime(p.startedAt, nowMs)
    if (age !== "") parts.push(age)
    if (String(p.info || "") !== "") parts.push(String(p.info))
    if (parts.length === 0) parts.push("running")
  } else {
    parts.push("stopped")
    if (String(p.info || "") !== "") parts.push(String(p.info))
  }
  if (p.adopted) parts.push("adopted")
  if (p.dirty) parts.push("uncommitted")
  var unpushed = Math.max(0, Number(p.unpushed || 0))
  if (unpushed > 0) parts.push(unpushed + " unpushed")
  return parts.join(SEP)
}

function mainSubtitle(main) {
  var m = main || {}
  var port = portLabel(m.port)
  var label = port === "" ? "main dev server" : port + SEP + "main dev server"
  return m.running ? label : label + SEP + "stopped"
}

function deleteBlockedReason(preview) {
  var p = preview || {}
  if (p.adopted) return "Not created by preview"
  if (p.dirty || Math.max(0, Number(p.unpushed || 0)) > 0) return "Has uncommitted or unpushed work"
  return ""
}

function countRunning(repos) {
  var list = Array.isArray(repos) ? repos : []
  var total = 0
  for (var i = 0; i < list.length; i++) {
    var previews = list[i].previews || []
    for (var j = 0; j < previews.length; j++) if (previews[j].running) total++
  }
  return total
}

function countPreviews(repos) {
  var list = Array.isArray(repos) ? repos : []
  var total = 0
  for (var i = 0; i < list.length; i++) total += (list[i].previews || []).length
  return total
}

function key(repoPath, branch) {
  return String(repoPath || "") + " " + String(branch || "")
}

// Flat list of every keyboard-selectable row, in the order they are drawn:
// each repo's main row then its previews, then the footer buttons. The panel
// renders nested repeaters and looks its index up here, so cursor movement
// stays a single integer over one array.
function buildRows(repos) {
  var list = Array.isArray(repos) ? repos : []
  var rows = []
  for (var i = 0; i < list.length; i++) {
    if (list[i].main) rows.push({ kind: "main", repoIndex: i, previewIndex: -1 })
    var previews = list[i].previews || []
    for (var j = 0; j < previews.length; j++) rows.push({ kind: "preview", repoIndex: i, previewIndex: j })
  }
  for (var k = 0; k < list.length; k++) rows.push({ kind: "new", repoIndex: k, previewIndex: -1 })
  rows.push({ kind: "refresh", repoIndex: -1, previewIndex: -1 })
  return rows
}

function rowIndexOf(rows, kind, repoIndex, previewIndex) {
  var list = Array.isArray(rows) ? rows : []
  for (var i = 0; i < list.length; i++) {
    if (list[i].kind !== kind) continue
    if (kind === "refresh") return i
    if (list[i].repoIndex !== repoIndex) continue
    if (kind === "preview" && list[i].previewIndex !== previewIndex) continue
    return i
  }
  return -1
}

function repoAt(repos, index) {
  var list = Array.isArray(repos) ? repos : []
  return index >= 0 && index < list.length ? list[index] : null
}

function previewAt(repos, repoIndex, previewIndex) {
  var repo = repoAt(repos, repoIndex)
  if (!repo) return null
  var previews = repo.previews || []
  return previewIndex >= 0 && previewIndex < previews.length ? previews[previewIndex] : null
}

// Last non-empty line of stderr -- CLI failures put the reason on the final
// line, and a whole traceback would blow the panel out.
function lastLine(text) {
  var lines = String(text || "").split("\n")
  for (var i = lines.length - 1; i >= 0; i--) {
    var line = lines[i].trim()
    if (line !== "") return line
  }
  return ""
}

function elide(text, limit) {
  var max = limit === undefined ? 120 : limit
  var value = String(text || "").replace(/\s+/g, " ").trim()
  return value.length > max ? value.substring(0, max - 1) + "…" : value
}

if (typeof module !== "undefined") {
  module.exports = {
    shellQuote: shellQuote, shellJoin: shellJoin, parseStatus: parseStatus,
    normalizeRepos: normalizeRepos, sortPreviews: sortPreviews, basename: basename,
    relativeTime: relativeTime, portLabel: portLabel, previewSubtitle: previewSubtitle,
    mainSubtitle: mainSubtitle, deleteBlockedReason: deleteBlockedReason,
    countRunning: countRunning, countPreviews: countPreviews, key: key,
    buildRows: buildRows, rowIndexOf: rowIndexOf, repoAt: repoAt, previewAt: previewAt,
    lastLine: lastLine, elide: elide
  }
}
