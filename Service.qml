// State and process plumbing for the Preview bar widget: polls
// `preview status --json --all-repos`, runs start/stop/restart/down, and
// launches browsers and terminals for a preview's port or worktree.

import QtQuick
import Quickshell
import Quickshell.Io
import "Model.js" as Model

Item {
  id: root

  property var settings: ({})

  property var repos: []
  property bool refreshing: false
  property bool everLoaded: false
  property string lastError: ""
  // Raw JSON of the last successful poll, handed back verbatim by IPC status().
  property string lastStatusJson: ""

  // Optimistic running state, keyed by repoPath + branch. A click flips the row
  // immediately and a settle timer re-polls until the CLI agrees, so the panel
  // never looks frozen while a dev server boots. Values: true (starting),
  // false (stopping), "gone" (deleted, hide the row).
  property var pending: ({})

  readonly property string previewBin: String(setting("previewBin", "preview") || "preview")
  readonly property int refreshIntervalSec: intSetting("refreshIntervalSec", 5, 2, 120)
  readonly property int runningCount: Model.countRunning(repos)
  readonly property int previewCount: Model.countPreviews(repos)
  readonly property bool busy: statusProcess.running || actionProcess.running
  // Gate row buttons on this, not `busy` — a background status poll every few
  // seconds must not make every button flicker disabled.
  readonly property bool actionBusy: actionProcess.running

  property string _statusOut: ""
  property string _actionErr: ""
  property string _actionOut: ""
  property string _actionKey: ""
  property string _actionVerb: ""

  function setting(name, fallback) {
    var value = settings ? settings[name] : undefined
    return value === undefined || value === null ? fallback : value
  }

  function intSetting(name, fallback, min, max) {
    var n = parseInt(String(setting(name, fallback)), 10)
    if (!isFinite(n)) n = fallback
    return Math.max(min, Math.min(max, n))
  }

  // ---------------------------------------------------------------- polling

  function refresh() {
    if (statusProcess.running) return
    _statusOut = ""
    refreshing = true
    statusProcess.command = [previewBin, "status", "--json", "--all-repos"]
    statusProcess.running = true
    spawnWatchdog.restart()
  }

  function applyStatus(raw) {
    var parsed = Model.parseStatus(raw)
    if (!parsed.ok) {
      lastError = parsed.lastError
      return
    }
    repos = parsed.repos
    lastStatusJson = String(raw || "")
    everLoaded = true
    lastError = ""
    reconcilePending()
  }

  // Drop optimistic entries the CLI has caught up with, so a row stops
  // overriding reality the moment reality matches.
  function reconcilePending() {
    var next = {}
    var changed = false
    for (var k in pending) {
      var want = pending[k]
      var actual = lookupRunning(k)
      if (want === "gone") {
        if (actual === null) { changed = true; continue }
      } else if (actual === want) {
        changed = true
        continue
      }
      next[k] = want
    }
    if (changed) pending = next
  }

  function lookupRunning(rowKey) {
    for (var i = 0; i < repos.length; i++) {
      var previews = repos[i].previews || []
      for (var j = 0; j < previews.length; j++) {
        if (Model.key(repos[i].path, previews[j].branch) === rowKey) return previews[j].running === true
      }
    }
    return null
  }

  function pendingFor(repoPath, branch) {
    var value = pending[Model.key(repoPath, branch)]
    return value === undefined ? null : value
  }

  // The running state a row should paint: the optimistic value while one is
  // outstanding, otherwise whatever the last poll said.
  function effectiveRunning(repoPath, preview) {
    var want = pendingFor(repoPath, preview ? preview.branch : "")
    if (want === true || want === false) return want
    return preview ? preview.running === true : false
  }

  function isDeleting(repoPath, branch) {
    return pendingFor(repoPath, branch) === "gone"
  }

  function setPending(repoPath, branch, value) {
    var next = {}
    for (var k in pending) next[k] = pending[k]
    next[Model.key(repoPath, branch)] = value
    pending = next
  }

  function clearPending(rowKey) {
    if (pending[rowKey] === undefined) return
    var next = {}
    for (var k in pending) if (k !== rowKey) next[k] = pending[k]
    pending = next
  }

  // ---------------------------------------------------------------- actions

  // verb is start | stop | restart | down. Commands are argv arrays, never a
  // shell string, so a branch name with spaces or quotes cannot be reinterpreted.
  function act(repoPath, branch, verb, extraArgs) {
    if (String(branch || "") === "" || String(repoPath || "") === "") return
    // Row buttons are already disabled while an action runs; this catches the
    // keyboard shortcuts, which would otherwise look like they did nothing.
    if (actionProcess.running) {
      lastError = "Another preview command is still running"
      return
    }
    var command = [previewBin, verb, branch, "--repo", repoPath]
    var extras = extraArgs || []
    for (var i = 0; i < extras.length; i++) command.push(extras[i])

    if (verb === "start" || verb === "restart") setPending(repoPath, branch, true)
    else if (verb === "stop") setPending(repoPath, branch, false)
    else if (verb === "down") setPending(repoPath, branch, "gone")

    lastError = ""
    _actionKey = Model.key(repoPath, branch)
    _actionVerb = verb
    _actionOut = ""
    _actionErr = ""
    actionProcess.command = command
    actionProcess.running = true
  }

  function start(repoPath, branch) { act(repoPath, branch, "start", []) }
  function stop(repoPath, branch) { act(repoPath, branch, "stop", []) }
  function restart(repoPath, branch, hard) { act(repoPath, branch, "restart", hard ? ["--hard"] : []) }
  function remove(repoPath, branch) { act(repoPath, branch, "down", ["--force"]) }

  function toggle(repoPath, preview) {
    if (!preview) return
    if (effectiveRunning(repoPath, preview)) stop(repoPath, preview.branch)
    else start(repoPath, preview.branch)
  }

  // ------------------------------------------------------------- launchers

  function openUrl(port) {
    if (Number(port || 0) <= 0) return
    Qt.openUrlExternally("http://localhost:" + port)
  }

  function terminalName() {
    var configured = String(setting("terminal", "") || "").trim()
    if (configured !== "") return configured
    var env = String(Quickshell.env("TERMINAL") || "").trim()
    return env !== "" ? env : "alacritty"
  }

  // Terminals disagree on both flags, so pick by basename rather than guessing
  // one spelling. Anything unrecognised (xdg-terminal-exec, a wrapper script)
  // gets the portable form: no cwd flag, `--` then a shell that cd's itself.
  function terminalCommand(cwd, argv) {
    var term = terminalName()
    var base = term.split("/").pop()
    var args = argv || []
    var hasArgs = args.length > 0
    var command = [term]

    if (base === "alacritty") {
      command.push("--working-directory", cwd)
      if (hasArgs) command.push("-e")
    } else if (base === "ghostty") {
      command.push("--working-directory=" + cwd)
      if (hasArgs) command.push("-e")
    } else if (base === "kitty") {
      command.push("--directory", cwd)
    } else if (base === "foot") {
      command.push("-D", cwd)
    } else if (base === "wezterm") {
      command = [term, "start", "--cwd", cwd]
      if (hasArgs) command.push("--")
    } else {
      var inner = hasArgs ? Model.shellJoin(args) : "\"${SHELL:-bash}\""
      command.push("--", "bash", "-lc", "cd " + Model.shellQuote(cwd) + " && exec " + inner)
      return command
    }

    for (var i = 0; i < args.length; i++) command.push(args[i])
    return command
  }

  function openTerminal(cwd, argv) {
    if (String(cwd || "") === "") return
    Quickshell.execDetached(["uwsm-app", "--"].concat(terminalCommand(cwd, argv || [])))
  }

  function claude(worktree) {
    openTerminal(worktree, ["claude"])
  }

  // Keeps the shell alive after the tail so the log stays on screen to read.
  function logs(repoPath, branch) {
    var line = Model.shellQuote(previewBin) + " logs " + Model.shellQuote(branch)
      + " --repo " + Model.shellQuote(repoPath) + " 200; exec \"${SHELL:-bash}\""
    openTerminal(repoPath, ["bash", "-lc", line])
  }

  function newPreview(repoPath) {
    openTerminal(repoPath, [previewBin])
  }

  // --------------------------------------------------------------- timers

  Timer {
    id: pollTimer
    interval: root.refreshIntervalSec * 1000
    repeat: true
    running: true
    triggeredOnStart: true
    onTriggered: root.refresh()
  }

  // A dev server takes a few seconds to bind its port, so re-poll a handful of
  // times after an action instead of waiting out the normal interval. Clearing
  // every optimistic entry at the end keeps a silently-failed action from
  // pinning a row to the wrong state forever.
  Timer {
    id: settleTimer
    property int ticks: 0
    interval: 1500
    repeat: true
    running: false
    onTriggered: {
      settleTimer.ticks += 1
      root.refresh()
      if (settleTimer.ticks >= 4) {
        settleTimer.ticks = 0
        settleTimer.running = false
        root.pending = ({})
      }
    }
  }

  // Quickshell reports a failed exec by never emitting `exited`, so a missing
  // CLI would otherwise leave the panel spinning on "Loading" forever.
  Timer {
    id: spawnWatchdog
    interval: 5000
    repeat: false
    onTriggered: {
      if (!root.refreshing) return
      root.refreshing = false
      if (!root.everLoaded) root.lastError = root.previewBin + " not found on PATH"
    }
  }

  // -------------------------------------------------------------- processes

  Process {
    id: statusProcess
    running: false
    command: []
    stdout: StdioCollector { id: statusOut; waitForEnd: true; onStreamFinished: root._statusOut = text }
    stderr: StdioCollector { id: statusErr; waitForEnd: true }
    onExited: function(exitCode) {
      spawnWatchdog.stop()
      root.refreshing = false
      var out = String(statusOut.text || root._statusOut || "")
      var err = String(statusErr.text || "")
      if (exitCode === 0) root.applyStatus(out)
      else root.lastError = Model.elide(Model.lastLine(err) || Model.lastLine(out) || "Could not read preview status")
    }
  }

  Process {
    id: actionProcess
    running: false
    command: []
    stdout: StdioCollector { id: actionOut; waitForEnd: true; onStreamFinished: root._actionOut = text }
    stderr: StdioCollector { id: actionErr; waitForEnd: true; onStreamFinished: root._actionErr = text }
    onExited: function(exitCode) {
      var err = String(actionErr.text || root._actionErr || "")
      var out = String(actionOut.text || root._actionOut || "")
      if (exitCode !== 0) {
        root.clearPending(root._actionKey)
        root.lastError = Model.elide(Model.lastLine(err) || Model.lastLine(out)
          || (root.previewBin + " " + root._actionVerb + " failed"))
      } else {
        root.lastError = ""
      }
      settleTimer.ticks = 0
      settleTimer.restart()
      root.refresh()
    }
  }
}
