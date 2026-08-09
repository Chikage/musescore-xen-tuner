// Copyright (C) 2023 euwbah
// This file is part of Xen Tuner. See ../fns.js for license.
// Module: MuseScore lifecycle hooks, tuning cache, logging, and playback mode.
/**
 * Cached mapping of tuning config strings to `TuningConfig` objects that the string
 * refers to.
 * 
 * This object is dynamically created and populated as tuning configs are loaded.
 * 
 * If the `'tuningconfig'` metaTag exists in the score, populate from there as well.
 * 
 * The `'tuningconfig'` metaTag can be set by the Save Tuning Cache plugin.
 * 
 * @type {TuningConfigLookup}
 */
var tuningConfigCache = {};
var lastLoggedSelectionTuningSignature = "";

/**
 * Returns the default tuning config to apply when none is specified
 * 
 * @returns {TuningConfig}
 */
function generateDefaultTuningConfig() {
    if (tuningConfigCache['!default!'] != null) {
        return tuningConfigCache['!default!'];
    }

    var defaultPath = tuningConfigFilePath("default", ".txt");
    fileIO.source = defaultPath;
    var defaultTxt = fileIO.read();
    /** @type {TuningConfig} */
    var tuningConfig;
    if (defaultTxt.length == 0) {
        log("default.txt not found, generating default tuning config...");
        tuningConfig = parseTuningConfig(DEFAULT_TUNING_CONFIG, true, true);
        setTuningConfigSourceInfo(tuningConfig, "built-in default tuning", "");
    } else {
        log('Generated default tuning config from default.txt');
        tuningConfig = parseTuningConfig(defaultTxt, true, true);
        if (tuningConfig == null) {
            console.error("ERROR: default.txt is invalid. Please fix your tuning config. Generating default tuning config...");
            tuningConfig = parseTuningConfig(DEFAULT_TUNING_CONFIG, true, true);
            setTuningConfigSourceInfo(tuningConfig, "built-in default tuning", "");
        } else {
            setTuningConfigSourceInfo(tuningConfig, tuningConfigSourceName("default", ".txt"), defaultPath);
        }
    }

    // log('Default tuning config freq: ' + tuningConfig.tuningFreq + ', midi: ' + tuningConfig.tuningNote +
    //     ', nominal: ' + tuningConfig.tuningNominal);

    tuningConfigCache['!default!'] = tuningConfig;
    return tuningConfig;
}

function setTuningConfigSourceInfo(tuningConfig, sourceName, sourcePath) {
    if (!tuningConfig)
        return;

    tuningConfig.sourceName = sourceName || tuningConfig.sourceName || "";
    tuningConfig.sourcePath = sourcePath || tuningConfig.sourcePath || "";
}

function hasTuningConfigLogInfo(tuningConfig) {
    if (!tuningConfig)
        return false;

    if (!tuningConfig.sourceName && !tuningConfig.referenceLogText)
        return false;

    return !(tuningConfig.auxList && tuningConfig.auxList.length > 1 && !tuningConfig.auxLogTexts);
}

function populateTuningConfigLogInfo(tuningConfig, rawText, sourceName, sourcePath) {
    if (!tuningConfig)
        return;

    setTuningConfigSourceInfo(tuningConfig, sourceName, sourcePath);

    if (rawText) {
        rawText = normalizeConfigLineEndings(rawText);
        var cleanText = rawText.replace(/^(.*?)\/\/.*$/gm, '$1')
            .replace(/^(?:[\t ]*(?:\r?\n|\r))+/gm, '')
            .trim();
        var lines = cleanText.split('\n').map(function (x) { return x.trim() });

        if (lines.length > 0 && !tuningConfig.referenceLogText) {
            tuningConfig.referenceLogText = lines[0];
        }
        if (lines.length > 1 && !tuningConfig.nominalsLogText) {
            tuningConfig.nominalsLogText = lines[1];
        }
        if (!tuningConfig.accChainLogTexts) {
            tuningConfig.accChainLogTexts = [];
        }
        var accChainCount = tuningConfig.accChains ? tuningConfig.accChains.length : 0;
        for (var i = 2; i < lines.length && tuningConfig.accChainLogTexts.length < accChainCount; i++) {
            if (lines[i].match(/(lig|aux|sec|explicit|nobold|override|displaycents|displaysteps)\([0-9,a-zA-Z\s]*\)/))
                break;

            tuningConfig.accChainLogTexts.push(lines[i]);
        }
    }

    if (!tuningConfig.auxLogTexts && tuningConfig.auxList) {
        var rawAuxDeclarations = collectAuxSourceLines(rawText || "");
        tuningConfig.auxLogTexts = [null];

        for (var aux = 1; aux < tuningConfig.auxList.length; aux++) {
            var changed = getChangedAuxIndicesFromConstrictions(tuningConfig.auxList[aux], tuningConfig);
            tuningConfig.auxLogTexts.push(formatAuxLogText(rawAuxDeclarations[aux - 1] || "", changed, tuningConfig));
        }
    }
}

function ensureTuningConfigLogInfo(tuningConfig, textOrPath, isNotPath) {
    if (hasTuningConfigLogInfo(tuningConfig))
        return;

    var rawText = "";
    var sourceName = tuningConfig.sourceName || "";
    var sourcePath = tuningConfig.sourcePath || "";

    if (isNotPath) {
        rawText = textOrPath;
        sourceName = sourceName || "direct tuning text";
    } else if (fileIO && textOrPath) {
        var filePath = textOrPath;
        if (strEndsWith(textOrPath, '.txt')) {
            filePath = textOrPath.slice(0, textOrPath.length - 4);
        } else if (strEndsWith(textOrPath, '.json')) {
            filePath = textOrPath.slice(0, textOrPath.length - 5);
        }

        fileIO.source = tuningConfigFilePath(filePath, '.txt');
        rawText = fileIO.read().trim();
        if (rawText.length > 0) {
            sourceName = tuningConfigSourceName(filePath, '.txt');
            sourcePath = fileIO.source;
        } else {
            sourceName = sourceName || textOrPath;
        }
    }

    populateTuningConfigLogInfo(tuningConfig, rawText, sourceName, sourcePath);
}

function collectAuxSourceLines(rawText) {
    var auxLines = [];

    if (!rawText)
        return auxLines;

    var rawLines = normalizeConfigLineEndings(rawText).split('\n');
    for (var i = 0; i < rawLines.length; i++) {
        var line = rawLines[i].trim();
        if (line.match(/^aux\([0-9,\s]+\)/)) {
            auxLines.push(line);
        }
    }

    return auxLines;
}

function listContainsNumber(list, value) {
    if (!list)
        return false;

    for (var i = 0; i < list.length; i++) {
        if (list[i] == value)
            return true;
    }

    return false;
}

function describeAuxChange(nomAndChainIndices, tuningConfig) {
    var parts = [];

    if (listContainsNumber(nomAndChainIndices, 0)) {
        parts.push("changes nominals");
    }

    if (tuningConfig && tuningConfig.accChains) {
        for (var i = 0; i < tuningConfig.accChains.length; i++) {
            if (listContainsNumber(nomAndChainIndices, i + 1)) {
                parts.push("changes acc chain " + (i + 1));
            }
        }
    }

    if (parts.length == 0)
        return "keeps configured nominals and accidental chains fixed";

    return parts.join("; ");
}

function formatAuxLogText(sourceLine, nomAndChainIndices, tuningConfig) {
    var note = "";

    if (sourceLine) {
        var match = sourceLine.trim().match(/^(aux\([0-9,\s]+\))\s*(.*)$/);
        if (match) {
            note = match[2].trim();
            if (strStartsWith(note, "//")) {
                note = note.slice(2).trim();
            }
            if (note.charAt(0) == ":") {
                note = note.slice(1).trim();
            }
        } else {
            note = sourceLine.trim();
        }
    }

    if (note.length == 0) {
        note = describeAuxChange(nomAndChainIndices, tuningConfig);
    }

    return normalizeAuxLogText(note);
}

function normalizeAuxLogText(auxText) {
    if (!auxText)
        return "";

    return auxText.replace(/^aux\([0-9,\s]+\):\s*/, "");
}

function getChangedAuxIndicesFromConstrictions(constantConstrictions, tuningConfig) {
    var changed = [];

    if (!constantConstrictions || !tuningConfig)
        return changed;

    if (constantConstrictions.indexOf(0) == -1) {
        changed.push(0);
    }

    if (tuningConfig.accChains) {
        for (var i = 0; i < tuningConfig.accChains.length; i++) {
            if (constantConstrictions.indexOf(i + 1) == -1) {
                changed.push(i + 1);
            }
        }
    }

    return changed;
}

function getTuningPositionForLog(useScoreStartFallback) {
    var position = {
        staffIdx: 0,
        tick: 0
    };

    if (!_curScore)
        return position;

    try {
        var cursor = _curScore.newCursor();
        cursor.rewind(1);
        if (cursor.segment) {
            position.staffIdx = cursor.staffIdx || 0;
            position.tick = cursor.tick || 0;
            return position;
        }
    } catch (e) { }

    try {
        if (_curScore.selection && _curScore.selection.elements) {
            var elems = _curScore.selection.elements;
            for (var i = 0; i < elems.length; i++) {
                if (Element && elems[i].type == Element.NOTE) {
                    position.staffIdx = Math.floor(elems[i].track / 4);
                    position.tick = getTick(elems[i]) || 0;
                    return position;
                }
            }
        }
    } catch (e) { }

    if (useScoreStartFallback)
        return position;

    return position;
}

function getTuningConfigAtPositionForLog(staffIdx, tick) {
    /** @type {Parms} */
    var parms = {};
    resetParms(parms);

    if (!_curScore)
        return parms.currTuning;

    if (isNaN(staffIdx) || staffIdx < 0)
        staffIdx = 0;
    if (isNaN(tick) || tick < 0)
        tick = 0;

    try {
        var cursor = _curScore.newCursor();
        var configs = [];
        var seen = {};
        var staffCount = _curScore.nstaves || 1;

        for (var staff = 0; staff < staffCount; staff++) {
            for (var voice = 0; voice < 4; voice++) {
                cursor.rewind(1);
                cursor.staffIdx = staff;
                cursor.voice = voice;
                cursor.rewind(0);

                while (cursor.segment && cursor.tick <= tick) {
                    for (var i = 0; i < cursor.segment.annotations.length; i++) {
                        var annotation = cursor.segment.annotations[i];
                        var annotationStaff = Math.floor(annotation.track / 4);
                        if ((annotation.name == 'StaffText' && annotationStaff == staffIdx) ||
                            annotation.name == 'SystemText') {
                            var key = cursor.tick + "|" + annotation.name + "|" + annotation.track + "|" + annotation.text;
                            if (seen[key])
                                continue;

                            seen[key] = true;
                            var maybeConfigUpdateEvent = parsePossibleConfigs(annotation.text, cursor.tick);
                            if (maybeConfigUpdateEvent != null) {
                                configs.push(maybeConfigUpdateEvent);
                            }
                        }
                    }

                    if (!cursor.next())
                        break;
                }
            }
        }

        configs.sort(sortConfigUpdateEvents);
        applyConfigsUpTo(configs, parms, tick, 0);
    } catch (e) { }

    return parms.currTuning;
}

function getCurrentTuningConfigForLog(useScoreStartFallback) {
    var position = getTuningPositionForLog(useScoreStartFallback);
    return getTuningConfigAtPositionForLog(position.staffIdx, position.tick);
}

function getAuxLogText(aux) {
    aux = parseInt(aux, 10);
    if (isNaN(aux) || aux <= 0)
        return "";

    var tuningConfig = getCurrentTuningConfigForLog(false);
    if (!tuningConfig)
        return "";

    if (tuningConfig.auxLogTexts && tuningConfig.auxLogTexts[aux]) {
        return normalizeAuxLogText(tuningConfig.auxLogTexts[aux]);
    }

    if (tuningConfig.auxList && tuningConfig.auxList[aux]) {
        var changed = getChangedAuxIndicesFromConstrictions(tuningConfig.auxList[aux], tuningConfig);
        return formatAuxLogText("", changed, tuningConfig);
    }

    return "aux " + aux + " is not defined in current tuning";
}

function getAuxLogSuffix(aux) {
    var auxText = getAuxLogText(aux);
    if (auxText.length == 0)
        return "";

    return " (" + auxText + ")";
}

function getStartupTuningLogText() {
    return getTuningPanelText(false);
}

function padLogNumber(value) {
    return value < 10 ? "0" + value : "" + value;
}

function formatLogDate(date) {
    return date.getFullYear() + "-" +
        padLogNumber(date.getMonth() + 1) + "-" +
        padLogNumber(date.getDate());
}

function formatLogTimestamp(date) {
    return formatLogDate(date) + " " +
        padLogNumber(date.getHours()) + ":" +
        padLogNumber(date.getMinutes()) + ":" +
        padLogNumber(date.getSeconds());
}

function getDailyLogRelativePath(date) {
    date = date || new Date();
    return "logs/" + formatLogDate(date) + ".log";
}

function normalizeLogValue(value) {
    if (value === undefined || value === null)
        return "";

    return ("" + value).replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
}

function getPathRelativeToPluginHome(path) {
    path = normalizeLogValue(path).replace(/\\/g, "/");
    if (path.length == 0)
        return "";

    var home = normalizePluginHomePath(pluginHomePath);
    if (home.length > 0 && strStartsWith(path, home)) {
        return path.slice(home.length);
    }

    return path;
}

function getScoreNameForLog() {
    if (!_curScore)
        return "Untitled score";

    var fields = ["scoreName", "name", "title"];
    for (var i = 0; i < fields.length; i++) {
        try {
            var value = _curScore[fields[i]];
            if (typeof value === "function")
                value = value.call(_curScore);
            value = normalizeLogValue(value);
            if (value.length > 0)
                return value;
        } catch (e) { }
    }

    var tags = ["workTitle", "movementTitle", "title"];
    for (var j = 0; j < tags.length; j++) {
        try {
            var tagValue = normalizeLogValue(_curScore.metaTag(tags[j]));
            if (tagValue.length > 0)
                return tagValue;
        } catch (e2) { }
    }

    return "Untitled score";
}

function getTuningSourceForLog() {
    var tuningConfig = getCurrentTuningConfigForLog(true);
    if (!tuningConfig)
        return "unknown tuning";

    return getTuningConfigSourceForLog(tuningConfig);
}

function getTuningConfigSourceForLog(tuningConfig) {
    if (!tuningConfig)
        return "current tuning";

    var sourcePath = getPathRelativeToPluginHome(tuningConfig.sourcePath);
    if (sourcePath.length > 0)
        return sourcePath;

    var sourceName = getPathRelativeToPluginHome(tuningConfig.sourceName);
    return sourceName.length > 0 ? sourceName : "current tuning";
}

function getScoreLastTickForLog() {
    if (!_curScore)
        return 1;

    try {
        if (_curScore.lastSegment && typeof _curScore.lastSegment.tick === 'number')
            return _curScore.lastSegment.tick + 1;
    } catch (e) { }

    return 1;
}

function getElementTickForLog(elem) {
    if (!elem)
        return null;

    try {
        if (Element && elem.type == Element.NOTE)
            return getTick(elem);
    } catch (e) { }

    var chain = elem;
    for (var depth = 0; depth < 4 && chain; depth++) {
        try {
            if (typeof chain.tick === "number" && !isNaN(chain.tick))
                return chain.tick;
        } catch (e2) { }

        try {
            chain = chain.parent;
        } catch (e3) {
            chain = null;
        }
    }

    return null;
}

function getElementStaffIdxForLog(elem) {
    if (!elem)
        return null;

    try {
        if (typeof elem.track === "number" && !isNaN(elem.track))
            return Math.floor(elem.track / 4);
    } catch (e) { }

    try {
        if (elem.parent && typeof elem.parent.track === "number" && !isNaN(elem.parent.track))
            return Math.floor(elem.parent.track / 4);
    } catch (e2) { }

    return null;
}

function getSelectionRangeForLog() {
    if (!_curScore)
        return null;

    try {
        var cursor = _curScore.newCursor();
        cursor.rewind(1);
        if (cursor.segment) {
            var startTick = cursor.tick || 0;
            var startStaff = cursor.staffIdx || 0;
            cursor.rewind(2);
            var endTick = cursor.tick == 0 ? getScoreLastTickForLog() : cursor.tick;
            var endStaff = cursor.staffIdx || startStaff;

            if (endTick < startTick) {
                var tmpTick = startTick;
                startTick = endTick;
                endTick = tmpTick;
            }
            if (endStaff < startStaff) {
                var tmpStaff = startStaff;
                startStaff = endStaff;
                endStaff = tmpStaff;
            }

            return {
                kind: "selection",
                startTick: startTick,
                endTick: Math.max(startTick + 1, endTick),
                startStaff: startStaff,
                endStaff: endStaff
            };
        }
    } catch (e) { }

    try {
        if (!_curScore.selection || !_curScore.selection.elements)
            return null;

        var elems = _curScore.selection.elements;
        if (!elems || elems.length == 0)
            return null;

        var minTick = null;
        var maxTick = null;
        var minStaff = null;
        var maxStaff = null;

        for (var i = 0; i < elems.length; i++) {
            var elemTick = getElementTickForLog(elems[i]);
            if (elemTick === null)
                continue;

            elemTick = Math.max(0, Math.floor(elemTick));
            minTick = minTick === null ? elemTick : Math.min(minTick, elemTick);
            maxTick = maxTick === null ? elemTick : Math.max(maxTick, elemTick);

            var elemStaff = getElementStaffIdxForLog(elems[i]);
            if (elemStaff !== null) {
                minStaff = minStaff === null ? elemStaff : Math.min(minStaff, elemStaff);
                maxStaff = maxStaff === null ? elemStaff : Math.max(maxStaff, elemStaff);
            }
        }

        if (minTick !== null) {
            if (minStaff === null) {
                minStaff = 0;
                maxStaff = Math.max(0, (_curScore.nstaves || 1) - 1);
            }
            return {
                kind: "selection",
                startTick: minTick,
                endTick: maxTick + 1,
                startStaff: minStaff,
                endStaff: maxStaff
            };
        }
    } catch (e2) { }

    return null;
}

function getSelectionStartRangeForLog() {
    var range = getSelectionRangeForLog();
    if (!range)
        return null;

    return {
        kind: "selection",
        startTick: range.startTick,
        endTick: range.startTick + 1,
        startStaff: range.startStaff,
        endStaff: range.endStaff
    };
}

function getFullScoreRangeForLog() {
    return {
        kind: "score",
        startTick: 0,
        endTick: getScoreLastTickForLog(),
        startStaff: 0,
        endStaff: Math.max(0, (_curScore && _curScore.nstaves ? _curScore.nstaves : 1) - 1)
    };
}

function normalizeTuningRangeForLog(range) {
    var fullRange = getFullScoreRangeForLog();
    if (!range)
        range = fullRange;

    var staffCount = _curScore && _curScore.nstaves ? _curScore.nstaves : 1;
    var startTick = Math.max(0, Math.floor(range.startTick || 0));
    var endTick = Math.floor(range.endTick || startTick + 1);
    if (endTick <= startTick)
        endTick = startTick + 1;

    var startStaff = Math.max(0, Math.floor(range.startStaff || 0));
    var endStaff = Math.floor(range.endStaff === undefined || range.endStaff === null ? startStaff : range.endStaff);
    endStaff = Math.min(staffCount - 1, Math.max(startStaff, endStaff));

    return {
        kind: range.kind || "score",
        startTick: startTick,
        endTick: endTick,
        startStaff: startStaff,
        endStaff: endStaff
    };
}

function tuningRangesOverlapForLog(startA, endA, startB, endB) {
    return startA < endB && startB < endA;
}

function addTuningSourceToReportForLog(report, tuningConfig) {
    var source = getTuningConfigSourceForLog(tuningConfig);
    if (!report.sourceSeen[source]) {
        report.sourceSeen[source] = true;
        report.sources.push(source);
    }
}

function getConfigEventTickForLog(configEvent) {
    if (!configEvent)
        return 0;

    return configEvent.eventTick === undefined || configEvent.eventTick === null ?
        configEvent.tick : configEvent.eventTick;
}

function isConfigEventInRangeForLog(configEvent, range) {
    var eventTick = Math.max(0, Math.floor(getConfigEventTickForLog(configEvent)));
    return eventTick >= range.startTick && eventTick < range.endTick;
}

function compareTuningCandidateForLog(candidate, current) {
    if (!current)
        return -1;
    if (candidate.tick != current.tick)
        return candidate.tick - current.tick;
    if (candidate.staffIdx != current.staffIdx)
        return candidate.staffIdx - current.staffIdx;
    if (candidate.priority != current.priority)
        return candidate.priority - current.priority;
    return candidate.order - current.order;
}

function makeTuningCandidateForLog(tuningConfig, tick, staffIdx, priority, order, sourceText) {
    return {
        tuningConfig: tuningConfig,
        source: getTuningConfigSourceForLog(tuningConfig),
        sourceText: sourceText || "",
        tick: Math.max(0, Math.floor(tick || 0)),
        staffIdx: staffIdx || 0,
        priority: priority || 0,
        order: order || 0
    };
}

function setFirstTuningCandidateForLog(report, fieldName, candidate) {
    if (!candidate)
        return;

    if (compareTuningCandidateForLog(candidate, report[fieldName]) < 0)
        report[fieldName] = candidate;
}

function collectTuningConfigEventsForStaffForLog(staffIdx) {
    var events = [];
    if (!_curScore)
        return events;

    try {
        var cursor = _curScore.newCursor();
        var seen = {};
        var order = 0;

        for (var voice = 0; voice < 4; voice++) {
            cursor.rewind(1);
            cursor.staffIdx = staffIdx;
            cursor.voice = voice;
            cursor.rewind(0);

            while (cursor.segment) {
                var annotations = cursor.segment.annotations || [];
                for (var i = 0; i < annotations.length; i++) {
                    var annotation = annotations[i];
                    var isStaffText = annotation.name == "StaffText" &&
                        Math.floor(annotation.track / 4) == staffIdx;
                    var isSystemText = annotation.name == "SystemText";
                    if (!isStaffText && !isSystemText)
                        continue;

                    var key = cursor.tick + "|" + annotation.name + "|" +
                        annotation.track + "|" + annotation.text;
                    if (seen[key])
                        continue;

                    seen[key] = true;
                    var maybeConfigUpdateEvent = parsePossibleConfigs(annotation.text, cursor.tick);
                    if (maybeConfigUpdateEvent != null &&
                        maybeConfigUpdateEvent.kind == "tuning" &&
                        maybeConfigUpdateEvent.tuningConfig) {
                        maybeConfigUpdateEvent.eventTick =
                            maybeConfigUpdateEvent.eventTick === undefined ||
                                maybeConfigUpdateEvent.eventTick === null ?
                                cursor.tick : maybeConfigUpdateEvent.eventTick;
                        maybeConfigUpdateEvent.scope = annotation.name;
                        maybeConfigUpdateEvent.order = order++;
                        maybeConfigUpdateEvent.priority = isSystemText ? 0 : 1;
                        events.push(maybeConfigUpdateEvent);
                    }
                }

                if (!cursor.next())
                    break;
            }
        }

        events.sort(function (a, b) {
            var aTick = a.eventTick === undefined || a.eventTick === null ? a.tick : a.eventTick;
            var bTick = b.eventTick === undefined || b.eventTick === null ? b.tick : b.eventTick;
            if (aTick != bTick)
                return aTick - bTick;
            if (a.priority != b.priority)
                return a.priority - b.priority;
            return a.order - b.order;
        });
    } catch (e) {
        console.error("Failed to collect tuning config events: " + e);
    }

    return events;
}

function buildTuningUsageReportForRange(range) {
    range = normalizeTuningRangeForLog(range);
    var report = {
        range: range,
        sources: [],
        sourceSeen: {},
        firstExplicitTuning: null,
        firstActiveTuning: null,
        firstTuning: null
    };

    var scoreEndTick = getScoreLastTickForLog();

    for (var staff = range.startStaff; staff <= range.endStaff; staff++) {
        var events = collectTuningConfigEventsForStaffForLog(staff);
        var activeTuning = generateDefaultTuningConfig();
        var activeSourceText = "";
        var activeStartTick = 0;

        for (var i = 0; i < events.length; i++) {
            var eventTick = getConfigEventTickForLog(events[i]);
            eventTick = Math.max(0, Math.floor(eventTick));

            if (isConfigEventInRangeForLog(events[i], range)) {
                setFirstTuningCandidateForLog(report, "firstExplicitTuning",
                    makeTuningCandidateForLog(events[i].tuningConfig, eventTick, staff,
                        events[i].priority, events[i].order, events[i].text));
            }

            if (tuningRangesOverlapForLog(activeStartTick, eventTick, range.startTick, range.endTick)) {
                addTuningSourceToReportForLog(report, activeTuning);
                setFirstTuningCandidateForLog(report, "firstActiveTuning",
                    makeTuningCandidateForLog(activeTuning, Math.max(activeStartTick, range.startTick),
                        staff, 0, 0, activeSourceText));
            }

            activeTuning = events[i].tuningConfig;
            activeSourceText = events[i].text || "";
            activeStartTick = eventTick;
        }

        if (tuningRangesOverlapForLog(activeStartTick, scoreEndTick + 1, range.startTick, range.endTick)) {
            addTuningSourceToReportForLog(report, activeTuning);
            setFirstTuningCandidateForLog(report, "firstActiveTuning",
                makeTuningCandidateForLog(activeTuning, Math.max(activeStartTick, range.startTick),
                    staff, 0, 0, activeSourceText));
        }
    }

    report.firstTuning = report.firstExplicitTuning || report.firstActiveTuning;
    return report;
}

function getCurrentTuningUsageReport() {
    var selectionStartRange = getSelectionStartRangeForLog();
    if (selectionStartRange)
        return buildTuningUsageReportForRange(selectionStartRange);

    return buildTuningUsageReportForRange(getFullScoreRangeForLog());
}

function describeTuningRangeForLog(range) {
    var staffText = "staves " + (range.startStaff + 1);
    if (range.endStaff != range.startStaff)
        staffText += "-" + (range.endStaff + 1);

    return staffText + ", ticks " + range.startTick + "-" + Math.max(range.startTick, range.endTick - 1);
}

function getTuningScopeTitleForLog(range) {
    if (range.kind == "selection")
        return "Current selection start (" + describeTuningRangeForLog(range) + ")";
    return "Entire score";
}

function appendTuningSourcesForPanel(lines, sources) {
    if (!sources || sources.length == 0) {
        lines.push("- unknown tuning");
        return;
    }

    var maxSources = 6;
    for (var i = 0; i < sources.length && i < maxSources; i++) {
        lines.push("- " + compactPanelLine(sources[i], 120));
    }
    if (sources.length > maxSources)
        lines.push("- ... " + (sources.length - maxSources) + " more");
}

function compactPanelLine(text, maxLength) {
    var value = normalizeLogValue(text);
    if (maxLength > 0 && value.length > maxLength)
        return value.slice(0, Math.max(0, maxLength - 3)) + "...";
    return value;
}

function formatPanelNumber(value, maxDecimals) {
    var number = parseFloat(value);
    if (isNaN(number))
        return "?";

    var text = number.toFixed(maxDecimals);
    while (text.indexOf(".") != -1 && text.charAt(text.length - 1) == "0")
        text = text.slice(0, text.length - 1);
    if (text.charAt(text.length - 1) == ".")
        text = text.slice(0, text.length - 1);
    return text;
}

function formatPanelCents(value) {
    return formatPanelNumber(value, 3) + "c";
}

function formatPanelSource(candidate) {
    if (!candidate)
        return "unknown tuning";

    var tuningConfig = candidate.tuningConfig;
    var source = compactPanelLine(candidate.source, 120);
    if (source.length > 0)
        return source;

    if (tuningConfig) {
        source = compactPanelLine(tuningConfig.sourceName, 120);
        if (source.length > 0)
            return source;

        source = compactPanelLine(getPathRelativeToPluginHome(tuningConfig.sourcePath), 120);
        if (source.length > 0)
            return source;
    }

    return "unknown tuning";
}

function formatPanelAccChainSummary(tuningConfig, chainIndex) {
    if (tuningConfig.accChainLogTexts && tuningConfig.accChainLogTexts[chainIndex])
        return compactPanelLine(tuningConfig.accChainLogTexts[chainIndex], 96);

    var chain = tuningConfig.accChains && tuningConfig.accChains[chainIndex];
    if (!chain)
        return "not available";

    var degreeCount = chain.degreesSymbols ? chain.degreesSymbols.length : 0;
    var center = chain.centralIdx === undefined || chain.centralIdx === null ? "?" : chain.centralIdx;
    return degreeCount + " degrees, center " + center;
}

function appendStructuredCurrentTuningForPanel(lines, currentReport) {
    var candidate = currentReport.firstTuning;
    if (!candidate) {
        lines.push("Current tuning:");
        lines.push("- File: unknown tuning");
        return;
    }

    var tuningConfig = candidate.tuningConfig;
    lines.push("Current tuning:");
    lines.push("- File: " + formatPanelSource(candidate));

    if (!tuningConfig) {
        lines.push("- Parsed data: not available");
        return;
    }

    if (tuningConfig.referenceLogText)
        lines.push("- Reference: " + compactPanelLine(tuningConfig.referenceLogText, 96));

    var scaleParts = [];
    if (tuningConfig.numNominals !== undefined && tuningConfig.numNominals !== null)
        scaleParts.push(tuningConfig.numNominals + " nominals");
    if (tuningConfig.equaveSize !== undefined && tuningConfig.equaveSize !== null)
        scaleParts.push(formatPanelCents(tuningConfig.equaveSize) + " equave");
    if (tuningConfig.stepsList)
        scaleParts.push(tuningConfig.stepsList.length + " steps/equave");
    if (scaleParts.length > 0)
        lines.push("- Scale: " + scaleParts.join(", "));

    var accChainCount = tuningConfig.accChains ? tuningConfig.accChains.length : 0;
    var auxButtons = "0=nominals";
    if (accChainCount > 0)
        auxButtons += "; 1-" + accChainCount + "=acc chains";
    lines.push("- Aux buttons: " + auxButtons);
    lines.push("- Acc chains: " + accChainCount);
    for (var acc = 0; acc < accChainCount; acc++) {
        lines.push("  " + (acc + 1) + ": " + formatPanelAccChainSummary(tuningConfig, acc));
    }

    var auxCount = tuningConfig.auxList ? Math.max(0, tuningConfig.auxList.length - 1) : 0;
    if (auxCount > 0)
        lines.push("- Declared aux: " + auxCount);
}

function formatTuningPanelText(currentReport) {
    var allReport = buildTuningUsageReportForRange(getFullScoreRangeForLog());
    var lines = [];

    lines.push("Scope: " + getTuningScopeTitleForLog(currentReport.range));
    appendStructuredCurrentTuningForPanel(lines, currentReport);
    lines.push("");
    lines.push("Score tunings:");
    appendTuningSourcesForPanel(lines, allReport.sources);
    lines.push("Log: " + getDailyLogRelativePath());
    lines.push("Status: Xen Tuner is running.");

    return lines.join("\n");
}

function logSelectionTuningContext(currentReport) {
    if (!currentReport || !currentReport.range || currentReport.range.kind != "selection")
        return;

    var sources = currentReport.sources.length > 0 ?
        currentReport.sources.join(", ") : "unknown tuning";
    var signature = currentReport.range.startStaff + "|" + currentReport.range.endStaff + "|" +
        currentReport.range.startTick + "|" + currentReport.range.endTick + "|" + sources;

    if (signature == lastLoggedSelectionTuningSignature)
        return;

    lastLoggedSelectionTuningSignature = signature;
    writeDailyLogLine("Score: " + getScoreNameForLog() +
        "; Event: Selection changed" +
        "; Range: " + describeTuningRangeForLog(currentReport.range) +
        "; Tuning files: " + sources);
}

function getTuningPanelText(logSelection) {
    var currentReport = getCurrentTuningUsageReport();
    if (logSelection) {
        var selectionStartRange = getSelectionStartRangeForLog();
        if (selectionStartRange)
            logSelectionTuningContext(buildTuningUsageReportForRange(selectionStartRange));
    }
    return formatTuningPanelText(currentReport);
}

function getCurrentAccChainCountForPanel() {
    var currentReport = getCurrentTuningUsageReport();
    var tuningConfig = currentReport && currentReport.firstTuning ?
        currentReport.firstTuning.tuningConfig : null;

    if (!tuningConfig)
        tuningConfig = getCurrentTuningConfigForLog(true);

    if (!tuningConfig || !tuningConfig.accChains)
        return 0;

    return tuningConfig.accChains.length;
}

function getCurrentTuningConfigForPanel() {
    var currentReport = getCurrentTuningUsageReport();
    var tuningConfig = currentReport && currentReport.firstTuning ?
        currentReport.firstTuning.tuningConfig : null;

    if (!tuningConfig)
        tuningConfig = getCurrentTuningConfigForLog(true);

    return tuningConfig;
}

function extractAccChainStepTextForPanel(tuningConfig, chainIndex) {
    var chain = tuningConfig && tuningConfig.accChains ? tuningConfig.accChains[chainIndex] : null;
    if (!chain)
        return "";

    if (chain.stepLogText)
        return compactPanelLine(chain.stepLogText, 28);

    var sourceLine = tuningConfig.accChainLogTexts && tuningConfig.accChainLogTexts[chainIndex] ?
        tuningConfig.accChainLogTexts[chainIndex] : "";
    if (sourceLine.length > 0) {
        var words = sourceLine.split(" ");
        var centralWord = chain.centralIdx !== undefined && chain.centralIdx !== null ?
            words[chain.centralIdx] : "";
        var centralMatch = centralWord ? centralWord.match(/^\((.+)\)$/) : null;
        if (centralMatch)
            return compactPanelLine(centralMatch[1], 28);

        var match = sourceLine.match(/\(([^)]+)\)/);
        if (match)
            return compactPanelLine(match[1], 28);
    }

    if (chain.tunings && chain.centralIdx !== undefined && chain.centralIdx !== null) {
        var step = null;
        if (chain.centralIdx + 1 < chain.tunings.length)
            step = chain.tunings[chain.centralIdx + 1] - chain.tunings[chain.centralIdx];
        else if (chain.centralIdx > 0)
            step = chain.tunings[chain.centralIdx] - chain.tunings[chain.centralIdx - 1];
        if (step !== null)
            return formatPanelCents(step);
    }

    return "chain " + (chainIndex + 1);
}

function getCurrentAuxButtonGroupsForPanel() {
    var tuningConfig = getCurrentTuningConfigForPanel();
    var groups = [{
        index: 0,
        label: "Nominal"
    }];
    var accChainCount = tuningConfig && tuningConfig.accChains ? tuningConfig.accChains.length : 0;

    for (var i = 0; i < accChainCount; i++) {
        groups.push({
            index: i + 1,
            label: extractAccChainStepTextForPanel(tuningConfig, i)
        });
    }

    return groups;
}

function writeDailyLogLine(message) {
    var date = new Date();
    var line = formatLogTimestamp(date) + " " + message;
    var logPath = pluginHomePath + getDailyLogRelativePath(date);

    if (fileIO && pluginHomePath) {
        try {
            fileIO.source = logPath;
            var existingLog = fileIO.read();
            if (existingLog === undefined || existingLog === null)
                existingLog = "";
            if (existingLog.length > 0 && existingLog.charAt(existingLog.length - 1) != "\n")
                existingLog += "\n";
            if (fileIO.write(existingLog + line + "\n"))
                return true;
        } catch (fileError) {
            console.error("Failed to write Xen Tuner operation log: " + fileError);
        }
    }

    if (typeof openLog === "function" &&
        typeof logn === "function" &&
        typeof closeLog === "function" &&
        pluginHomePath) {
        try {
            openLog(logPath);
            logn(line);
            closeLog();
            return true;
        } catch (e) {
            try {
                closeLog();
            } catch (e2) { }
            console.error("Failed to write Xen Tuner operation log: " + e);
        }
    }

    console.log(line);
    return false;
}

function logOperation(operationText) {
    var scoreName = getScoreNameForLog();
    var tuningSource = getTuningSourceForLog();
    var operation = normalizeLogValue(operationText);
    if (operation.length == 0)
        operation = "Unknown operation";

    writeDailyLogLine("Score: " + scoreName +
        "; Tuning file: " + tuningSource +
        "; Operation: " + operation);
}

/**
 * Logs debug message to opened log file (MS4) & console (MS3).
 * 
 * Make sure {@link openLog} is called before calling this, and
 * {@link closeLog} is called after to flush logs.
 * 
 * @param {string} msg 
 */
function log(msg) {
    if (!DEBUG_LOG) return;
    logn(msg);
    console.log(msg);
}

/**
 * Executes before any shortcut/operation is handled
 * Call this after {@link init}
 */
function preAction() {
    applyProjectConfig();
    if (DEBUG_LOG) openLog(pluginHomePath + "logs/xen tuner.log");
}

/**
 * Executes after any shortcut/operation is handled
 */
function postAction() {
    if (DEBUG_LOG) closeLog();
}

function parseProjectConfigBoolean(value, fallback, fieldName) {
    if (typeof value === 'undefined' || value === null) {
        return fallback;
    }
    if (typeof value === 'boolean') {
        return value;
    }
    if (typeof value === 'string') {
        var lower = value.toLowerCase();
        if (lower == 'true' || lower == '1' || lower == 'yes' || lower == 'on') {
            return true;
        }
        if (lower == 'false' || lower == '0' || lower == 'no' || lower == 'off') {
            return false;
        }
    }

    console.warn('Invalid ' + fieldName + ' in ' + PROJECT_CONFIG_FILE + '; using ' + fallback + '.');
    return fallback;
}

function applyProjectConfig() {
    var autoDetect = false;
    var preferPlaybackTimbre = false;

    if (fileIO && pluginHomePath) {
        fileIO.source = pluginHomePath + PROJECT_CONFIG_FILE;
        var configText = fileIO.read() || "";
        configText = configText.trim();

        if (configText.length > 0) {
            try {
                var projectConfig = JSON.parse(configText);
                var playbackConfig = projectConfig && projectConfig.playback ? projectConfig.playback : projectConfig;

                if (playbackConfig && typeof playbackConfig == 'object') {
                    autoDetect = parseProjectConfigBoolean(
                        playbackConfig.autoDetectPlayback,
                        autoDetect,
                        'playback.autoDetectPlayback'
                    );
                    if (!autoDetect) {
                        preferPlaybackTimbre = parseProjectConfigBoolean(
                            playbackConfig.preferPlaybackTimbre,
                            preferPlaybackTimbre,
                            'playback.preferPlaybackTimbre'
                        );
                    }
                } else {
                    console.warn('Invalid ' + PROJECT_CONFIG_FILE + '; using default playback settings.');
                }
            } catch (e) {
                console.error('Error parsing ' + PROJECT_CONFIG_FILE + ': ' + e);
            }
        }
    }

    setPlaybackOptimization(autoDetect, preferPlaybackTimbre);
}

/**
 * Configures how aggressively tuning should use PlayEvent MIDI pitch offsets.
 *
 * @param {boolean} autoDetect If true, choose preview/playback mode from current context.
 * @param {boolean} preferPlaybackTimbre If true and autoDetect is false, favor PlayEvents.
 */
function setPlaybackOptimization(autoDetect, preferPlaybackTimbre) {
    playbackOptimizationAutoDetect = !!autoDetect;
    playbackOptimizationPreferPlaybackTimbre = !!preferPlaybackTimbre;
}

function isScorePlaybackActive(scoreState) {
    if (!_curScore && !scoreState) return false;

    var targets = [scoreState, _curScore];

    var booleanProperties = [
        'playing', 'isPlaying', 'playbackActive', 'isPlaybackActive',
        'playActive', 'isPlayActive', 'playbackRunning', 'isPlaybackRunning'
    ];
    for (var targetIdx = 0; targetIdx < targets.length; targetIdx++) {
        var target = targets[targetIdx];
        if (!target)
            continue;

        for (var i = 0; i < booleanProperties.length; i++) {
            try {
                var value = target[booleanProperties[i]];
                if (typeof value !== 'undefined') {
                    return !!value;
                }
            } catch (e) { }
        }

        var stateProperties = ['playbackState', 'playState', 'playerState', 'transportState'];
        for (var j = 0; j < stateProperties.length; j++) {
            try {
                var state = target[stateProperties[j]];
                if (typeof state === 'number') {
                    return state !== 0;
                }
                if (typeof state === 'string') {
                    var lowerState = state.toLowerCase();
                    return lowerState !== '' && lowerState !== 'stop' && lowerState !== 'stopped';
                }
            } catch (e2) { }
        }

        try {
            if (target.playback && typeof target.playback === 'object') {
                for (var nestedBoolIdx = 0; nestedBoolIdx < booleanProperties.length; nestedBoolIdx++) {
                    var nestedValue = target.playback[booleanProperties[nestedBoolIdx]];
                    if (typeof nestedValue !== 'undefined')
                        return !!nestedValue;
                }
                for (var nestedStateIdx = 0; nestedStateIdx < stateProperties.length; nestedStateIdx++) {
                    var nestedState = target.playback[stateProperties[nestedStateIdx]];
                    if (typeof nestedState === 'number')
                        return nestedState !== 0;
                    if (typeof nestedState === 'string') {
                        var lowerNestedState = nestedState.toLowerCase();
                        return lowerNestedState !== '' &&
                            lowerNestedState !== 'stop' &&
                            lowerNestedState !== 'stopped';
                    }
                }
            }
        } catch (e3) { }
    }

    return false;
}

function isPlaybackTimbrePreferred(returnMidiCSV) {
    if (returnMidiCSV) {
        return true;
    }
    if (playbackOptimizationAutoDetect) {
        return isScorePlaybackActive();
    }
    return playbackOptimizationPreferPlaybackTimbre;
}

function getPlayEventModSemitonesThreshold(returnMidiCSV) {
    return isPlaybackTimbrePreferred(returnMidiCSV) ?
        PLAY_EVENT_PLAYBACK_TIMBRE_THRESHOLD :
        PLAY_EVENT_PREVIEW_CONSISTENCY_THRESHOLD;
}

/**
 * 
 * @param {*} MSAccidental Accidental enum from MuseScore plugin API.
 * @param {*} MSNoteType NoteType enum from MuseScore plugin API.
 */
function normalizePluginHomePath(path) {
    path = path ? "" + path : "";

    if (strStartsWith(path, "file:///")) {
        path = path.slice(8);
    } else if (strStartsWith(path, "file://")) {
        path = path.slice(7);
    }

    path = path.replace(/\\/g, "/");
    if (path.length > 0 && path.charAt(path.length - 1) != "/") {
        path += "/";
    }
    if (path.length > 0 && path.match(/^\w:/g) == null && path.charAt(0) != "/") {
        path = "/" + path;
    }

    return path;
}

function setCurrentScore(MSCurScore) {
    if (_curScore !== MSCurScore) {
        _curScore = MSCurScore;
        lastLoggedSelectionTuningSignature = "";
    }
}

function init(MSAccidental, MSNoteType, MSSymId, MSElement, MSFileIO, MSCurScore, _isMS4, MSPluginHomePath) {
    Lookup = ImportLookup();
    // log(JSON.stringify(Lookup));
    Accidental = MSAccidental;
    SymId = MSSymId;
    NoteType = MSNoteType;
    Element = MSElement;
    fileIO = MSFileIO;
    setCurrentScore(MSCurScore);
    isMS4 = _isMS4;

    // set to absolute path
    var nextPluginHomePath = normalizePluginHomePath(MSPluginHomePath || Qt.resolvedUrl("../"));
    if (pluginHomePath != nextPluginHomePath && tuningConfigCache) {
        delete tuningConfigCache['!default!'];
    }
    pluginHomePath = nextPluginHomePath;
    if (DEBUG_LOG) {
        openLog(pluginHomePath + "logs/xen tuner.log");
        log("Home path: " + pluginHomePath);
        log("Initialized! Enharmonic eqv: " + ENHARMONIC_EQUIVALENT_THRESHOLD + " cents");
        closeLog();
    }
    applyProjectConfig();
}

/**
 * Saves the current `tuningConfigCache` as a metaTag in the current score.
 * 
 * This is very slow, run this function very sparsely.
 */
function saveMetaTagCache() {
    var toSave = {};

    Object.keys(tuningConfigCache).forEach(function (tuningConfigStr) {
        // don't save tuning configs with more than 1000 steps. MuseScore will crash.
        if (tuningConfigCache[tuningConfigStr].stepsList.length < 1000) {
            toSave[tuningConfigStr] = tuningConfigCache[tuningConfigStr];
        }
    });
    _curScore.setMetaTag('tuningconfigs', JSON.stringify(toSave));
}

/**
 * Clears runtime & metaTag tuning config caches from the current score.
 * 
 * Be sure to run this time to time, especially if you're experimenting
 * with many tuning configs in one score. This will force the plugin to repopulate
 * 
 * (Tell the user to run this if they are creating/experimenting with different tuning configs,
 * then deleting them, and are currently not using most of them)
 * 
 * Otherwise, the cache text will contain too many tuning configs and it will become
 * pointless to use the cache as the JSON parsing will take longer than just generating
 * the tuning config.
 */
function clearTuningConfigCaches() {
    tuningConfigCache = {};
    _curScore.setMetaTag('tuningconfigs', '');
}
