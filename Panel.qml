// Bar widget for branch preview dev servers: a glyph with a running count, and
// a popup listing every repo's previews with start/stop/restart/open actions.

import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Ui
import "Model.js" as Model

Panel {
  id: root
  moduleName: "amanat361.preview"
  ipcTarget: "amanat361.preview"
  manageIpc: false

  readonly property color foreground: bar ? bar.foreground : Color.foreground
  readonly property color urgent: bar ? bar.urgent : Color.urgent
  readonly property color dim: Qt.darker(foreground, 1.55)
  readonly property color disabledColor: Qt.darker(foreground, 2.0)
  readonly property string fontFamily: bar ? bar.fontFamily : Style.font.family
  readonly property color barIconColor: previews.runningCount > 0 ? barForeground : Qt.darker(barForeground, 1.55)

  // Nerd font (Material Design range), matching the built-in panels.
  readonly property string glyphBranch: "󰘬"
  readonly property string glyphServer: "󰒋"
  readonly property string glyphPlay: "󰐊"
  readonly property string glyphStop: "󰓛"
  readonly property string glyphRestart: "󰑓"
  readonly property string glyphRefresh: "󰑐"
  readonly property string glyphTerminal: "󰆍"
  readonly property string glyphClaude: "󰚩"
  readonly property string glyphLogs: "󰈙"
  readonly property string glyphDelete: "󰩹"
  readonly property string glyphNew: "󰐕"

  readonly property var rows: Model.buildRows(previews.repos)
  property int cursorIndex: 0
  property bool cursorActive: false

  // Ticks while the panel is open so "12m" ages in place instead of freezing at
  // whatever it said when the popup was summoned.
  property double nowMs: Date.now()

  property string confirmRepo: ""
  property string confirmBranch: ""

  readonly property string countText: previews.runningCount > 0 ? String(previews.runningCount) : ""
  readonly property string barTooltip: previews.runningCount === 1
    ? "1 preview running"
    : previews.runningCount + " previews running"

  readonly property bool loading: !previews.everLoaded && previews.lastError === ""
  readonly property bool empty: previews.everLoaded && previews.repos.length === 0

  // ------------------------------------------------------------ cursor state

  function rowAt(index) {
    return index >= 0 && index < rows.length ? rows[index] : null
  }

  function moveCursor(dx, dy) {
    cursorActive = true
    if (rows.length === 0) { cursorIndex = 0; return }
    if (dy === 0) return
    cursorIndex = Math.max(0, Math.min(rows.length - 1, cursorIndex + dy))
  }

  function setCursor(index) {
    if (index < 0) return
    cursorActive = true
    cursorIndex = index
  }

  function hasCursorOn(index) {
    return cursorActive && index >= 0 && cursorIndex === index
  }

  function selectedPreview() {
    var row = rowAt(cursorIndex)
    if (!row || row.kind !== "preview") return null
    return Model.previewAt(previews.repos, row.repoIndex, row.previewIndex)
  }

  function selectedRepoPath() {
    var row = rowAt(cursorIndex)
    if (!row || row.repoIndex < 0) return ""
    var repo = Model.repoAt(previews.repos, row.repoIndex)
    return repo ? repo.path : ""
  }

  // ---------------------------------------------------------------- actions

  function activateRow(index) {
    var row = rowAt(index)
    if (!row) return
    var repo = Model.repoAt(previews.repos, row.repoIndex)
    if (!repo) return
    if (row.kind === "new") { previews.newPreview(repo.path); root.close(); return }
    if (row.kind === "main") { if (repo.main) previews.openUrl(repo.main.port); return }
    var preview = Model.previewAt(previews.repos, row.repoIndex, row.previewIndex)
    if (!preview) return
    // One obvious thing per row: look at it if it is up, bring it up if it is not.
    if (previews.effectiveRunning(repo.path, preview)) previews.openUrl(preview.port)
    else previews.start(repo.path, preview.branch)
  }

  function toggleSelected() {
    var preview = selectedPreview()
    if (preview) previews.toggle(selectedRepoPath(), preview)
  }

  function restartSelected(hard) {
    var preview = selectedPreview()
    if (preview) previews.restart(selectedRepoPath(), preview.branch, hard === true)
  }

  function openSelected() {
    var row = rowAt(cursorIndex)
    if (!row) return
    var repo = Model.repoAt(previews.repos, row.repoIndex)
    if (!repo) return
    if (row.kind === "main") { if (repo.main) previews.openUrl(repo.main.port); return }
    var preview = selectedPreview()
    if (preview) previews.openUrl(preview.port)
  }

  function askDelete(repoPath, preview) {
    if (!preview || Model.deleteBlockedReason(preview) !== "") return
    confirmRepo = repoPath
    confirmBranch = preview.branch
    Qt.callLater(function() { confirmKeys.forceActiveFocus() })
  }

  function askDeleteSelected() {
    var preview = selectedPreview()
    if (preview) askDelete(selectedRepoPath(), preview)
  }

  function cancelDelete() {
    confirmBranch = ""
    confirmRepo = ""
    Qt.callLater(function() { keyCatcher.forceActiveFocus() })
  }

  function confirmDelete() {
    previews.remove(confirmRepo, confirmBranch)
    cancelDelete()
  }

  function scrollItemIntoView(item) {
    if (!panelFlick || !item) return
    Qt.callLater(function() {
      if (!item || !panelFlick) return
      var margin = Style.space(6)
      var top = item.mapToItem(panelFlick.contentItem, 0, 0).y
      var bottom = top + item.height
      var viewTop = panelFlick.contentY
      var viewBottom = viewTop + panelFlick.height
      var maxY = Math.max(0, panelFlick.contentHeight - panelFlick.height)
      if (top < viewTop + margin) panelFlick.contentY = Math.max(0, top - margin)
      else if (bottom > viewBottom - margin) panelFlick.contentY = Math.min(maxY, bottom + margin - panelFlick.height)
    })
  }

  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight

  onOpenedChanged: {
    if (opened) {
      cursorActive = false
      cursorIndex = 0
      nowMs = Date.now()
      if (panelFlick) panelFlick.contentY = 0
      previews.refresh()
      Qt.callLater(function() { keyCatcher.forceActiveFocus() })
    } else {
      confirmBranch = ""
      confirmRepo = ""
    }
  }

  Service {
    id: previews
    settings: root.settings
  }

  Timer {
    id: clockTimer
    interval: 30000
    repeat: true
    running: root.opened
    onTriggered: root.nowMs = Date.now()
  }

  IpcHandler {
    target: root.ipcTarget
    function open(): string { root.open(); return "ok" }
    function close(): string { root.close(); return "ok" }
    function toggle(): string { root.toggle(); return "ok" }
    function refresh(): string { previews.refresh(); return "ok" }
    function status(): string { return previews.lastStatusJson }
  }

  BarIconButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    // A vertical bar has no room for the count beside the glyph, so it drops to
    // icon-only there and the tooltip carries the number.
    text: (root.countText === "" || vertical) ? root.glyphBranch : root.glyphBranch + " " + root.countText
    foreground: root.barIconColor
    slotSize: Style.bar.iconSlot * (root.countText !== "" && !vertical ? 1.6 : 1)
    tooltipText: root.barTooltip
    onPressed: function(buttonCode) {
      if (buttonCode === Qt.RightButton) previews.refresh()
      else if (buttonCode === Qt.MiddleButton) {
        var first = Model.repoAt(previews.repos, 0)
        if (first && first.main) previews.openUrl(first.main.port)
      } else root.toggle()
    }
  }

  KeyboardPanel {
    id: panel
    anchorItem: button
    owner: root
    bar: root.bar
    open: root.opened
    focusTarget: keyCatcher
    contentWidth: panel.fittedContentWidth(Style.space(420))
    contentHeight: panel.fittedContentHeight(column.implicitHeight, Style.space(600))

    PanelKeyCatcher {
      id: keyCatcher
      anchors.fill: parent
      blocked: root.confirmBranch !== ""
      onMoveRequested: function(dx, dy) {
        if (!root.cursorActive) { root.cursorActive = true; return }
        root.moveCursor(dx, dy)
      }
      onActivateRequested: if (root.cursorActive) root.activateRow(root.cursorIndex)
      onCloseRequested: root.close()
      onDeleteRequested: if (root.cursorActive) root.askDeleteSelected()
      onTabRequested: function(direction) { root.switchPanel(direction) }
      onTextKey: function(t) {
        var c = t.toLowerCase()
        if (c === "q") root.close()
        else if (c === "s") root.toggleSelected()
        else if (c === "r") root.restartSelected(t === "R")
        else if (c === "o") root.openSelected()
      }

      Flickable {
        id: panelFlick
        anchors.fill: parent
        contentWidth: width
        contentHeight: column.implicitHeight
        clip: true
        boundsBehavior: Flickable.StopAtBounds
        flickableDirection: Flickable.VerticalFlick
        interactive: contentHeight > height
        ScrollBar.vertical: ScrollBar { policy: ScrollBar.AsNeeded }

        Column {
          id: column
          width: panelFlick.width
          spacing: Style.space(12)

          PanelHero {
            id: hero
            width: parent.width
            title: "Previews"
            meta: root.loading
              ? "Loading"
              : (previews.runningCount > 0
                ? previews.runningCount + " running of " + previews.previewCount
                : "Nothing running")
            foreground: root.foreground
            fontFamily: root.fontFamily
            iconOpacity: previews.runningCount > 0 ? 1.0 : 0.5

            // Inside these Components an unqualified `root` can bind to
            // PanelHero's own root rather than this panel's, so everything here
            // goes through unambiguous ids (`hero`, `previews`).
            iconComponent: Component {
              Text {
                text: "󰘬"
                color: previews.runningCount > 0 ? hero.foreground : hero.dim
                font.family: hero.fontFamily
                font.pixelSize: Style.font.display
              }
            }

            trailingControl: Component {
              PanelActionButton {
                iconText: "󰑐"
                tooltipText: "Refresh"
                foreground: hero.foreground
                fontFamily: hero.fontFamily
                enabled: !previews.refreshing
                onClicked: previews.refresh()
              }
            }
          }

          // Errors are the one thing that must not be mistaken for chrome, so
          // they sit on their own line in the urgent color rather than in the
          // hero's dimmed meta slot.
          Text {
            visible: previews.lastError !== ""
            width: parent.width
            text: previews.lastError
            color: root.urgent
            font.family: root.fontFamily
            font.pixelSize: Style.font.bodySmall
            wrapMode: Text.WordWrap
          }

          Text {
            visible: root.empty
            width: parent.width
            topPadding: Style.space(18)
            bottomPadding: Style.space(6)
            text: "No previews yet.\nRun `preview up <branch>` in a repo."
            color: root.dim
            font.family: root.fontFamily
            font.pixelSize: Style.font.body
            horizontalAlignment: Text.AlignHCenter
            wrapMode: Text.WordWrap
          }

          Repeater {
            model: previews.repos

            Column {
              id: repoEntry
              required property var modelData
              required property int index

              width: column.width
              spacing: Style.space(6)

              PanelSeparator {
                visible: repoEntry.index > 0
                foreground: root.foreground
              }

              PanelSectionHeader {
                text: String(repoEntry.modelData.name).toUpperCase()
                foreground: root.foreground
                fontFamily: root.fontFamily
              }


              Repeater {
                model: repoEntry.modelData.previews

                PreviewRow {
                  required property var modelData
                  required property int index

                  width: repoEntry.width
                  repoPath: repoEntry.modelData.path
                  preview: modelData
                  flatIndex: Model.rowIndexOf(root.rows, "preview", repoEntry.index, index)
                }
              }

              Text {
                visible: (repoEntry.modelData.previews || []).length === 0
                width: parent.width
                leftPadding: Style.space(10)
                topPadding: Style.space(2)
                bottomPadding: Style.space(2)
                text: "No previews in this repo"
                color: root.dim
                font.family: root.fontFamily
                font.pixelSize: Style.font.caption
              }
            }
          }

          PanelSeparator {
            visible: previews.repos.length > 0
            foreground: root.foreground
          }

          Column {
            id: footer
            width: parent.width
            spacing: Style.space(6)

            Repeater {
              model: previews.repos

              SimpleRow {
                required property var modelData
                required property int index

                width: footer.width
                glyph: root.glyphNew
                label: previews.repos.length > 1 ? "New preview in " + modelData.name : "New preview"
                detail: "Opens the interactive picker in a terminal"
                flatIndex: Model.rowIndexOf(root.rows, "new", index, -1)
              }
            }
          }
        }
      }
    }

    // Sits above the scroller and owns keys while it is up; the key catcher
    // short-circuits via `blocked` so arrows pick a button instead of a row.
    Item {
      id: confirmKeys
      anchors.fill: parent
      z: 10
      visible: root.confirmBranch !== ""
      focus: visible
      Keys.onPressed: function(event) {
        if (deleteConfirm.handleKey(event)) event.accepted = true
      }

      ConfirmDialog {
        id: deleteConfirm
        anchors.fill: parent
        opened: root.confirmBranch !== ""
        message: "Delete " + root.confirmBranch + "?\nRemoves the worktree and local branch."
        confirmText: "Delete"
        background: Color.popups.background
        foreground: root.foreground
        fontFamily: root.fontFamily
        onCanceled: root.cancelDelete()
        onConfirmed: root.confirmDelete()
      }
    }
  }

  // ------------------------------------------------------------- row types

  // Two stacked labels, the shape every row in this panel takes: what it is on
  // top, what state it is in underneath.
  component RowLabels: ColumnLayout {
    id: labels
    property string label: ""
    property string detail: ""
    property bool muted: false

    Layout.fillWidth: true
    Layout.minimumWidth: Style.space(70)
    spacing: Style.space(1)

    Text {
      Layout.fillWidth: true
      text: labels.label
      color: labels.muted ? root.dim : root.foreground
      font.family: root.fontFamily
      font.pixelSize: Style.font.body
      elide: Text.ElideRight
    }

    Text {
      Layout.fillWidth: true
      visible: labels.detail !== ""
      text: labels.detail
      color: root.dim
      font.family: root.fontFamily
      font.pixelSize: Style.font.caption
      elide: Text.ElideRight
    }
  }

  component RowGlyph: Text {
    property bool muted: false
    color: muted ? root.dim : root.foreground
    font.family: root.fontFamily
    font.pixelSize: Style.font.icon
    Layout.alignment: Qt.AlignVCenter
  }

  component RowAction: PanelActionButton {
    foreground: root.foreground
    fontFamily: root.fontFamily
    Layout.alignment: Qt.AlignVCenter
  }

  // A row whose only interaction is being activated: the repo's own dev server
  // "New preview". The main checkout is not a preview: it stays in status --json and behind middle-click.
  component SimpleRow: CursorSurface {
    id: simpleRow
    property string glyph: ""
    property string label: ""
    property string detail: ""
    property bool muted: false
    property int flatIndex: -1

    hasCursor: root.hasCursorOn(flatIndex)
    foreground: root.foreground
    implicitHeight: simpleLabels.implicitHeight + Style.spacing.rowPaddingX

    onHasCursorChanged: if (hasCursor) root.scrollItemIntoView(simpleRow)

    MouseArea {
      anchors.fill: parent
      hoverEnabled: true
      cursorShape: Qt.PointingHandCursor
      onEntered: root.setCursor(simpleRow.flatIndex)
      onClicked: root.activateRow(simpleRow.flatIndex)
    }

    RowLayout {
      anchors.left: parent.left
      anchors.right: parent.right
      anchors.verticalCenter: parent.verticalCenter
      anchors.leftMargin: Style.space(10)
      anchors.rightMargin: Style.space(10)
      spacing: Style.space(8)

      RowGlyph { text: simpleRow.glyph; muted: simpleRow.muted }

      RowLabels {
        id: simpleLabels
        label: simpleRow.label
        detail: simpleRow.detail
        muted: simpleRow.muted
      }
    }
  }

  component PreviewRow: CursorSurface {
    id: previewRow
    property string repoPath: ""
    property var preview: null
    property int flatIndex: -1

    readonly property string branch: preview ? String(preview.branch || "") : ""
    readonly property string worktree: preview ? String(preview.worktree || "") : ""
    readonly property bool up: preview ? previews.effectiveRunning(repoPath, preview) : false
    readonly property bool deleting: previews.isDeleting(repoPath, branch)
    readonly property string deleteBlocked: preview ? Model.deleteBlockedReason(preview) : ""
    readonly property bool actionable: !previews.actionBusy && !deleting

    hasCursor: root.hasCursorOn(flatIndex)
    foreground: root.foreground
    opacity: deleting ? 0.45 : 1.0
    implicitHeight: previewLabels.implicitHeight + Style.spacing.rowPaddingX

    onHasCursorChanged: if (hasCursor) root.scrollItemIntoView(previewRow)

    MouseArea {
      anchors.fill: parent
      hoverEnabled: true
      cursorShape: Qt.PointingHandCursor
      onEntered: root.setCursor(previewRow.flatIndex)
      onClicked: root.activateRow(previewRow.flatIndex)
    }

    RowLayout {
      anchors.left: parent.left
      anchors.right: parent.right
      anchors.verticalCenter: parent.verticalCenter
      anchors.leftMargin: Style.space(10)
      anchors.rightMargin: Style.space(6)
      spacing: Style.space(6)

      RowGlyph { text: root.glyphBranch; muted: !previewRow.up }

      RowLabels {
        id: previewLabels
        label: previewRow.branch
        detail: Model.previewSubtitle(previewRow.preview, root.nowMs)
        muted: !previewRow.up
      }

      RowAction {
        iconText: previewRow.up ? root.glyphStop : root.glyphPlay
        tooltipText: previewRow.up ? "Stop" : "Start"
        enabled: previewRow.actionable
        onClicked: previews.toggle(previewRow.repoPath, previewRow.preview)
      }

      RowAction {
        iconText: root.glyphRestart
        tooltipText: "Restart (right-click for a hard restart)"
        enabled: previewRow.actionable
        onClicked: previews.restart(previewRow.repoPath, previewRow.branch, false)

        // Left clicks fall through to the button's own MouseArea; only the
        // right button is claimed here, for `restart --hard`.
        MouseArea {
          anchors.fill: parent
          acceptedButtons: Qt.RightButton
          onClicked: previews.restart(previewRow.repoPath, previewRow.branch, true)
        }
      }

      RowAction {
        iconText: root.glyphTerminal
        tooltipText: "Open a terminal in the worktree"
        enabled: previewRow.worktree !== ""
        onClicked: previews.openTerminal(previewRow.worktree, [])
      }

      RowAction {
        iconText: root.glyphClaude
        tooltipText: "Run Claude Code in the worktree"
        enabled: previewRow.worktree !== ""
        onClicked: previews.claude(previewRow.worktree)
      }

      RowAction {
        iconText: root.glyphLogs
        tooltipText: "Tail the dev server log"
        onClicked: previews.logs(previewRow.repoPath, previewRow.branch)
      }

      // A blocked delete stays hoverable rather than `enabled: false`, because
      // a Qt-disabled item cannot show the tooltip that explains why it is dead.
      RowAction {
        readonly property bool blocked: previewRow.deleteBlocked !== ""

        iconText: root.glyphDelete
        tooltipText: blocked ? previewRow.deleteBlocked : "Delete the worktree and local branch"
        foreground: blocked ? root.disabledColor : root.foreground
        hoverColor: blocked ? root.disabledColor : root.urgent
        enabled: previewRow.actionable
        onClicked: if (!blocked) root.askDelete(previewRow.repoPath, previewRow.preview)
      }
    }
  }
}
