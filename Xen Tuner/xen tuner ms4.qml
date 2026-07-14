// Copyright (C) 2023 euwbah
// 
// This file is part of Xen Tuner.
// 
// Xen Tuner is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
// 
// Xen Tuner is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU General Public License for more details.
// 
// You should have received a copy of the GNU General Public License
// along with Xen Tuner.  If not, see <http://www.gnu.org/licenses/>.

// When there's some syntax error the imported files and its not showing up,
// uncomment these lines
// import "runtime/tables/generated-tables.js" as AAAAAaa
// import "runtime/tables/lookup-tables.js" as Aaa
// import "runtime/fns.js" as Bbb

import "runtime/fns.ms.js" as Fns
import MuseScore 3.0
import QtQuick 2.9
import QtQuick.Controls 2.2
import QtQuick.Window 2.2
import QtQuick.Layouts 1.2
import QtQuick.Dialogs 1.1
import FileIO 3.0

MuseScore {
      version: "0.3.5"
      pluginType: "dialog"
      description: "Starts the XenTuner plugin.\n\n" +
        "This will open a small docked panel to the side.\n\nIMPORTANT: Do not close the window.\n"+
        "Make sure you only have 1 instance of this plugin running at a time."
      readonly property int logTextRows: 7
      readonly property int minLogTextRows: 3
      // Point sizes follow Linux font DPI and can be scaled again by Qt's device scale.
      readonly property int logTextPixelSize: 11
      readonly property int controlTextPixelSize: 11
      readonly property int quitTextPixelSize: 13
      readonly property int logTextPadding: 6
      readonly property int minControlRowHeight: 20
      readonly property int controlVerticalPadding: 6
      readonly property real controlLineSpacing: controlTextMetrics.lineSpacing
      readonly property real quitLineSpacing: quitTextMetrics.lineSpacing
      readonly property real logLineSpacing: logTextMetrics.lineSpacing
      readonly property int controlRowHeight: Math.max(minControlRowHeight, Math.ceil(Math.max(controlLineSpacing, quitLineSpacing) + controlVerticalPadding))
      readonly property real controlCharWidth: Math.max(1, controlTextMetrics.averageCharacterWidth || controlTextMetrics.lineSpacing / 2)
      readonly property real quitCharWidth: Math.max(1, quitTextMetrics.averageCharacterWidth || quitTextMetrics.lineSpacing / 2)
      readonly property int controlHorizontalPadding: Math.max(6, Math.ceil(controlCharWidth * 2))
      readonly property int controlCornerRadius: Math.max(3, Math.ceil(controlRowHeight / 6))
      readonly property int iconButtonWidth: Math.max(controlRowHeight, Math.ceil(quitCharWidth * 2 + controlHorizontalPadding))
      readonly property int actionButtonMinWidth: Math.ceil(controlCharWidth * 6 + controlHorizontalPadding * 2)
      readonly property int actionButtonPreferredWidth: Math.ceil(controlCharWidth * 12 + controlHorizontalPadding * 2)
      readonly property int panelMargin: 4
      readonly property int panelRowSpacing: 1
      readonly property int panelColumnSpacing: 4
      readonly property int panelSafetyPadding: Math.ceil(controlLineSpacing / 2)
      readonly property int panelWidthSafetyPadding: Math.ceil(controlLineSpacing)
      readonly property int logAreaHeight: Math.ceil(logLineSpacing * logTextRows + logTextPadding * 2)
      readonly property int minLogAreaHeight: Math.ceil(logLineSpacing * minLogTextRows + logTextPadding * 2)
      readonly property int auxLabelMinWidth: Math.ceil(controlCharWidth * 10 + controlHorizontalPadding * 2)
      readonly property int auxButtonGroupCount: auxButtonGroups ? auxButtonGroups.length : 0
      readonly property int auxButtonAreaHeight: auxButtonGroupCount > 0 ? auxButtonGroupCount * controlRowHeight + (auxButtonGroupCount - 1) * panelRowSpacing : 0
      readonly property int auxButtonSectionHeight: auxButtonAreaHeight > 0 ? auxButtonAreaHeight + panelRowSpacing : 0
      readonly property int controlsMinWidth: Math.max(iconButtonWidth + actionButtonPreferredWidth * 2 + panelColumnSpacing * 2, auxLabelMinWidth + actionButtonMinWidth * 2 + panelColumnSpacing * 2)
      readonly property int panelHeight: logAreaHeight + controlRowHeight + auxButtonSectionHeight + panelRowSpacing + panelMargin * 2 + panelSafetyPadding
      readonly property int panelWidth: Math.max(300, controlsMinWidth + panelMargin * 2 + panelWidthSafetyPadding)
      implicitHeight: panelHeight
      implicitWidth: panelWidth
      id: pluginId
      readonly property var window: Window.window
      readonly property var pluginHomePath: Qt.resolvedUrl("../").replace("file:///", "")
      property bool allowClose: false
      property var lastScoreRef: null
      property string lastScoreIdentity: ""
      property bool panelSizeSchedulingReady: false
      property int panelSizePassesRemaining: 0
      property int auxChainCount: 0
      property var auxButtonGroups: []
      property string activeButtonOperationId: ""
      property var pendingButtonOperation: null
      readonly property bool buttonOperationInProgress: activeButtonOperationId.length > 0

      FontMetrics {
        id: logTextMetrics
        font.pixelSize: pluginId.logTextPixelSize
      }

      FontMetrics {
        id: controlTextMetrics
        font.pixelSize: pluginId.controlTextPixelSize
      }

      FontMetrics {
        id: quitTextMetrics
        font.pixelSize: pluginId.quitTextPixelSize
      }

      Component {
        id: actionButtonContentComponent

        Item {
          id: actionButtonContent
          property var buttonControl: parent ? parent.buttonControl : null
          property bool loading: parent ? parent.loading : false
          property color foregroundColor: parent ? parent.foregroundColor : "#202020"

          Text {
            anchors.fill: parent
            text: actionButtonContent.buttonControl ? actionButtonContent.buttonControl.text : ""
            color: actionButtonContent.foregroundColor
            font.pixelSize: actionButtonContent.buttonControl ? actionButtonContent.buttonControl.font.pixelSize : pluginId.controlTextPixelSize
            horizontalAlignment: Text.AlignHCenter
            verticalAlignment: Text.AlignVCenter
            elide: Text.ElideRight
            wrapMode: Text.NoWrap
            visible: !actionButtonContent.loading
          }

          Text {
            anchors.centerIn: parent
            text: "\u21BB"
            color: actionButtonContent.foregroundColor
            font.pixelSize: actionButtonContent.buttonControl ? actionButtonContent.buttonControl.font.pixelSize + 2 : pluginId.controlTextPixelSize + 2
            font.bold: true
            visible: actionButtonContent.loading
            transformOrigin: Item.Center

            RotationAnimation on rotation {
              from: 0
              to: 360
              duration: 700
              loops: Animation.Infinite
              running: actionButtonContent.loading
            }
          }
        }
      }

      function isButtonOperationActive(operationId) {
        return buttonOperationInProgress && activeButtonOperationId == operationId;
      }

      function beginButtonOperation(operationId, operation) {
        if (buttonOperationInProgress || !operationId || typeof operation !== "function")
          return false;

        activeButtonOperationId = operationId;
        pendingButtonOperation = operation;
        buttonOperationTimer.restart();
        return true;
      }

      function ensureInitialPanelSize() {
        if (height < pluginId.panelHeight) {
          height = pluginId.panelHeight;
        }
        if (width < pluginId.panelWidth) {
          width = pluginId.panelWidth;
        }
      }

      function scheduleInitialPanelSize() {
        ensureInitialPanelSize();
        if (panelSizeSchedulingReady) {
          panelSizePassesRemaining = 4;
          ensurePanelSizeTimer.interval = 0;
          ensurePanelSizeTimer.restart();
        }
      }

      onRun: {
        console.log('Started Xen Tuner');
        // When you want to find which import has a syntax error, uncomment this line
        // console.log(JSON.stringify(Fns));

        var isMS4 = mscoreMajorVersion >= 4;
        Fns.init(Accidental, NoteType, SymId, Element,
          fileIO, curScore, isMS4, pluginHomePath);
        lastScoreRef = curScore;
        lastScoreIdentity = scoreIdentity();
        infoText.text = Fns.getStartupTuningLogText();
        refreshAuxButtons();
        Fns.logOperation("Start Xen Tuner");
        console.log('present working dir: ' + pluginHomePath);
        scheduleInitialPanelSize();
      }

      Component.onCompleted : {
        panelSizeSchedulingReady = true;
        scheduleInitialPanelSize();
        if (mscoreMajorVersion >= 4) {
          pluginId.title = qsTr("Xen Tuner - Start");
          // pluginId.thumbnailName = "some_thumbnail.png";
          pluginId.categoryCode = "composing-arranging-tools";
        }
      }

      FileIO {
        id: fileIO
        source: "./"
        onError: function(err) {
          if (err.indexOf(".json") != -1 ||
              fileIO.source.indexOf("/logs/") != -1 ||
              fileIO.source.indexOf("\\logs\\") != -1) {
            console.warn("File not found: " + fileIO.source)
          } else {
            console.error(fileIO.source + ". File IO Error: " + err);
          }
        }
      }

      FileDialog {
        id: keySignatureFileDialog
        title: "加载调号"
        folder: Qt.resolvedUrl("../Key Signature")
        nameFilters: ["Key Signature JSON (*.json)", "JSON files (*.json)", "All files (*)"]
        selectExisting: true
        selectMultiple: false
        onAccepted: {
          var selectedFileUrl = keySignatureFileDialog.fileUrl;
          pluginId.beginButtonOperation("load-key-signature", function () {
            pluginId.runLoadKeySignatureFromUrl(selectedFileUrl);
          });
        }
      }
      onPanelHeightChanged: scheduleInitialPanelSize()
      onPanelWidthChanged: scheduleInitialPanelSize()
      onWindowChanged: scheduleInitialPanelSize()
      Connections {
        target: pluginId.window
        onClosing: {
          if (!pluginId.allowClose) {
            close.accepted = false;
          }
        }
      }
Rectangle {
    // 让背景铺满整个窗口
    anchors.fill: parent
    // 纯白色背景
    color: "white"
    implicitWidth: pluginId.panelWidth
    implicitHeight: pluginId.panelHeight
GridLayout {
    columns: 3
    rowSpacing: pluginId.panelRowSpacing
    columnSpacing: pluginId.panelColumnSpacing
    anchors.fill: parent
    anchors.margins: pluginId.panelMargin
    
    RowLayout {
        Layout.row: 0
        Layout.column: 0
        Layout.columnSpan: 3
        Layout.fillWidth: true
        spacing: pluginId.panelColumnSpacing

        Button {
            id: quitButton
            text: "\u00D7"
            Layout.preferredWidth: pluginId.iconButtonWidth
            Layout.minimumWidth: pluginId.iconButtonWidth
            Layout.preferredHeight: pluginId.controlRowHeight
            Layout.minimumHeight: pluginId.controlRowHeight
            Layout.maximumHeight: pluginId.controlRowHeight
            implicitHeight: pluginId.controlRowHeight
            padding: 0
            font.pixelSize: pluginId.quitTextPixelSize
            enabled: !pluginId.buttonOperationInProgress
            opacity: enabled ? 1.0 : 0.45
            onClicked: {
                pluginId.allowClose = true;
                handleClose();
                pluginId.parent.Window.window.close();
            }
            contentItem: Text {
                text: quitButton.text
                font.pixelSize: quitButton.font.pixelSize
                horizontalAlignment: Text.AlignHCenter
                verticalAlignment: Text.AlignVCenter
            }
        }

        Button {
            id: loadKeySignatureButton
            text: "加载调号"
            Layout.preferredWidth: pluginId.actionButtonPreferredWidth
            Layout.minimumWidth: pluginId.actionButtonMinWidth
            Layout.preferredHeight: pluginId.controlRowHeight
            Layout.minimumHeight: pluginId.controlRowHeight
            Layout.maximumHeight: pluginId.controlRowHeight
            implicitHeight: pluginId.controlRowHeight
            font.pixelSize: pluginId.controlTextPixelSize
            leftPadding: pluginId.controlHorizontalPadding
            rightPadding: pluginId.controlHorizontalPadding
            enabled: !pluginId.buttonOperationInProgress
            opacity: enabled || pluginId.isButtonOperationActive("load-key-signature") ? 1.0 : 0.45
            onClicked: pluginId.openKeySignatureFileDialog()
            contentItem: Loader {
                property var buttonControl: loadKeySignatureButton
                property bool loading: pluginId.isButtonOperationActive("load-key-signature")
                property color foregroundColor: "#202020"
                sourceComponent: actionButtonContentComponent
            }
        }

        Button {
            id: enharmonicButton
            text: "等音切换"
            Layout.fillWidth: true
            Layout.preferredWidth: pluginId.actionButtonPreferredWidth
            Layout.minimumWidth: pluginId.actionButtonMinWidth
            Layout.preferredHeight: pluginId.controlRowHeight
            Layout.minimumHeight: pluginId.controlRowHeight
            Layout.maximumHeight: pluginId.controlRowHeight
            implicitHeight: pluginId.controlRowHeight
            font.pixelSize: pluginId.controlTextPixelSize
            leftPadding: pluginId.controlHorizontalPadding
            rightPadding: pluginId.controlHorizontalPadding
            enabled: !pluginId.buttonOperationInProgress
            opacity: enabled || pluginId.isButtonOperationActive("enharmonic") ? 1.0 : 0.45
            onClicked: pluginId.beginButtonOperation("enharmonic", function () {
                pluginId.runEnharmonicCycle();
            })
            contentItem: Loader {
                property var buttonControl: enharmonicButton
                property bool loading: pluginId.isButtonOperationActive("enharmonic")
                property color foregroundColor: "#202020"
                sourceComponent: actionButtonContentComponent
            }
        }
    }

    ColumnLayout {
        id: auxButtonGrid
        visible: pluginId.auxButtonGroupCount > 0
        Layout.row: 1
        Layout.column: 0
        Layout.columnSpan: 3
        Layout.fillWidth: true
        Layout.preferredHeight: pluginId.auxButtonAreaHeight
        spacing: pluginId.panelRowSpacing

        Repeater {
            model: pluginId.auxButtonGroupCount

            RowLayout {
                id: auxButtonGroupRow
                property int auxIndex: pluginId.auxButtonGroupIndex(index)
                property string auxLabel: pluginId.auxButtonGroupLabel(index)
                Layout.fillWidth: true
                Layout.preferredHeight: pluginId.controlRowHeight
                Layout.minimumHeight: pluginId.controlRowHeight
                Layout.maximumHeight: pluginId.controlRowHeight
                spacing: pluginId.panelColumnSpacing

                Rectangle {
                    Layout.fillWidth: true
                    Layout.minimumWidth: pluginId.auxLabelMinWidth
                    Layout.preferredHeight: pluginId.controlRowHeight
                    Layout.minimumHeight: pluginId.controlRowHeight
                    Layout.maximumHeight: pluginId.controlRowHeight
                    radius: pluginId.controlCornerRadius
                    border.color: "#BDC3C7"
                    border.width: 1
                    color: "white"

                    Text {
                        anchors.fill: parent
                        anchors.leftMargin: pluginId.controlHorizontalPadding
                        anchors.rightMargin: pluginId.controlHorizontalPadding
                        text: auxButtonGroupRow.auxLabel
                        font.pixelSize: pluginId.controlTextPixelSize
                        horizontalAlignment: Text.AlignHCenter
                        verticalAlignment: Text.AlignVCenter
                        elide: Text.ElideRight
                        wrapMode: Text.NoWrap
                    }
                }

                Button {
                    id: auxUpButton
                    property string operationId: "aux-up-" + auxButtonGroupRow.auxIndex
                    text: "Up"
                    Layout.preferredWidth: pluginId.actionButtonMinWidth
                    Layout.minimumWidth: pluginId.actionButtonMinWidth
                    Layout.preferredHeight: pluginId.controlRowHeight
                    Layout.minimumHeight: pluginId.controlRowHeight
                    Layout.maximumHeight: pluginId.controlRowHeight
                    implicitHeight: pluginId.controlRowHeight
                    font.pixelSize: pluginId.controlTextPixelSize
                    leftPadding: pluginId.controlHorizontalPadding
                    rightPadding: pluginId.controlHorizontalPadding
                    enabled: !pluginId.buttonOperationInProgress
                    opacity: enabled || pluginId.isButtonOperationActive(operationId) ? 1.0 : 0.45
                    onClicked: {
                        var chainNumber = auxButtonGroupRow.auxIndex;
                        pluginId.beginButtonOperation(operationId, function () {
                            pluginId.runAuxChainTranspose(1, chainNumber);
                        });
                    }
                    contentItem: Loader {
                        property var buttonControl: auxUpButton
                        property bool loading: pluginId.isButtonOperationActive(auxUpButton.operationId)
                        property color foregroundColor: "#202020"
                        sourceComponent: actionButtonContentComponent
                    }
                }

                Button {
                    id: auxDownButton
                    property string operationId: "aux-down-" + auxButtonGroupRow.auxIndex
                    text: "Down"
                    Layout.preferredWidth: pluginId.actionButtonMinWidth
                    Layout.minimumWidth: pluginId.actionButtonMinWidth
                    Layout.preferredHeight: pluginId.controlRowHeight
                    Layout.minimumHeight: pluginId.controlRowHeight
                    Layout.maximumHeight: pluginId.controlRowHeight
                    implicitHeight: pluginId.controlRowHeight
                    font.pixelSize: pluginId.controlTextPixelSize
                    leftPadding: pluginId.controlHorizontalPadding
                    rightPadding: pluginId.controlHorizontalPadding
                    enabled: !pluginId.buttonOperationInProgress
                    opacity: enabled || pluginId.isButtonOperationActive(operationId) ? 1.0 : 0.45
                    onClicked: {
                        var chainNumber = auxButtonGroupRow.auxIndex;
                        pluginId.beginButtonOperation(operationId, function () {
                            pluginId.runAuxChainTranspose(-1, chainNumber);
                        });
                    }
                    contentItem: Loader {
                        property var buttonControl: auxDownButton
                        property bool loading: pluginId.isButtonOperationActive(auxDownButton.operationId)
                        property color foregroundColor: "#202020"
                        sourceComponent: actionButtonContentComponent
                    }
                }
            }
        }
    }

    ScrollView {
        id: logScrollView
        Layout.row: pluginId.auxButtonGroupCount > 0 ? 2 : 1
        Layout.column: 0
        Layout.fillWidth: true
        Layout.fillHeight: true
        Layout.columnSpan: 3
        clip: true
        Layout.preferredHeight: pluginId.logAreaHeight
        Layout.minimumHeight: pluginId.minLogAreaHeight
        implicitHeight: pluginId.logAreaHeight
        ScrollBar.vertical.policy: ScrollBar.AlwaysOn
        ScrollBar.horizontal.policy: ScrollBar.AlwaysOff

        background: Rectangle {
            radius: 3
            border.color: "#BDC3C7"
            border.width: 1
            color: "white"
        }

        TextArea {
            id: infoText
            width: logScrollView.availableWidth
            implicitHeight: pluginId.logAreaHeight
            height: Math.max(implicitHeight, logScrollView.availableHeight)
            text: "Xen Tuner is running."
            font.pixelSize: pluginId.logTextPixelSize
            color: "black"
            readOnly: true
            selectByMouse: true
            wrapMode: TextEdit.Wrap
            padding: pluginId.logTextPadding
            background: Rectangle {
                color: "transparent"
            }
        }
    }
}
}


      Timer {
        id: buttonOperationTimer
        interval: 0
        repeat: false
        onTriggered: {
          var operation = pluginId.pendingButtonOperation;
          pluginId.pendingButtonOperation = null;
          try {
            if (operation)
              operation();
          } finally {
            pluginId.activeButtonOperationId = "";
          }
        }
      }

      Timer {
        id: restoreLogScrollTimer
        interval: 0
        repeat: false
        property real contentY: 0
        onTriggered: restoreLogScrollPosition(contentY)
      }

      Timer {
        id: ensurePanelSizeTimer
        interval: 0
        repeat: false
        onTriggered: {
          ensureInitialPanelSize();
          if (pluginId.panelSizePassesRemaining > 0) {
            pluginId.panelSizePassesRemaining--;
            if (pluginId.panelSizePassesRemaining > 0) {
              ensurePanelSizeTimer.interval = pluginId.panelSizePassesRemaining == 1 ? 250 : 50;
              ensurePanelSizeTimer.restart();
            }
          }
        }
      }

      Timer {
        id: tuningContextTimer
        interval: 250
        repeat: true
        running: true
        onTriggered: {
          syncCurrentScore();
          if (curScore) {
            refreshTuningPanel(false);
          }
        }
      }

      Shortcut {
        sequence: "Alt+R"
        context: Qt.ApplicationShortcut
        id: tuneShortcut
        onActivated: {
            Fns.preAction();
            Fns.operationTune();
            afterOperation();
        }
      }
      Shortcut {
        sequence: "J"
        context: Qt.ApplicationShortcut
        id: enharmonicShortcut
        onActivated: {
            Fns.preAction();
            Fns.operationTranspose(0, 0);
            afterOperation();
        }
      }
      Shortcut {
        sequence: "Up"
        context: Qt.ApplicationShortcut
        id: upShortcut
        onActivated: {
            Fns.preAction();
            Fns.operationTranspose(1, 0);
            afterOperation();
        }
      }
      Shortcut {
        sequence: "Alt+Up"
        context: Qt.ApplicationShortcut
        id: up1Shortcut
        onActivated: {
            Fns.preAction();
            Fns.operationTranspose(1, 1);
            afterOperation();
        }
      }
      Shortcut {
        sequence: "Ctrl+Alt+Up"
        context: Qt.ApplicationShortcut
        id: up2Shortcut
        onActivated: {
            Fns.preAction();
            Fns.operationTranspose(1, 2);
            afterOperation();
        }
      }
      Shortcut {
        sequence: "Alt+Shift+Up"
        context: Qt.ApplicationShortcut
        id: up3Shortcut
        onActivated: {
            Fns.preAction();
            Fns.operationTranspose(1, 3);
            afterOperation();
        }
      }
      Shortcut {
        sequence: "Ctrl+Alt+Shift+Up"
        context: Qt.ApplicationShortcut
        id: up4Shortcut
        onActivated: {
            Fns.preAction();
            Fns.operationTranspose(1, 4);
            afterOperation();
        }
      }
      Shortcut {
        sequence: "End"
        enabled: false // set to true to enable
        context: Qt.ApplicationShortcut
        id: up5Shortcut
        onActivated: {
            Fns.preAction();
            Fns.operationTranspose(1, 5);
            afterOperation();
        }
      }
      Shortcut {
        sequence: "End"
        enabled: false
        context: Qt.ApplicationShortcut
        id: up6Shortcut
        onActivated: {
            Fns.preAction();
            Fns.operationTranspose(1, 6);
            afterOperation();
        }
      }
      Shortcut {
        sequence: "Down"
        context: Qt.ApplicationShortcut
        id: downShortcut
        onActivated: {
            Fns.preAction();
            Fns.operationTranspose(-1, 0);
            afterOperation();
        }
      }
      Shortcut {
        sequence: "Alt+Down"
        context: Qt.ApplicationShortcut
        id: down1Shortcut
        onActivated: {
            Fns.preAction();
            Fns.operationTranspose(-1, 1);
            afterOperation();
        }
      }
      Shortcut {
        sequence: "Ctrl+Alt+Down"
        context: Qt.ApplicationShortcut
        id: down2Shortcut
        onActivated: {
            Fns.preAction();
            Fns.operationTranspose(-1, 2);
            afterOperation();
        }
      }
      Shortcut {
        sequence: "Alt+Shift+Down"
        context: Qt.ApplicationShortcut
        id: down3Shortcut
        onActivated: {
            Fns.preAction();
            Fns.operationTranspose(-1, 3);
            afterOperation();
        }
      }
      Shortcut {
        sequence: "Ctrl+Alt+Shift+Down"
        context: Qt.ApplicationShortcut
        id: down4Shortcut
        onActivated: {
            Fns.preAction();
            Fns.operationTranspose(-1, 4);
            afterOperation();
        }
      }
      Shortcut {
        sequence: "Home"
        enabled: false
        context: Qt.ApplicationShortcut
        id: down5Shortcut
        onActivated: {
            Fns.preAction();
            Fns.operationTranspose(-1, 5);
            afterOperation();
        }
      }
      Shortcut {
        sequence: "Home"
        enabled: false
        context: Qt.ApplicationShortcut
        id: down6Shortcut
        onActivated: {
            Fns.preAction();
            Fns.operationTranspose(-1, 6);
            afterOperation();
        }
      }

      onScoreStateChanged: {
        if (state.selectionChanged && curScore) {
            var elems = curScore.selection.elements;
            var el = elems[0];
            var name = el ? el.name : null;
            if (elems.length == 1 && 
                (name == "SystemText" || name == "StaffText" || 
                name == "TBox" || name == "Text" || name == "Fingering" ||
                name == "Tempo" || name == "Expression")) {
                // allow the user to use up/down arrow keys to navigate text
                Fns.setUpDownFallthrough(false);
                upShortcut.enabled = false;
                downShortcut.enabled = false;
                enharmonicShortcut.enabled = false;
            } else {
                // If no notes are selected, allow up/down arrow keys to move elements.
                Fns.setUpDownFallthrough(true);
                upShortcut.enabled = true;
                downShortcut.enabled = true;
                enharmonicShortcut.enabled = true;
            }
        }
        if (curScore) {
          syncCurrentScore();
          refreshTuningPanel(state.selectionChanged);
        }
      }

      function scoreIdentity() {
        if (!curScore)
          return "";

        var name = "";
        var path = "";
        var staves = "";
        var lastTick = "";

        try { name = String(curScore.scoreName || curScore.name || curScore.title || ""); } catch (e) { }
        try { path = String(curScore.path || ""); } catch (e2) { }
        try { staves = String(curScore.nstaves || ""); } catch (e3) { }
        try { lastTick = curScore.lastSegment ? String(curScore.lastSegment.tick || "") : ""; } catch (e4) { }

        return path + "|" + name + "|" + staves + "|" + lastTick;
      }

      function syncCurrentScore() {
        var nextIdentity = scoreIdentity();
        var changed = curScore !== lastScoreRef || nextIdentity != lastScoreIdentity;
        if (changed) {
          lastScoreRef = curScore;
          lastScoreIdentity = nextIdentity;
        }
        Fns.setCurrentScore(curScore);
        return changed;
      }

      function logScrollContentItem() {
        return logScrollView && logScrollView.contentItem ? logScrollView.contentItem : null;
      }

      function clampLogScrollPosition(contentY) {
        var item = logScrollContentItem();
        if (!item || item.contentY === undefined)
          return 0;

        var contentHeight = item.contentHeight === undefined ? item.height : item.contentHeight;
        var viewportHeight = item.height === undefined ? 0 : item.height;
        var maxContentY = Math.max(0, contentHeight - viewportHeight);
        return Math.max(0, Math.min(contentY, maxContentY));
      }

      function restoreLogScrollPosition(contentY) {
        var item = logScrollContentItem();
        if (!item || item.contentY === undefined)
          return;

        item.contentY = clampLogScrollPosition(contentY);
      }

      function setInfoTextPreservingScroll(nextText) {
        var item = logScrollContentItem();
        var oldContentY = item && item.contentY !== undefined ? item.contentY : 0;
        infoText.text = nextText;
        restoreLogScrollTimer.contentY = oldContentY;
        restoreLogScrollTimer.restart();
      }

      function refreshTuningPanel(logSelection) {
        try {
          syncCurrentScore();
          var nextText = Fns.getTuningPanelText(!!logSelection);
          refreshAuxButtons();
          if (nextText && infoText.text != nextText) {
            setInfoTextPreservingScroll(nextText);
          }
        } catch (e) {
          console.error("Failed to refresh tuning panel: " + e);
        }
      }

      function refreshAuxButtons() {
        try {
          var nextGroups = Fns.getCurrentAuxButtonGroupsForPanel();
          if (!nextGroups || nextGroups.length === undefined)
            nextGroups = [];
          auxButtonGroups = nextGroups;
          auxChainCount = Math.max(0, nextGroups.length - 1);
        } catch (e) {
          console.error("Failed to refresh aux buttons: " + e);
        }
      }

      function auxButtonGroup(index) {
        if (!auxButtonGroups || index < 0 || index >= auxButtonGroups.length)
          return null;
        return auxButtonGroups[index];
      }

      function auxButtonGroupIndex(index) {
        var group = auxButtonGroup(index);
        if (!group || group.index === undefined)
          return index;
        return group.index;
      }

      function auxButtonGroupLabel(index) {
        var group = auxButtonGroup(index);
        if (!group || group.label === undefined || group.label === "")
          return "Aux " + auxButtonGroupIndex(index);
        return group.label;
      }

      function runEnharmonicCycle() {
        Fns.preAction();
        Fns.operationTranspose(0, 0);
        afterOperation();
      }

      function runAuxChainTranspose(direction, chainNumber) {
        Fns.preAction();
        Fns.operationAuxChainTranspose(direction, chainNumber);
        afterOperation();
      }

      function openKeySignatureFileDialog() {
        syncCurrentScore();
        keySignatureFileDialog.open();
      }

      function keySignatureFilePathFromUrl(fileUrl) {
        var text = fileUrl ? fileUrl.toString() : "";
        if (text.indexOf("file:///") == 0) {
          text = text.slice(8);
          if (!text.match(/^[A-Za-z]:/)) {
            text = "/" + text;
          }
        } else if (text.indexOf("file://") == 0) {
          text = text.slice(7);
        }
        return decodeURIComponent(text);
      }

      function appendLoadKeySignatureMessage(message) {
        if (!message || message.length == 0)
          return;
        setInfoTextPreservingScroll(appendLine(infoText.text, message));
      }

      function runLoadKeySignatureFromUrl(fileUrl) {
        syncCurrentScore();
        var filePath = keySignatureFilePathFromUrl(fileUrl);
        if (filePath.length == 0) {
          appendLoadKeySignatureMessage("未选择调号文件。");
          return;
        }

        fileIO.source = filePath;
        var jsonText = fileIO.read();
        if (!jsonText || jsonText.length == 0) {
          appendLoadKeySignatureMessage("无法读取调号文件: " + filePath);
          return;
        }

        var result = null;
        Fns.preAction();
        try {
          result = Fns.operationLoadKeySignature(jsonText, filePath);
        } catch (e) {
          console.error("加载调号失败: " + e);
          result = { ok: false, message: "加载调号失败: " + e };
        } finally {
          Fns.postAction();
        }
        refreshTuningPanel(false);
        if (result && result.message) {
          appendLoadKeySignatureMessage(result.message);
        }
      }

      function afterOperation() {
        Fns.postAction();
        refreshTuningPanel(false);
      }

      function appendLine(text, newLine) {
        var lines = text.split("\n");
        lines.push(newLine);
        if (lines.length > 15) {
          lines = lines.slice(-15);
        }
        return lines.join("\n");
      }

      function handleClose() {
        console.log('Quitting');
        var shortcuts = [
          tuneShortcut, enharmonicShortcut, upShortcut, up1Shortcut,
          up2Shortcut, up3Shortcut, up4Shortcut, up5Shortcut, up6Shortcut,
          downShortcut, down1Shortcut, down2Shortcut, down3Shortcut,
          down4Shortcut, down5Shortcut, down6Shortcut
        ];
        for (var i = 0; i < shortcuts.length; i++) {
          shortcuts[i].context = Qt.WindowShortcut; // make the shortcut disappear with the window.
          console.log('disable shortcut: ' + shortcuts[i].sequence);
        }
      }
}
