// Standalone microtonal MIDI exporter for MuseScore plugins.
// Exports MuseScore's native MIDI, then writes MIDX, MIDI 2.0, and
// MIDI 1.0 pitch-bend representations of the microtonal notes.

import MuseScore 3.0
import QtQuick 2.9
import QtQuick.Controls 2.2
import QtQuick.Dialogs
import FileIO 3.0

MuseScore {
      version: "0.3.9"
      description: "Exports the score/selection as MIDX, MIDI 2.0, and MIDI 1.0 with pitch-bend events."
      menuPath: "Plugins.Xen Tuner.Export MIDX"

      id: pluginId
      readonly property int midxCentRange: 64
      readonly property int midxSafeCentRange: 63
      readonly property int midxOffsetSteps: 32768
      readonly property int midxExperimentalManufacturerId: 0x7D
      readonly property int midxPitchedOffsetRecordType: 0x03
      readonly property real pitchBendRangeSemitones: 2.0
      readonly property string resourceRoot: {
        var resolved = Qt.resolvedUrl("../");
        if (fileIO && typeof fileIO.toLocalFile === "function") {
          var local = fileIO.toLocalFile(resolved);
          if (local)
            return local;
        }
        return resolved.toString();
      }
      readonly property string writableRoot: {
        var appData = fileIO && typeof fileIO.appDataPath === "function" ? fileIO.appDataPath() : "";
        return appData ? appData + "/plugins/musescore-xen-tuner" : "";
      }

      function ensureWritablePaths() {
        if (!writableRoot || !fileIO || typeof fileIO.makePath !== "function")
          return false;
        return fileIO.makePath(writableRoot + "/cache");
      }

      function writerJobPath() {
        return writableRoot ? writableRoot + "/cache/midx_writer_job.txt" : "";
      }

      Component.onCompleted : {
        if (mscoreMajorVersion >= 4) {
          pluginId.title = qsTr("Export MIDX");
          pluginId.categoryCode = "composing-arranging-tools";
        }
      }

      FileIO {
        id: fileIO
        source: "./"
        onError: function(err) {
          console.error(fileIO.source + ". File IO Error: " + err);
        }
      }

      QProcess {
        id: proc
      }

      MessageDialog {
        id: messageDialog
        title: ""
        text: ""
        onAccepted: Qt.quit()
        onRejected: Qt.quit()
      }

      function clampNumber(value, min, max) {
        value = Number(value);
        if (!isFinite(value)) {
          value = 0;
        }
        if (value < min) {
          return min;
        }
        if (value > max) {
          return max;
        }
        return value;
      }

      function pushAscii(bytes, text) {
        for (var i = 0; i < text.length; i++) {
          bytes.push(text.charCodeAt(i) & 0xFF);
        }
      }

      function pushU16BE(bytes, value) {
        value = Math.round(clampNumber(value, 0, 0xFFFF));
        bytes.push(Math.floor(value / 256) & 0xFF);
        bytes.push(value & 0xFF);
      }

      function pushU24BE(bytes, value) {
        value = Math.round(clampNumber(value, 0, 0xFFFFFF));
        bytes.push(Math.floor(value / 65536) & 0xFF);
        bytes.push(Math.floor(value / 256) & 0xFF);
        bytes.push(value & 0xFF);
      }

      function pushU32BE(bytes, value) {
        value = Math.round(clampNumber(value, 0, 0xFFFFFFFF));
        bytes.push(Math.floor(value / 16777216) & 0xFF);
        bytes.push(Math.floor(value / 65536) & 0xFF);
        bytes.push(Math.floor(value / 256) & 0xFF);
        bytes.push(value & 0xFF);
      }

      function pushVLQ(bytes, value) {
        value = Math.round(clampNumber(value, 0, 0x0FFFFFFF));
        var stack = [value & 0x7F];
        value = Math.floor(value / 128);
        while (value > 0) {
          stack.unshift((value & 0x7F) | 0x80);
          value = Math.floor(value / 128);
        }
        for (var i = 0; i < stack.length; i++) {
          bytes.push(stack[i]);
        }
      }

      function appendBytes(target, source) {
        for (var i = 0; i < source.length; i++) {
          target.push(source[i] & 0xFF);
        }
      }

      function makeChunk(type, data) {
        var bytes = [];
        pushAscii(bytes, type);
        pushU32BE(bytes, data.length);
        appendBytes(bytes, data);
        return bytes;
      }

      function makeHeaderChunk(ticksPerQuarter, trackCount) {
        var data = [];
        pushU16BE(data, 1);
        pushU16BE(data, trackCount);
        pushU16BE(data, ticksPerQuarter);
        return makeChunk("MThd", data);
      }

      function makeTempoTrack(tempoEvents) {
        var data = [];
        var sortedTempos = tempoEvents.slice(0).sort(function(a, b) {
          return a.tick - b.tick;
        });
        var prevTick = 0;

        if (sortedTempos.length == 0) {
          sortedTempos.push({ tick: 0, bpm: 120 });
        }

        for (var i = 0; i < sortedTempos.length; i++) {
          var tick = Math.round(clampNumber(sortedTempos[i].tick, 0, 0xFFFFFFFF));
          var bpm = clampNumber(sortedTempos[i].bpm, 1, 1000);
          var mpqn = Math.round(60000000 / bpm);
          pushVLQ(data, tick - prevTick);
          data.push(0xFF);
          data.push(0x51);
          data.push(0x03);
          pushU24BE(data, mpqn);
          prevTick = tick;
        }

        pushVLQ(data, 0);
        data.push(0xFF);
        data.push(0x2F);
        data.push(0x00);
        return makeChunk("MTrk", data);
      }

      function encodeCentOffset(cents) {
        cents = Number(cents);
        if (!isFinite(cents)) {
          cents = 0;
        }
        var sign = cents < 0 ? 0x8000 : 0;
        var magnitude = Math.round(Math.abs(cents) / pluginId.midxCentRange * pluginId.midxOffsetSteps);
        if (magnitude > 0x7FFF) {
          magnitude = 0x7FFF;
        }
        return sign | magnitude;
      }

      function hasMidxOffset(event) {
        return (encodeCentOffset(event.cents) & 0x7FFF) != 0;
      }

      function normalizeMidxPitchCents(pitch, cents) {
        pitch = Number(pitch);
        cents = Number(cents);

        if (!isFinite(pitch)) {
          pitch = 0;
        }
        if (!isFinite(cents)) {
          cents = 0;
        }

        var targetPitch = Math.round(pitch);
        var residualCents = cents + (pitch - targetPitch) * 100;
        var guard = 0;

        while (residualCents > pluginId.midxSafeCentRange && guard < 512) {
          targetPitch += 1;
          residualCents -= 100;
          guard++;
        }

        while (residualCents < -pluginId.midxSafeCentRange && guard < 512) {
          targetPitch -= 1;
          residualCents += 100;
          guard++;
        }

        if (Math.abs(residualCents) < 0.000001) {
          residualCents = 0;
        }

        return {
          pitch: targetPitch,
          cents: residualCents
        };
      }

      function pushMidxOffsetExtension(bytes, event) {
        bytes.push(0xFF);
        bytes.push(0x7F);
        bytes.push(0x07);
        bytes.push(pluginId.midxExperimentalManufacturerId);
        bytes.push(0x58);
        bytes.push(0x54);
        bytes.push(pluginId.midxPitchedOffsetRecordType);
        bytes.push(Math.round(clampNumber(event.pitch, 0, 127)));
        pushU16BE(bytes, encodeCentOffset(event.cents));
      }

      function pushNativeMidiNoteEvent(bytes, event) {
        var pitch = Math.round(clampNumber(event.pitch, 0, 127));
        var velocity = Math.round(clampNumber(event.velocity, 0, 127));

        if (velocity > 0) {
          bytes.push(0x90);
          bytes.push(pitch);
          bytes.push(velocity);
        } else {
          bytes.push(0x80);
          bytes.push(pitch);
          bytes.push(0x00);
        }
      }

      function makeMidxTrack(noteEvents) {
        var data = [];
        var sortedEvents = noteEvents.slice(0).sort(function(a, b) {
          if (a.tick != b.tick) {
            return a.tick - b.tick;
          }
          if ((a.velocity == 0) != (b.velocity == 0)) {
            return a.velocity == 0 ? -1 : 1;
          }
          return a.pitch - b.pitch;
        });
        var prevTick = 0;

        for (var i = 0; i < sortedEvents.length; i++) {
          var tick = Math.round(clampNumber(sortedEvents[i].tick, 0, 0xFFFFFFFF));
          pushVLQ(data, tick - prevTick);
          if (sortedEvents[i].velocity > 0 && hasMidxOffset(sortedEvents[i])) {
            pushMidxOffsetExtension(data, sortedEvents[i]);
            pushVLQ(data, 0);
          }
          pushNativeMidiNoteEvent(data, sortedEvents[i]);
          prevTick = tick;
        }

        pushVLQ(data, 0);
        data.push(0xFF);
        data.push(0x2F);
        data.push(0x00);
        return makeChunk("MTrk", data);
      }

      function bytesToBinaryString(bytes) {
        var chunks = [];
        var chunkSize = 4096;
        for (var i = 0; i < bytes.length; i += chunkSize) {
          var part = [];
          var end = Math.min(i + chunkSize, bytes.length);
          for (var j = i; j < end; j++) {
            part.push(bytes[j] & 0xFF);
          }
          chunks.push(String.fromCharCode.apply(String, part));
        }
        return chunks.join("");
      }

      function byteToHex(value) {
        var hex = (value & 0xFF).toString(16);
        return hex.length == 1 ? "0" + hex : hex;
      }

      function bytesToHex(bytes) {
        var chunks = [];
        var chunk = "";
        for (var i = 0; i < bytes.length; i++) {
          chunk += byteToHex(bytes[i]);
          if (chunk.length >= 4096) {
            chunks.push(chunk);
            chunk = "";
          }
        }
        if (chunk.length > 0) {
          chunks.push(chunk);
        }
        return chunks.join("\n") + "\n";
      }

      function offsetEventsToText(noteEvents) {
        var lines = [];
        for (var i = 0; i < noteEvents.length; i++) {
          if (noteEvents[i].velocity <= 0 || !hasMidxOffset(noteEvents[i])) {
            continue;
          }
          var track = Math.max(0, Math.round(clampNumber(noteEvents[i].staff, 0, 255)));
          var tick = Math.round(clampNumber(noteEvents[i].tick, 0, 0xFFFFFFFF));
          var pitch = Math.round(clampNumber(noteEvents[i].pitch, 0, 127));
          var offset = encodeCentOffset(noteEvents[i].cents);
          lines.push(track + "," + tick + "," + pitch + "," + offset);
        }
        return lines.join("\n") + (lines.length > 0 ? "\n" : "");
      }

      function countOffsetEvents(noteEvents) {
        var count = 0;
        for (var i = 0; i < noteEvents.length; i++) {
          if (noteEvents[i].velocity > 0 && hasMidxOffset(noteEvents[i])) {
            count++;
          }
        }
        return count;
      }

      function makeMidxFileBytes(ticksPerQuarter, tempoEvents, noteEvents) {
        var bytes = [];
        var eventsByStaff = {};
        var staffKeys = [];

        for (var i = 0; i < noteEvents.length; i++) {
          var key = String(noteEvents[i].staff);
          if (!eventsByStaff[key]) {
            eventsByStaff[key] = [];
            staffKeys.push(key);
          }
          eventsByStaff[key].push(noteEvents[i]);
        }

        staffKeys.sort(function(a, b) {
          return Number(a) - Number(b);
        });

        appendBytes(bytes, makeHeaderChunk(ticksPerQuarter, 1 + staffKeys.length));
        appendBytes(bytes, makeTempoTrack(tempoEvents));

        for (var j = 0; j < staffKeys.length; j++) {
          appendBytes(bytes, makeMidxTrack(eventsByStaff[staffKeys[j]]));
        }

        return bytes;
      }

      function writeTextFile(path, text) {
        fileIO.source = path;
        return fileIO.write(text);
      }

      function readKeyValueFile(path) {
        var values = {};
        fileIO.source = path;
        var text = "";
        try {
          text = "" + fileIO.read();
        } catch (e) {
          return values;
        }
        var lines = text.split(/\r?\n/);
        for (var i = 0; i < lines.length; i++) {
          var equals = lines[i].indexOf("=");
          if (equals > 0) {
            values[lines[i].slice(0, equals)] = lines[i].slice(equals + 1);
          }
        }
        return values;
      }

      function removeFile(path) {
        fileIO.source = path;
        if (fileIO.exists()) {
          return fileIO.remove();
        }
        return true;
      }

      function fileExists(path) {
        fileIO.source = path;
        return fileIO.exists();
      }

      function strStartsWith(str, prefix) {
        return str.slice(0, prefix.length) == prefix;
      }

      function strEndsWith(str, suffix) {
        return suffix.length == 0 || str.slice(str.length - suffix.length) == suffix;
      }

      function isWindowsDrivePath(path) {
        if (path.length < 3) {
          return false;
        }
        var first = path.charCodeAt(0);
        return path.charAt(1) == ":" && path.charAt(2) == "/" &&
          ((first >= 65 && first <= 90) || (first >= 97 && first <= 122));
      }

      function localPathFromUrl(url) {
        var path = "" + url;
        if (strStartsWith(path, "file:///")) {
          path = path.slice(8);
        } else if (strStartsWith(path, "file://")) {
          path = "//" + path.slice(7);
        }
        path = decodeURIComponent(path);
        if (strStartsWith(path, "/") && isWindowsDrivePath(path.slice(1))) {
          path = path.slice(1);
        } else if (!strStartsWith(path, "/") && !isWindowsDrivePath(path)) {
          path = "/" + path;
        }
        if (strEndsWith(path, "/")) {
          path = path.slice(0, path.length - 1);
        }
        return path;
      }

      function pluginDirectoryPath() {
        var resolved = Qt.resolvedUrl(".");
        if (fileIO && typeof fileIO.toLocalFile === "function") {
          var local = fileIO.toLocalFile(resolved);
          if (local)
            return local;
        }
        return localPathFromUrl(resolved);
      }

      function quoteCommandArg(value) {
        value = "" + value;
        return '"' + value.split('"').join('\\"') + '"';
      }

      function pythonString(value) {
        value = "" + value;
        var out = 'u"';
        for (var i = 0; i < value.length; i++) {
          var code = value.charCodeAt(i);
          var ch = value.charAt(i);
          if (ch == "\\") {
            out += "\\\\";
          } else if (ch == '"') {
            out += '\\"';
          } else if (ch == "\n") {
            out += "\\n";
          } else if (ch == "\r") {
            out += "\\r";
          } else if (ch == "\t") {
            out += "\\t";
          } else if (code < 32 || code > 126) {
            var hex = code.toString(16);
            while (hex.length < 4) {
              hex = "0" + hex;
            }
            out += "\\u" + hex;
          } else {
            out += ch;
          }
        }
        return out + '"';
      }

      function makePythonWriterScript(hexPath, outputPath, debugPath) {
        return [
          "from __future__ import print_function, unicode_literals\n",
          "import binascii\n",
          "import os\n",
          "import sys\n",
          "hex_path = " + pythonString(hexPath) + "\n",
          "output_path = " + pythonString(outputPath) + "\n",
          "debug_path = " + pythonString(debugPath) + "\n",
          "def log(message):\n",
          "    print(message)\n",
          "    try:\n",
          "        with open(debug_path, 'ab') as debug_file:\n",
          "            debug_file.write((message + '\\n').encode('utf-8'))\n",
          "    except Exception:\n",
          "        pass\n",
          "log('PYTHON_EXECUTABLE=%s' % sys.executable)\n",
          "log('PYTHON_VERSION=%s' % sys.version.replace('\\n', ' '))\n",
          "log('CWD=%s' % os.getcwd())\n",
          "log('HEX_PATH=%s' % hex_path)\n",
          "log('OUTPUT_PATH=%s' % output_path)\n",
          "try:\n",
          "    log('HEX_EXISTS=%s' % os.path.exists(hex_path))\n",
          "    if os.path.exists(hex_path):\n",
          "        log('HEX_SIZE=%d' % os.path.getsize(hex_path))\n",
          "    with open(hex_path, 'rb') as infile:\n",
          "        hex_data = b''.join(infile.read().split())\n",
          "    log('HEX_DIGITS=%d' % len(hex_data))\n",
          "    data = binascii.unhexlify(hex_data)\n",
          "    log('BINARY_BYTES=%d' % len(data))\n",
          "    with open(output_path, 'wb') as outfile:\n",
          "        outfile.write(data)\n",
          "    log('OUTPUT_EXISTS=%s' % os.path.exists(output_path))\n",
          "    if os.path.exists(output_path):\n",
          "        log('OUTPUT_SIZE=%d' % os.path.getsize(output_path))\n",
          "    log('WROTE %d bytes to %s' % (len(data), output_path))\n",
          "except Exception as exc:\n",
          "    log('ERROR_TYPE=%s' % exc.__class__.__name__)\n",
          "    log('ERROR: %s' % exc)\n",
          "    sys.exit(1)\n"
        ].join("");
      }

      function pythonCommandCandidates(scriptPath, jobPath) {
        var commands = [];
        var os = (Qt.platform && Qt.platform.os) ? Qt.platform.os : "";
        var shellHelperPath = pluginDirectoryPath() + "/midx_shell_writer.sh";
        var powershellHelperPath = pluginDirectoryPath() + "/midx_powershell_writer.ps1";
        var pythonHelperPath = pluginDirectoryPath() + "/midx_python_writer.py";
        var helperArgs = jobPath ? ["--job-path", jobPath] : [];
        var powerShellArgs = [
          "-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass",
          "-File", powershellHelperPath
        ];
        if (jobPath) {
          powerShellArgs = powerShellArgs.concat(["-JobPath", jobPath]);
        }

        if (os != "windows") {
          commands.push({
            program: shellHelperPath,
            args: helperArgs,
            helper: true,
            label: "bundledShellHelper"
          });
          commands.push({
            program: shellHelperPath,
            args: helperArgs,
            label: "bundledShellHelperQuoted"
          });
        }

        if (os == "windows") {
          commands.push(
            {
              program: "C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe",
              args: powerShellArgs,
              label: "windowsPowerShellFullPathHelper"
            },
            {
              program: "C:/Windows/Sysnative/WindowsPowerShell/v1.0/powershell.exe",
              args: powerShellArgs,
              label: "windowsPowerShellSysnativeHelper"
            },
            {
              program: "powershell.exe",
              args: powerShellArgs,
              label: "windowsPowerShellPathHelper"
            }
          );
        }

        if (os != "windows") {
          commands.push({ program: pythonHelperPath, args: jobPath ? [jobPath] : [], helper: true, label: "bundledPythonHelperExecutable" });
        }

        if (scriptPath && scriptPath != "") {
          if (os == "windows") {
            commands.push(
              { program: "py", args: ["-3", scriptPath], label: "windowsPyLauncher3GeneratedWriter" },
              { program: "python", args: [scriptPath], label: "windowsPythonGeneratedWriter" },
              { program: "python3", args: [scriptPath], label: "windowsPython3GeneratedWriter" },
              { program: "py", args: [scriptPath], label: "windowsPyLauncherGeneratedWriter" }
            );
          } else {
            commands.push(
              { program: "python3", args: [scriptPath], label: "python3GeneratedWriter" },
              { program: "/usr/bin/python3", args: [scriptPath], label: "usrBinPython3GeneratedWriter" },
              { program: "python", args: [scriptPath], label: "pythonGeneratedWriter" }
            );
          }
        }

        return commands;
      }

      function commandToString(candidate) {
        var args = candidate.args || [];
        var text = quoteCommandArg(candidate.program);
        for (var i = 0; i < args.length; i++) {
          text += " " + quoteCommandArg(args[i]);
        }
        return text;
      }

      function shellCommand(command) {
        var os = (Qt.platform && Qt.platform.os) ? Qt.platform.os : "";
        if (os == "windows") {
          return command;
        }
        return "/bin/sh -c " + quoteCommandArg(command);
      }

      function appendProcessValue(output, label, value) {
        try {
          if (value === undefined) {
            return output + label + "=<undefined>\n";
          }
          if (typeof value == "function") {
            return output + label + "=<function>\n";
          }
          return output + label + "=" + value + "\n";
        } catch (e) {
          return output + label + "=<error: " + e + ">\n";
        }
      }

      function readProcessOutput() {
        var output = "";
        output = appendProcessValue(output, "exitCode", proc.exitCode);
        output = appendProcessValue(output, "exitStatus", proc.exitStatus);
        output = appendProcessValue(output, "error", proc.error);
        output = appendProcessValue(output, "errorString", proc.errorString);
        output += "stdout:\n";
        try {
          output += "" + proc.readAllStandardOutput() + "\n";
        } catch (e) {
          output += "<readAllStandardOutput error: " + e + ">\n";
        }
        output += "stderr:\n";
        try {
          if (typeof proc.readAllStandardError == "function") {
            output += "" + proc.readAllStandardError() + "\n";
          } else {
            output += "<readAllStandardError unavailable>\n";
          }
        } catch (e) {
          output += "<readAllStandardError error: " + e + ">\n";
        }
        return output;
      }

      function readProcessExitCode() {
        try {
          var value = proc.exitCode;
          if (typeof value == "function") {
            value = proc.exitCode();
          }
          value = Number(value);
          return isFinite(value) ? value : null;
        } catch (e) {
          return null;
        }
      }

      function startProcessCandidate(candidate) {
        var output = "";
        var args = candidate.args || [];
        var shell = shellCommand(commandToString(candidate) + " 2>&1");
        if (candidate.label) {
          output += "candidateLabel=" + candidate.label + "\n";
        }
        output += "candidate=" + commandToString(candidate) + "\n";
        output += "shellFallback=" + shell + "\n";
        output += "startWithArgsAvailable=" + (typeof proc.startWithArgs == "function") + "\n";

        try {
          if (typeof proc.startWithArgs == "function") {
            output += "startMethod=startWithArgs(program,args)\n";
            proc.startWithArgs(candidate.program, args);
          } else if (args.length == 0) {
            output += "startMethod=start(program)\n";
            proc.start(candidate.program);
          } else {
            output += "startMethod=start(shellCommand)\n";
            proc.start(shell);
          }
        } catch (e) {
          output += "startMethodFailed=" + e + "\n";
          output += "startMethod=start(shellCommand)\n";
          try {
            proc.start(shell);
          } catch (shellError) {
            output += "shellStartFailed=" + shellError + "\n";
            return {
              finished: false,
              exitCode: null,
              output: output
            };
          }
        }

        var finished = false;
        try {
          finished = proc.waitForFinished(120000);
        } catch (waitError) {
          output += "waitForFinishedError=" + waitError + "\n";
        }
        output += "finished=" + finished + "\n";
        var exitCode = readProcessExitCode();
        output += "resolvedExitCode=" + (exitCode === null ? "<unavailable>" : exitCode) + "\n";
        output += readProcessOutput();

        return {
          finished: finished,
          exitCode: exitCode,
          output: output
        };
      }

      function summarizeFile(path, label) {
        var output = label + "=" + path + "\n";
        output += label + ".exists=" + fileExists(path) + "\n";
        return output;
      }

      function writeBinaryFileWithPython(path, bytes) {
        var hexPath = path + ".hex";
        var scriptPath = path + ".write_midx.py";
        var debugPath = path + ".debug.log";
        var jobPath = writerJobPath();
        if (!jobPath) {
          return {
            success: false,
            message: "Xen Tuner writable cache directory is unavailable."
          };
        }
        var shellHelperPath = pluginDirectoryPath() + "/midx_shell_writer.sh";
        var commands = pythonCommandCandidates(scriptPath, jobPath);
        var output = "MIDX Python fallback debug\n";
        output += "platform=" + ((Qt.platform && Qt.platform.os) ? Qt.platform.os : "<unknown>") + "\n";
        output += "pluginDirectory=" + pluginDirectoryPath() + "\n";
        output += "jobPath=" + jobPath + "\n";
        output += "shellHelperPath=" + shellHelperPath + "\n";
        output += "targetPath=" + path + "\n";
        output += "byteCount=" + bytes.length + "\n";

        removeFile(path);
        removeFile(debugPath);

        if (!writeTextFile(hexPath, bytesToHex(bytes))) {
          return {
            success: false,
            message: "Could not write temporary hex file: " + hexPath
          };
        }
        output += summarizeFile(hexPath, "hexFile");

        if (!writeTextFile(scriptPath, makePythonWriterScript(hexPath, path, debugPath))) {
          return {
            success: false,
            message: "Could not write temporary Python writer: " + scriptPath
          };
        }
        output += summarizeFile(scriptPath, "scriptFile");
        output += summarizeFile(shellHelperPath, "shellHelperFile");

        if (!writeTextFile(jobPath,
            "hex_path=" + hexPath + "\n" +
            "output_path=" + path + "\n" +
            "debug_path=" + debugPath + "\n")) {
          return {
            success: false,
            message: "Could not write MIDX helper job file: " + jobPath
          };
        }
        output += summarizeFile(jobPath, "jobFile");

        for (var i = 0; i < commands.length; i++) {
          removeFile(path);
          output += "\n--- attempt " + (i + 1) + " ---\n";
          var attempt = startProcessCandidate(commands[i]);
          output += attempt.output;
          output += summarizeFile(path, "targetFile");
          writeTextFile(debugPath, output);

          if (attempt.finished && fileExists(path)) {
            removeFile(hexPath);
            removeFile(scriptPath);
            removeFile(jobPath);
            return {
              success: true,
              method: commandToString(commands[i]),
              message: output
            };
          }
        }

        writeTextFile(debugPath, output);
        return {
          success: false,
          message: "Python writer failed. Detailed log:\n" + debugPath +
            "\nTemporary files were left for debugging:\n" + hexPath + "\n" + scriptPath + "\n" + jobPath
        };
      }

      function writeBinaryFile(path, bytes) {
        fileIO.source = path;
        if (typeof fileIO.writeBytes == "function") {
          if (fileIO.writeBytes(bytes)) {
            return {
              success: true,
              method: "FileIO.writeBytes",
              message: ""
            };
          }
        }
        if (typeof fileIO.writeBinaryHex == "function") {
          if (fileIO.writeBinaryHex(bytesToHex(bytes))) {
            return {
              success: true,
              method: "FileIO.writeBinaryHex",
              message: ""
            };
          }
        }
        if (typeof fileIO.writeBinary == "function") {
          if (fileIO.writeBinary(bytesToBinaryString(bytes))) {
            return {
              success: true,
              method: "FileIO.writeBinary",
              message: ""
            };
          }
        }
        return writeBinaryFileWithPython(path, bytes);
      }

      function writeNativeMidiFile(path) {
        removeFile(path);
        try {
          if (typeof writeScore == "function") {
            var ok = writeScore(curScore, path, "mid");
            if (!ok && !fileExists(path)) {
              ok = writeScore(curScore, path, "midi");
            }
            return fileExists(path);
          }
        } catch (e) {
          console.log("writeScore MIDI export failed: " + e);
        }
        return false;
      }

      function writeMidxFromNativeMidi(path, noteEvents) {
        var nativeMidiPath = path + ".native.mid";
        var offsetPath = path + ".offsets.csv";
        var debugPath = path + ".debug.log";
        var midi2Path = getMidi2ExportPath(path);
        var pitchBendPath = getPitchBendMidiExportPath(path);
        var completionPath = path + ".writer.complete";
        var jobPath = writerJobPath();
        if (!jobPath) {
          return {
            success: false,
            message: "Xen Tuner writable cache directory is unavailable."
          };
        }
        var shellHelperPath = pluginDirectoryPath() + "/midx_shell_writer.sh";
        var commands = pythonCommandCandidates("", jobPath);
        var ticksPerQuarter = (typeof division === "undefined") ? 480 : division;
        var output = "MIDX native MIDI injection debug\n";
        output += "platform=" + ((Qt.platform && Qt.platform.os) ? Qt.platform.os : "<unknown>") + "\n";
        output += "pluginDirectory=" + pluginDirectoryPath() + "\n";
        output += "jobPath=" + jobPath + "\n";
        output += "shellHelperPath=" + shellHelperPath + "\n";
        output += "nativeMidiPath=" + nativeMidiPath + "\n";
        output += "offsetPath=" + offsetPath + "\n";
        output += "targetPath=" + path + "\n";
        output += "midi2Path=" + midi2Path + "\n";
        output += "pitchBendPath=" + pitchBendPath + "\n";
        output += "completionPath=" + completionPath + "\n";
        output += "pitchBendRangeSemitones=" + pluginId.pitchBendRangeSemitones + "\n";
        output += "ticksPerQuarter=" + ticksPerQuarter + "\n";
        output += "offsetCount=" + countOffsetEvents(noteEvents) + "\n";

        if (!removeFile(completionPath)) {
          return {
            success: false,
            message: "Could not clear stale writer completion file: " + completionPath
          };
        }
        removeFile(debugPath);

        if (!writeNativeMidiFile(nativeMidiPath)) {
          return {
            success: false,
            message: "Could not export native MIDI through MuseScore writeScore()."
          };
        }
        output += summarizeFile(nativeMidiPath, "nativeMidiFile");

        if (!writeTextFile(offsetPath, offsetEventsToText(noteEvents))) {
          return {
            success: false,
            message: "Could not write MIDX offset file: " + offsetPath
          };
        }
        output += summarizeFile(offsetPath, "offsetFile");
        output += summarizeFile(shellHelperPath, "shellHelperFile");

        if (!writeTextFile(jobPath,
            "native_midi_path=" + nativeMidiPath + "\n" +
            "offset_path=" + offsetPath + "\n" +
            "output_path=" + path + "\n" +
            "midi2_output_path=" + midi2Path + "\n" +
            "pitch_bend_output_path=" + pitchBendPath + "\n" +
            "pitch_bend_range_semitones=" + pluginId.pitchBendRangeSemitones + "\n" +
            "completion_path=" + completionPath + "\n" +
            "ticks_per_quarter=" + ticksPerQuarter + "\n" +
            "debug_path=" + debugPath + "\n")) {
          return {
            success: false,
            message: "Could not write MIDX helper job file: " + jobPath
          };
        }
        output += summarizeFile(jobPath, "jobFile");

        for (var i = 0; i < commands.length; i++) {
          if (!removeFile(completionPath)) {
            output += "\nCould not clear writer completion file before attempt.\n";
            break;
          }
          output += "\n--- attempt " + (i + 1) + " ---\n";
          var attempt = startProcessCandidate(commands[i]);
          output += attempt.output;
          output += summarizeFile(path, "targetFile");
          output += summarizeFile(midi2Path, "midi2File");
          output += summarizeFile(pitchBendPath, "pitchBendFile");
          output += summarizeFile(completionPath, "completionFile");
          writeTextFile(debugPath, output);

          var completion = fileExists(completionPath) ? readKeyValueFile(completionPath) : {};
          if (attempt.finished && (attempt.exitCode === null || attempt.exitCode == 0) &&
              completion.status == "ok" &&
              fileExists(path) && fileExists(midi2Path) && fileExists(pitchBendPath)) {
            removeFile(nativeMidiPath);
            removeFile(offsetPath);
            removeFile(jobPath);
            removeFile(completionPath);
            return {
              success: true,
              method: "MuseScore writeScore + " + commandToString(commands[i]),
              midi2Path: midi2Path,
              pitchBendPath: pitchBendPath,
              channelSteals: Number(completion.pitch_bend_channel_steals || 0),
              clippedBends: Number(completion.pitch_bend_clipped_bends || 0),
              percussionOffsetsIgnored: Number(completion.pitch_bend_percussion_offsets_ignored || 0),
              message: output
            };
          }
        }

        writeTextFile(debugPath, output);
        removeFile(completionPath);
        return {
          success: false,
          message: "Native MIDI injection failed. Detailed log:\n" + debugPath +
            "\nPrevious completed exports were left unchanged. Temporary files were left for debugging:\n" +
            nativeMidiPath + "\n" + offsetPath + "\n" + jobPath
        };
      }

      function writeMidxFile(path, ticksPerQuarter, tempoEvents, noteEvents) {
        var nativeResult = writeMidxFromNativeMidi(path, noteEvents);
        if (nativeResult.success) {
          return nativeResult;
        }

        return {
          success: false,
          message: nativeResult.message +
            "\n\nExport was stopped because MIDX must preserve MuseScore's full native MIDI data."
        };
      }

      function getScoreDirectory(scorePath) {
        scorePath = "" + scorePath;
        var slash = scorePath.lastIndexOf("/");
        var backslash = scorePath.lastIndexOf("\\");
        var idx = Math.max(slash, backslash);
        if (idx < 0) {
          return ".";
        }
        return scorePath.slice(0, idx);
      }

      function getExportPath() {
        var scorePath = curScore.path || "";
        var dir = getScoreDirectory(scorePath);
        var scoreName = curScore.scoreName || "untitled";
        return dir + "/" + scoreName + ".midx";
      }

      function getMidi2ExportPath(midxPath) {
        midxPath = "" + midxPath;
        if (strEndsWith(midxPath.toLowerCase(), ".midx")) {
          return midxPath.slice(0, midxPath.length - 5) + ".midi2";
        }
        return midxPath + ".midi2";
      }

      function getPitchBendMidiExportPath(midxPath) {
        midxPath = "" + midxPath;
        if (strEndsWith(midxPath.toLowerCase(), ".midx")) {
          return midxPath.slice(0, midxPath.length - 5) + ".pitch-bend.mid";
        }
        return midxPath + ".pitch-bend.mid";
      }

      function getNoteTick(note) {
        if (note && note.parent && note.parent.parent && note.parent.parent.tick !== undefined) {
          return note.parent.parent.tick;
        }
        if (note && note.parent && note.parent.parent && note.parent.parent.parent &&
            note.parent.parent.parent.tick !== undefined) {
          return note.parent.parent.parent.tick;
        }
        return 0;
      }

      function isSameNote(a, b) {
        if (!a || !b) {
          return false;
        }
        if (a === b) {
          return true;
        }
        try {
          if (typeof a.is == "function" && a.is(b)) {
            return true;
          }
        } catch (e) {
        }
        try {
          if (typeof b.is == "function" && b.is(a)) {
            return true;
          }
        } catch (e2) {
        }
        return false;
      }

      function getFirstTiedNote(note) {
        if (!note) {
          return null;
        }
        if (note.firstTiedNote) {
          return note.firstTiedNote;
        }
        if (note.tieBack && note.tieBack.startNote) {
          return getFirstTiedNote(note.tieBack.startNote);
        }
        return note;
      }

      function getLastTiedNote(note) {
        if (!note) {
          return null;
        }
        if (note.lastTiedNote) {
          return note.lastTiedNote;
        }
        var current = note;
        var guard = 0;
        while (current && current.tieForward && current.tieForward.endNote && guard < 512) {
          if (isSameNote(current, current.tieForward.endNote)) {
            break;
          }
          current = current.tieForward.endNote;
          guard++;
        }
        return current || note;
      }

      function isTieContinuationWithinRange(note, rangeStartTick) {
        if (!note) {
          return false;
        }

        var first = getFirstTiedNote(note);
        if (first && !isSameNote(first, note)) {
          return getNoteTick(first) >= rangeStartTick;
        }

        return note.tieBack ? true : false;
      }

      function getChordDurationTicks(chord) {
        if (chord && chord.actualDuration && chord.actualDuration.ticks !== undefined) {
          return Number(chord.actualDuration.ticks);
        }
        return 0;
      }

      function getNoteEndTick(note, fallbackChord) {
        var chord = (note && note.parent) ? note.parent : fallbackChord;
        var duration = getChordDurationTicks(chord);
        if (duration <= 0) {
          duration = getChordDurationTicks(fallbackChord);
        }
        return Math.round(getNoteTick(note) + Math.max(0, duration));
      }

      function getTiedDurationTicks(note, fallbackChord, baseDuration) {
        var startTick = getNoteTick(note);
        var last = getLastTiedNote(note);
        var endTick = getNoteEndTick(last || note, fallbackChord);
        if (endTick <= startTick) {
          endTick = startTick + Math.max(0, baseDuration);
        }
        return Math.max(0, endTick - startTick);
      }

      function getNoteVelocity(note, partVelocity) {
        var velocity = Number(partVelocity);
        if (!isFinite(velocity)) {
          velocity = 80;
        }

        if (note && note.veloType !== undefined && note.veloOffset !== undefined) {
          if (note.veloType == 0) {
            velocity += Number(note.veloOffset);
          } else {
            velocity = Number(note.veloOffset);
          }
        }

        return Math.round(clampNumber(velocity, 0, 127));
      }

      function getNoteStaff(note, fallbackStaff) {
        if (note && note.track !== undefined) {
          return Math.floor(Number(note.track) / 4);
        }
        return fallbackStaff;
      }

      function getPlayEventValue(playEvent, key, fallback) {
        if (playEvent && playEvent[key] !== undefined) {
          var value = Number(playEvent[key]);
          if (isFinite(value)) {
            return value;
          }
        }
        return fallback;
      }

      function appendNotePlayEvent(noteEvents, note, playEvent, fallbackStaff, fallbackChord, partVelocity) {
        var chord = note.parent || fallbackChord;
        var baseDuration = getChordDurationTicks(chord);
        if (baseDuration <= 0) {
          baseDuration = getChordDurationTicks(fallbackChord);
        }

        var tick = getNoteTick(note);
        var ontime = getPlayEventValue(playEvent, "ontime", 0);
        var len = getPlayEventValue(playEvent, "len", 1000);
        var tiedDuration = getTiedDurationTicks(note, fallbackChord, baseDuration);
        var tiedExtraTicks = Math.max(0, tiedDuration - baseDuration);
        var startTick = Math.round(tick + ontime / 1000 * baseDuration);
        var durationTicks = Math.max(0, Math.round(len / 1000 * baseDuration + tiedExtraTicks));
        var normalizedPitch = normalizeMidxPitchCents(
          Number(note.pitch) + getPlayEventValue(playEvent, "pitch", 0),
          note.tuning
        );
        var pitch = normalizedPitch.pitch;
        var cents = normalizedPitch.cents;
        var velocity = getNoteVelocity(note, partVelocity);
        var staff = getNoteStaff(note, fallbackStaff);

        noteEvents.push({
          staff: staff,
          tick: startTick,
          pitch: pitch,
          cents: cents,
          velocity: velocity
        });

        noteEvents.push({
          staff: staff,
          tick: startTick + durationTicks,
          pitch: pitch,
          cents: cents,
          velocity: 0
        });
      }

      function appendNoteEvents(noteEvents, note, fallbackStaff, fallbackChord, partVelocity, rangeStartTick) {
        if (!note) {
          return;
        }
        if (isTieContinuationWithinRange(note, rangeStartTick)) {
          return;
        }

        if (note.playEvents && note.playEvents.length > 0) {
          for (var i = 0; i < note.playEvents.length; i++) {
            appendNotePlayEvent(noteEvents, note, note.playEvents[i], fallbackStaff, fallbackChord, partVelocity);
          }
        } else {
          appendNotePlayEvent(noteEvents, note, { pitch: 0, ontime: 0, len: 1000 },
            fallbackStaff, fallbackChord, partVelocity);
        }
      }

      function getExportRange(cursor) {
        cursor.rewind(1);

        if (!cursor.segment) {
          return {
            fullScore: true,
            startStaff: 0,
            startTick: 0,
            endStaff: curScore.nstaves - 1,
            endTick: curScore.lastSegment ? curScore.lastSegment.tick + 1 : 0
          };
        }

        var startStaff = cursor.staffIdx;
        var startTick = cursor.tick;
        var endStaff = startStaff;
        var endTick = 0;
        cursor.rewind(2);
        if (cursor.tick == 0) {
          endTick = curScore.lastSegment ? curScore.lastSegment.tick + 1 : 0;
        } else {
          endTick = cursor.tick;
        }
        endStaff = cursor.staffIdx;

        return {
          fullScore: false,
          startStaff: startStaff,
          startTick: startTick,
          endStaff: endStaff,
          endTick: endTick
        };
      }

      function collectMidxEvents(noteEvents, tempoEvents, range) {
        var cursor = curScore.newCursor();

        for (var staff = range.startStaff; staff <= range.endStaff; staff++) {
          for (var voice = 0; voice < 4; voice++) {
            cursor.rewind(1);
            cursor.voice = voice;
            cursor.staffIdx = staff;
            cursor.rewind(0);

            var velocity = 80;

            while (cursor.segment && (range.fullScore || cursor.tick < range.endTick)) {
              for (var i = 0; i < cursor.segment.annotations.length; i++) {
                var annotation = cursor.segment.annotations[i];
                if (annotation.name == "Dynamic") {
                  velocity = annotation.velocity;
                }
                if (annotation.name == "Tempo" && staff == range.startStaff && voice == 0) {
                  tempoEvents.push({
                    tick: cursor.tick,
                    bpm: annotation.tempo * 60
                  });
                }
              }

              if (cursor.element && cursor.element.name == "Chord") {
                var chord = cursor.element;
                var graceChords = chord.graceNotes || [];
                for (var g = 0; g < graceChords.length; g++) {
                  var graceNotes = graceChords[g].notes || [];
                  for (var gn = 0; gn < graceNotes.length; gn++) {
                    appendNoteEvents(noteEvents, graceNotes[gn], staff, chord, velocity, range.startTick);
                  }
                }

                var notes = chord.notes || [];
                for (var n = 0; n < notes.length; n++) {
                  appendNoteEvents(noteEvents, notes[n], staff, chord, velocity, range.startTick);
                }
              }

              cursor.next();
            }
          }
        }
      }

      onRun: {
        console.log("Export MIDX");

        if (!ensureWritablePaths()) {
          messageDialog.title = "Microtonal MIDI Export Failed";
          messageDialog.text = "Xen Tuner cache directory is unavailable: " + writableRoot;
          messageDialog.open();
          return;
        }

        if (typeof curScore === "undefined" || !curScore) {
          Qt.quit();
          return;
        }

        try {
          curScore.createPlayEvents();

          var noteEvents = [];
          var tempoEvents = [];
          var cursor = curScore.newCursor();
          var range = getExportRange(cursor);

          collectMidxEvents(noteEvents, tempoEvents, range);

          var ticksPerQuarter = (typeof division === "undefined") ? 480 : division;
          var exportPath = getExportPath();
          var result = writeMidxFile(exportPath, ticksPerQuarter, tempoEvents, noteEvents);

          if (result.success) {
          var warning = "";
          if (result.channelSteals > 0) {
            warning += "\nWarning: " + result.channelSteals +
              " active note(s) were ended early because MIDI 1.0 provides only 15 melodic pitch-bend channels.";
          }
          if (result.clippedBends > 0) {
            warning += "\nWarning: " + result.clippedBends +
              " pitch bend(s) exceeded the configured range and were clipped.";
          }
          if (result.percussionOffsetsIgnored > 0) {
            warning += "\nWarning: " + result.percussionOffsetsIgnored +
              " microtonal offset(s) on GM percussion notes were ignored.";
          }
          messageDialog.title = warning == "" ?
            "Microtonal MIDI Export Success" : "Microtonal MIDI Export Completed With Warnings";
          messageDialog.text = "MIDX: " + exportPath +
            "\nMIDI 2.0 clip: " + (result.midi2Path || getMidi2ExportPath(exportPath)) +
            "\nPitch-bend MIDI: " + (result.pitchBendPath || getPitchBendMidiExportPath(exportPath)) +
            ".\nNote events: " + noteEvents.length +
            ", offsets: " + countOffsetEvents(noteEvents) +
            ".\nWriter: " + result.method + "." + warning;
          } else {
            console.error("Microtonal MIDI export failed: " + result.message);
            messageDialog.title = "Microtonal MIDI Export Failed";
            messageDialog.text = "failed to export to " + exportPath + ".\n" + result.message;
          }
        } catch (e) {
          console.error("Microtonal MIDI export failed: " + e);
          messageDialog.title = "Microtonal MIDI Export Failed";
          messageDialog.text = "Unexpected export error: " + e;
        }

        messageDialog.open();
      }
}
