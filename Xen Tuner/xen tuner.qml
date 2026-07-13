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
    id: pluginId
    version: "0.3.5"
    pluginType: "dock"
    dockArea: "left"
    description: "Starts the XenTuner plugin.\n\n" + "This will open a small docked panel to the side.\n\nIMPORTANT: Do not close the window.\n" + "Make sure you only have 1 instance of this plugin running at a time."
    menuPath: "Plugins.Xen Tuner.Start Xen Tuner"
    readonly property int logTextRows: 7
    readonly property int minLogTextRows: 3
    readonly property int logTextPointSize: 9
    readonly property int controlTextPointSize: 9
    readonly property int quitTextPointSize: 13
    readonly property int logTextPadding: 8
    readonly property int minControlRowHeight: 28
    readonly property int controlVerticalPadding: 10
    readonly property real highDpiScale: Math.max(1, Screen.devicePixelRatio || 1)
    readonly property bool layoutMetricsAreScaled: Qt.platform.os == "linux" && highDpiScale > 1 && controlTextMetrics.lineSpacing > controlTextPointSize * 2.2
    readonly property real controlLineSpacing: scaledLayoutMetric(controlTextMetrics.lineSpacing)
    readonly property real quitLineSpacing: scaledLayoutMetric(quitTextMetrics.lineSpacing)
    readonly property real logLineSpacing: scaledLayoutMetric(logTextMetrics.lineSpacing)
    readonly property int controlRowHeight: Math.max(minControlRowHeight, Math.ceil(Math.max(controlLineSpacing, quitLineSpacing) + controlVerticalPadding))
    readonly property real controlCharWidth: Math.max(1, scaledLayoutMetric(controlTextMetrics.averageCharacterWidth || controlTextMetrics.lineSpacing / 2))
    readonly property real quitCharWidth: Math.max(1, scaledLayoutMetric(quitTextMetrics.averageCharacterWidth || quitTextMetrics.lineSpacing / 2))
    readonly property int controlHorizontalPadding: Math.max(8, Math.ceil(controlCharWidth * 2))
    readonly property int controlCornerRadius: Math.max(4, Math.ceil(controlRowHeight / 5))
    readonly property int iconButtonWidth: Math.max(controlRowHeight, Math.ceil(quitCharWidth * 2 + controlHorizontalPadding))
    readonly property int actionButtonMinWidth: Math.ceil(controlCharWidth * 5 + controlHorizontalPadding * 2)
    readonly property int actionButtonPreferredWidth: Math.ceil(controlCharWidth * 12 + controlHorizontalPadding * 2)
    readonly property int panelMargin: 14
    readonly property int panelRowSpacing: 10
    readonly property int panelColumnSpacing: 10
    readonly property int panelSafetyPadding: Math.ceil(controlLineSpacing / 2)
    readonly property int panelWidthSafetyPadding: Math.ceil(controlLineSpacing)
    readonly property int logAreaHeight: Math.ceil(logLineSpacing * logTextRows + logTextPadding * 2)
    readonly property int minLogAreaHeight: Math.ceil(logLineSpacing * minLogTextRows + logTextPadding * 2)
    readonly property int auxLabelMinWidth: Math.ceil(controlCharWidth * 10 + controlHorizontalPadding * 2)
    readonly property int auxButtonGroupCount: auxButtonGroups ? auxButtonGroups.length : 0
    readonly property int auxButtonAreaHeight: auxButtonGroupCount > 0 ? auxButtonGroupCount * controlRowHeight + (auxButtonGroupCount - 1) * panelRowSpacing : 0
    readonly property int auxButtonSectionHeight: auxButtonAreaHeight > 0 ? auxButtonAreaHeight + panelRowSpacing : 0
    readonly property int filteredAuxTargetInputWidth: Math.ceil(controlCharWidth * 8 + controlHorizontalPadding * 2)
    readonly property int filteredAuxChainInputWidth: Math.ceil(controlCharWidth * 5 + controlHorizontalPadding * 2)
    readonly property int filteredAuxControlMinWidth: filteredAuxTargetInputWidth + filteredAuxChainInputWidth + actionButtonMinWidth * 2 + panelColumnSpacing * 3
    readonly property int filteredAuxSectionHeight: controlRowHeight + panelRowSpacing
    readonly property var filteredAuxTargetOptions: ["C", "D", "E", "F", "G", "A", "B"]
    readonly property var filteredAuxChainOptions: buildFilteredAuxChainOptions(auxChainCount)
    readonly property int controlsMinWidth: Math.max(iconButtonWidth + actionButtonPreferredWidth * 2 + panelColumnSpacing * 2, auxLabelMinWidth + actionButtonMinWidth * 2 + panelColumnSpacing * 2, filteredAuxControlMinWidth)
    readonly property int panelHeight: logAreaHeight + controlRowHeight + auxButtonSectionHeight + filteredAuxSectionHeight + panelRowSpacing + panelMargin * 2 + panelSafetyPadding
    readonly property int panelWidth: Math.max(320, controlsMinWidth + panelMargin * 2 + panelWidthSafetyPadding)
    readonly property int maxLogLines: 200
    implicitHeight: panelHeight
    implicitWidth: panelWidth
    readonly property var window: Window.window
    readonly property var pluginHomePath: Qt.resolvedUrl("../").replace("file:///", "")
    property bool allowClose: false
    property var lastScoreRef: null
    property string lastScoreIdentity: ""
    property bool panelSizeSchedulingReady: false
    property int panelSizePassesRemaining: 0
    property int auxChainCount: 0
    property var auxButtonGroups: []

    FontMetrics {
        id: logTextMetrics
        font.pointSize: pluginId.logTextPointSize
    }

    FontMetrics {
        id: controlTextMetrics
        font.pointSize: pluginId.controlTextPointSize
    }

    FontMetrics {
        id: quitTextMetrics
        font.pointSize: pluginId.quitTextPointSize
    }

    function scaledLayoutMetric(value) {
        if (value === undefined || value === null)
            return 0;
        return layoutMetricsAreScaled ? value / highDpiScale : value;
    }

    function buildFilteredAuxChainOptions(maxChainIndex) {
        var options = [];
        maxChainIndex = Math.max(0, maxChainIndex);
        for (var i = 0; i <= maxChainIndex; i++)
            options.push(String(i));
        return options;
    }

    function ensureInitialPanelSize() {
        if (height < pluginId.panelHeight) {
            height = pluginId.panelHeight;
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

    Component.onCompleted: {
        panelSizeSchedulingReady = true;
        scheduleInitialPanelSize();
    }
    onPanelHeightChanged: scheduleInitialPanelSize()
    onPanelWidthChanged: scheduleInitialPanelSize()
    onWindowChanged: scheduleInitialPanelSize()

    onRun: {
        console.log('Started Xen Tuner');
        // When you want to find which import has a syntax error, uncomment this line
        // console.log(JSON.stringify(Fns));

        var isMS4 = mscoreMajorVersion >= 4;
        Fns.init(Accidental, NoteType, SymId, Element, fileIO, curScore, isMS4, pluginHomePath);
        lastScoreRef = curScore;
        lastScoreIdentity = scoreIdentity();
        infoText.text = Fns.getStartupTuningLogText();
        refreshAuxButtons();
        Fns.logOperation("Start Xen Tuner");
        console.log('present working dir: ' + pluginHomePath);
        scheduleInitialPanelSize();
    }

    FileIO {
        id: fileIO
        source: "./"
        onError: function (err) {
            if (err.indexOf(".json") != -1 ||
                fileIO.source.indexOf("/logs/") != -1 ||
                fileIO.source.indexOf("\\logs\\") != -1) {
                console.warn("File not found: " + fileIO.source);
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
            pluginId.runLoadKeySignatureFromUrl(keySignatureFileDialog.fileUrl)
        }
    }

    Connections {
        target: pluginId.window
        onClosing: {
            if (!pluginId.allowClose) {
                close.accepted = false;
            }
        }
    }

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
                font.pointSize: pluginId.quitTextPointSize
                onClicked: {
                    pluginId.allowClose = true;
                    handleClose();
                    pluginId.parent.Window.window.close();
                }
                background: Rectangle {
                    radius: pluginId.controlCornerRadius;color: quitButton.pressed ? "#E74C3C" : "#C0392B"
                }
                contentItem: Text {
                    text: quitButton.text;color: "white";font.pointSize: quitButton.font.pointSize;horizontalAlignment: Text.AlignHCenter;verticalAlignment: Text.AlignVCenter
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
                font.pointSize: pluginId.controlTextPointSize
                leftPadding: pluginId.controlHorizontalPadding
                rightPadding: pluginId.controlHorizontalPadding
                onClicked: pluginId.openKeySignatureFileDialog()
                background: Rectangle {
                    radius: pluginId.controlCornerRadius;color: loadKeySignatureButton.pressed ? "#27AE60" : "#1E8449"
                }
                contentItem: Text {
                    text: loadKeySignatureButton.text;color: "white";font.pointSize: loadKeySignatureButton.font.pointSize;horizontalAlignment: Text.AlignHCenter;verticalAlignment: Text.AlignVCenter;elide: Text.ElideRight;wrapMode: Text.NoWrap
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
                font.pointSize: pluginId.controlTextPointSize
                leftPadding: pluginId.controlHorizontalPadding
                rightPadding: pluginId.controlHorizontalPadding
                onClicked: pluginId.runEnharmonicCycle()
                background: Rectangle {
                    radius: pluginId.controlCornerRadius;color: enharmonicButton.pressed ? "#3498DB" : "#2980B9"
                }
                contentItem: Text {
                    text: enharmonicButton.text;color: "white";font.pointSize: enharmonicButton.font.pointSize;horizontalAlignment: Text.AlignHCenter;verticalAlignment: Text.AlignVCenter;elide: Text.ElideRight;wrapMode: Text.NoWrap
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
                        color: "#FFFFFF"

                        Text {
                            anchors.fill: parent
                            anchors.leftMargin: pluginId.controlHorizontalPadding
                            anchors.rightMargin: pluginId.controlHorizontalPadding
                            text: auxButtonGroupRow.auxLabel
                            color: "#2C3E50"
                            font.pointSize: pluginId.controlTextPointSize
                            horizontalAlignment: Text.AlignHCenter
                            verticalAlignment: Text.AlignVCenter
                            elide: Text.ElideRight
                            wrapMode: Text.NoWrap
                        }
                    }

                    Button {
                        id: auxUpButton
                        text: "Up"
                        Layout.preferredWidth: pluginId.actionButtonMinWidth
                        Layout.minimumWidth: pluginId.actionButtonMinWidth
                        Layout.preferredHeight: pluginId.controlRowHeight
                        Layout.minimumHeight: pluginId.controlRowHeight
                        Layout.maximumHeight: pluginId.controlRowHeight
                        implicitHeight: pluginId.controlRowHeight
                        font.pointSize: pluginId.controlTextPointSize
                        leftPadding: pluginId.controlHorizontalPadding
                        rightPadding: pluginId.controlHorizontalPadding
                        onClicked: pluginId.runAuxChainTranspose(1, auxButtonGroupRow.auxIndex)
                        background: Rectangle {
                            radius: pluginId.controlCornerRadius;color: auxUpButton.pressed ? "#27AE60" : "#1E8449"
                        }
                        contentItem: Text {
                            text: auxUpButton.text;color: "white";font.pointSize: auxUpButton.font.pointSize;horizontalAlignment: Text.AlignHCenter;verticalAlignment: Text.AlignVCenter;elide: Text.ElideRight;wrapMode: Text.NoWrap
                        }
                    }

                    Button {
                        id: auxDownButton
                        text: "Down"
                        Layout.preferredWidth: pluginId.actionButtonMinWidth
                        Layout.minimumWidth: pluginId.actionButtonMinWidth
                        Layout.preferredHeight: pluginId.controlRowHeight
                        Layout.minimumHeight: pluginId.controlRowHeight
                        Layout.maximumHeight: pluginId.controlRowHeight
                        implicitHeight: pluginId.controlRowHeight
                        font.pointSize: pluginId.controlTextPointSize
                        leftPadding: pluginId.controlHorizontalPadding
                        rightPadding: pluginId.controlHorizontalPadding
                        onClicked: pluginId.runAuxChainTranspose(-1, auxButtonGroupRow.auxIndex)
                        background: Rectangle {
                            radius: pluginId.controlCornerRadius;color: auxDownButton.pressed ? "#E67E22" : "#D35400"
                        }
                        contentItem: Text {
                            text: auxDownButton.text;color: "white";font.pointSize: auxDownButton.font.pointSize;horizontalAlignment: Text.AlignHCenter;verticalAlignment: Text.AlignVCenter;elide: Text.ElideRight;wrapMode: Text.NoWrap
                        }
                    }
                }
            }
        }

        RowLayout {
            id: filteredAuxControlRow
            Layout.row: pluginId.auxButtonGroupCount > 0 ? 2 : 1
            Layout.column: 0
            Layout.columnSpan: 3
            Layout.fillWidth: true
            Layout.preferredHeight: pluginId.controlRowHeight
            Layout.minimumHeight: pluginId.controlRowHeight
            Layout.maximumHeight: pluginId.controlRowHeight
            spacing: pluginId.panelColumnSpacing

            ComboBox {
                id: filteredAuxTargetInput
                model: pluginId.filteredAuxTargetOptions
                currentIndex: 0
                Layout.preferredWidth: pluginId.filteredAuxTargetInputWidth
                Layout.minimumWidth: pluginId.filteredAuxTargetInputWidth
                Layout.preferredHeight: pluginId.controlRowHeight
                Layout.minimumHeight: pluginId.controlRowHeight
                Layout.maximumHeight: pluginId.controlRowHeight
                implicitHeight: pluginId.controlRowHeight
                font.pointSize: pluginId.controlTextPointSize
                leftPadding: pluginId.controlHorizontalPadding
                rightPadding: pluginId.controlHorizontalPadding
                background: Rectangle {
                    radius: pluginId.controlCornerRadius
                    color: "white"
                    border.color: filteredAuxTargetInput.activeFocus ? "#2980B9" : "#BDC3C7"
                    border.width: 1
                }
            }

            ComboBox {
                id: filteredAuxChainInput
                model: pluginId.filteredAuxChainOptions
                Layout.preferredWidth: pluginId.filteredAuxChainInputWidth
                Layout.minimumWidth: pluginId.filteredAuxChainInputWidth
                Layout.preferredHeight: pluginId.controlRowHeight
                Layout.minimumHeight: pluginId.controlRowHeight
                Layout.maximumHeight: pluginId.controlRowHeight
                implicitHeight: pluginId.controlRowHeight
                font.pointSize: pluginId.controlTextPointSize
                leftPadding: pluginId.controlHorizontalPadding
                rightPadding: pluginId.controlHorizontalPadding
                Component.onCompleted: pluginId.clampFilteredAuxChainInput()
                onModelChanged: pluginId.clampFilteredAuxChainInput()
                background: Rectangle {
                    radius: pluginId.controlCornerRadius
                    color: "white"
                    border.color: filteredAuxChainInput.activeFocus ? "#2980B9" : "#BDC3C7"
                    border.width: 1
                }
            }

            Button {
                id: filteredAuxUpButton
                text: "Up"
                Layout.fillWidth: true
                Layout.preferredWidth: pluginId.actionButtonMinWidth
                Layout.minimumWidth: pluginId.actionButtonMinWidth
                Layout.preferredHeight: pluginId.controlRowHeight
                Layout.minimumHeight: pluginId.controlRowHeight
                Layout.maximumHeight: pluginId.controlRowHeight
                implicitHeight: pluginId.controlRowHeight
                font.pointSize: pluginId.controlTextPointSize
                leftPadding: pluginId.controlHorizontalPadding
                rightPadding: pluginId.controlHorizontalPadding
                onClicked: pluginId.runFilteredAuxChainTranspose(1, filteredAuxTargetInput.currentText, filteredAuxChainInput.currentText)
                background: Rectangle {
                    radius: pluginId.controlCornerRadius;color: filteredAuxUpButton.pressed ? "#27AE60" : "#1E8449"
                }
                contentItem: Text {
                    text: filteredAuxUpButton.text;color: "white";font.pointSize: filteredAuxUpButton.font.pointSize;horizontalAlignment: Text.AlignHCenter;verticalAlignment: Text.AlignVCenter;elide: Text.ElideRight;wrapMode: Text.NoWrap
                }
            }

            Button {
                id: filteredAuxDownButton
                text: "Down"
                Layout.fillWidth: true
                Layout.preferredWidth: pluginId.actionButtonMinWidth
                Layout.minimumWidth: pluginId.actionButtonMinWidth
                Layout.preferredHeight: pluginId.controlRowHeight
                Layout.minimumHeight: pluginId.controlRowHeight
                Layout.maximumHeight: pluginId.controlRowHeight
                implicitHeight: pluginId.controlRowHeight
                font.pointSize: pluginId.controlTextPointSize
                leftPadding: pluginId.controlHorizontalPadding
                rightPadding: pluginId.controlHorizontalPadding
                onClicked: pluginId.runFilteredAuxChainTranspose(-1, filteredAuxTargetInput.currentText, filteredAuxChainInput.currentText)
                background: Rectangle {
                    radius: pluginId.controlCornerRadius;color: filteredAuxDownButton.pressed ? "#E67E22" : "#D35400"
                }
                contentItem: Text {
                    text: filteredAuxDownButton.text;color: "white";font.pointSize: filteredAuxDownButton.font.pointSize;horizontalAlignment: Text.AlignHCenter;verticalAlignment: Text.AlignVCenter;elide: Text.ElideRight;wrapMode: Text.NoWrap
                }
            }
        }

        ScrollView {
            id: logScrollView
            Layout.row: pluginId.auxButtonGroupCount > 0 ? 3 : 2
            Layout.column: 0
            Layout.columnSpan: 3
            Layout.fillWidth: true
            Layout.fillHeight: true
            Layout.preferredHeight: pluginId.logAreaHeight
            Layout.minimumHeight: pluginId.minLogAreaHeight
            implicitHeight: pluginId.logAreaHeight
            clip: true
            ScrollBar.vertical.policy: ScrollBar.AlwaysOn
            ScrollBar.horizontal.policy: ScrollBar.AlwaysOff

            background: Rectangle {
                radius: 6
                border.color: "#BDC3C7"
                border.width: 1
                color: "#FFFFFF"
            }

            TextArea {
                id: infoText
                width: logScrollView.availableWidth
                implicitHeight: pluginId.logAreaHeight
                height: Math.max(implicitHeight, logScrollView.availableHeight)
                text: "Xen Tuner is running."
                font.pointSize: pluginId.logTextPointSize
                color: "#2C3E50"
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
        id: tuneShortcut
        sequence: "Alt+R"
        context: Qt.ApplicationShortcut
        onActivated: {
            Fns.preAction();
            Fns.operationTune();
            afterOperation();
        }
    }
    Shortcut {
        id: enharmonicShortcut
        sequence: "J"
        context: Qt.ApplicationShortcut
        onActivated: {
            Fns.preAction();
            Fns.operationTranspose(0, 0);
            afterOperation();
        }
    }
    Shortcut {
        id: upShortcut
        sequence: "Up"
        context: Qt.ApplicationShortcut
        onActivated: {
            Fns.preAction();
            Fns.operationTranspose(1, 0);
            afterOperation();
        }
    }

    Shortcut {
        id: up1Shortcut
        sequence: "Alt+Up"
        context: Qt.ApplicationShortcut
        onActivated: {
            Fns.preAction();
            Fns.operationTranspose(1, 1);
            afterOperation();
        }
    }
    Shortcut {
        id: up2Shortcut
        sequence: "Ctrl+Alt+Up"
        context: Qt.ApplicationShortcut
        onActivated: {
            Fns.preAction();
            Fns.operationTranspose(1, 2);
            afterOperation();
        }
    }
    Shortcut {
        id: up3Shortcut
        sequence: "Alt+Shift+Up"
        context: Qt.ApplicationShortcut
        onActivated: {
            Fns.preAction();
            Fns.operationTranspose(1, 3);
            afterOperation();
        }
    }
    Shortcut {
        id: up4Shortcut
        sequence: "Ctrl+Alt+Shift+Up"
        context: Qt.ApplicationShortcut
        onActivated: {
            Fns.preAction();
            Fns.operationTranspose(1, 4);
            afterOperation();
        }
    }
    Shortcut {
        id: up5Shortcut
        sequence: "End"
        enabled: false // set to true to enable
        context: Qt.ApplicationShortcut
        onActivated: {
            Fns.preAction();
            Fns.operationTranspose(1, 5);
            afterOperation();
        }
    }
    Shortcut {
        id: up6Shortcut
        sequence: "End"
        enabled: false
        context: Qt.ApplicationShortcut
        onActivated: {
            Fns.preAction();
            Fns.operationTranspose(1, 6);
            afterOperation();
        }
    }
    Shortcut {
        id: downShortcut
        sequence: "Down"
        context: Qt.ApplicationShortcut
        onActivated: {
            Fns.preAction();
            Fns.operationTranspose(-1, 0);
            afterOperation();
        }
    }
    Shortcut {
        id: down1Shortcut
        sequence: "Alt+Down"
        context: Qt.ApplicationShortcut
        onActivated: {
            Fns.preAction();
            Fns.operationTranspose(-1, 1);
            afterOperation();
        }
    }
    Shortcut {
        id: down2Shortcut
        sequence: "Ctrl+Alt+Down"
        context: Qt.ApplicationShortcut
        onActivated: {
            Fns.preAction();
            Fns.operationTranspose(-1, 2);
            afterOperation();
        }
    }
    Shortcut {
        id: down3Shortcut
        sequence: "Alt+Shift+Down"
        context: Qt.ApplicationShortcut
        onActivated: {
            Fns.preAction();
            Fns.operationTranspose(-1, 3);
            afterOperation();
        }
    }
    Shortcut {
        id: down4Shortcut
        sequence: "Ctrl+Alt+Shift+Down"
        context: Qt.ApplicationShortcut
        onActivated: {
            Fns.preAction();
            Fns.operationTranspose(-1, 4);
            afterOperation();
        }
    }
    Shortcut {
        id: down5Shortcut
        sequence: "Home"
        enabled: false
        context: Qt.ApplicationShortcut
        onActivated: {
            Fns.preAction();
            Fns.operationTranspose(-1, 5);
            afterOperation();
        }
    }
    Shortcut {
        id: down6Shortcut
        sequence: "Home"
        enabled: false
        context: Qt.ApplicationShortcut
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
            if (elems.length == 1 && (name == "SystemText" || name == "StaffText" || name == "TBox" || name == "Text" || name == "Fingering" || name == "Tempo" || name == "Expression")) {
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
            clampFilteredAuxChainInput();
        } catch (e) {
            console.error("Failed to refresh aux buttons: " + e);
        }
    }

    function clampFilteredAuxChainInput() {
        var maxChainIndex = Math.max(0, auxChainCount);
        var chainNumber = filteredAuxChainInput.currentIndex;
        if (isNaN(chainNumber))
            chainNumber = maxChainIndex >= 1 ? 1 : 0;
        chainNumber = Math.max(0, Math.min(chainNumber, maxChainIndex));
        filteredAuxChainInput.currentIndex = chainNumber;
        return chainNumber;
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

    function runFilteredAuxChainTranspose(direction, targetNotes, chainNumber) {
        chainNumber = clampFilteredAuxChainInput();
        Fns.preAction();
        Fns.operationFilteredAuxChainTranspose(direction, chainNumber, targetNotes);
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
        // Don't do this, it will steal focus from the score
        // pluginId.window.requestActivate();
        Fns.postAction();
        refreshTuningPanel(false);
    }

    function handleClose() {
        console.log('Quitting');
        var shortcuts = [tuneShortcut, enharmonicShortcut, upShortcut, up1Shortcut, up2Shortcut, up3Shortcut, up4Shortcut, up5Shortcut, up6Shortcut, downShortcut, down1Shortcut, down2Shortcut, down3Shortcut, down4Shortcut, down5Shortcut, down6Shortcut];
        for (var i = 0; i < shortcuts.length; i++) {
            shortcuts[i].context = Qt.WindowShortcut; // make the shortcut disappear with the window.
            console.log('disable shortcut: ' + shortcuts[i].sequence);
        }
        Qt.quit(); // TODO: Delete for MS4, use dialog instead of dock plugin type.
    }

    function appendLine(text, newLine) {
        var lines = text.split("\n");
        lines.push(newLine);
        if (lines.length > maxLogLines) {
            lines = lines.slice(-maxLogLines);
        }
        return lines.join("\n");
    }
}
