// Copyright (C) 2023 euwbah
// This file is part of Xen Tuner. See ../fns.js for license.
// Module: public tune and transpose operation entry points.
/**
 * Set whether or not to allow up/down fallthrough.
 * 
 * If Element.STAFF_TEXT or Element.SYSTEM_TEXT is selected
 * 
 * @param {boolean} allowFallthrough Whether or not `cmd('pitch-up/down')` should be sent
 */
function setUpDownFallthrough(allowFallthrough) {
    fallthroughUpDownCommand = allowFallthrough;
}

/*
==============================================================================================



 ██████╗ ██████╗ ███╗   ███╗███╗   ███╗ █████╗ ███╗   ██╗██████╗ ███████╗
██╔════╝██╔═══██╗████╗ ████║████╗ ████║██╔══██╗████╗  ██║██╔══██╗██╔════╝
██║     ██║   ██║██╔████╔██║██╔████╔██║███████║██╔██╗ ██║██║  ██║███████╗
██║     ██║   ██║██║╚██╔╝██║██║╚██╔╝██║██╔══██║██║╚██╗██║██║  ██║╚════██║
╚██████╗╚██████╔╝██║ ╚═╝ ██║██║ ╚═╝ ██║██║  ██║██║ ╚████║██████╔╝███████║
 ╚═════╝ ╚═════╝ ╚═╝     ╚═╝╚═╝     ╚═╝╚═╝  ╚═╝╚═╝  ╚═══╝╚═════╝ ╚══════╝
                                                                         
                                                                        
The main plugin functions are moved here.

Instead of having one plugin per operation, the plugin is now one single dockable window
that runs in the background. This plugin detects shortcuts according to the shortcut
settings in xen tuner.qml.

================================================================================================
*/

/**
 * Tunes selected notes or entire score. 
 * 
 * Optionally, will create fingerings that display the current cents or steps offset
 * of tuned notes.
 * 
 * @param {1|2|null} display
 * If `1`, create fingerings to display the cent offsets of notes according
 * to the `displaycents()` settings specified in the tuning config.
 * If `2`, create fingerings to display step indices of notes according
 * to `displaysteps()` settings specified in the tuning config.
 * @returns 
 */
function describeTuneOperation(display) {
    if (display == 1)
        return "Display cents";
    if (display == 2)
        return "Display steps";
    return "Tuning score/selection";
}

function operationTune(display) {
    log('Running Xen Tune');
    if (typeof _curScore === 'undefined' || !_curScore)
        return;
    logOperation(describeTuneOperation(display));

    /** @type {Parms} */
    var parms = {};
    _curScore.createPlayEvents();

    var cursor = _curScore.newCursor();
    cursor.rewind(1);
    var startStaff;
    var endStaff;
    var startTick = cursor.tick;
    var endTick;
    var fullScore = false;
    if (!cursor.segment) { // no selection
        fullScore = true;
        startStaff = 0; // start with 1st staff
        endStaff = _curScore.nstaves - 1; // and end with last
        endTick = _curScore.lastSegment.tick + 1;
    } else {
        startStaff = cursor.staffIdx;
        cursor.rewind(2);
        if (cursor.tick == 0) {
            // this happens when the selection includes
            // the last measure of the score.
            // rewind(2) goes behind the last segment (where
            // there's none) and sets tick=0
            endTick = _curScore.lastSegment.tick + 1;
        } else {
            endTick = cursor.tick;
        }
        endStaff = cursor.staffIdx;
    }
    log("startStaff: " + startStaff + ", endStaff: " + endStaff + ", endTick: " + endTick);

    //
    //
    //
    // -------------- Actual thing here -----------------------
    //
    //
    //

    // Set parms' defaults.

    // mapping of staffIdx to [ConfigUpdateEvent]
    parms.staffConfigs = {};
    // contains list of bars' ticks in order.
    parms.bars = [];


    // First, populate ConfigUpdateEvents for each staff.

    for (var staff = startStaff; staff <= endStaff; staff++) {

        // Contains [ConfigUpdateEvent]s for curr staff
        var configs = [];
        var nativeKeySigState = { hasValue: false, lastValue: null };
        var loadedKeySigState = { hasValue: false, lastValue: null };

        // Search each voice and populate `ConfigUpdateEvent`s in this staff.
        for (var voice = 0; voice < 4; voice++) {

            // NOTE: THIS IS THE ONLY RIGHT WAY (TM) TO REWIND THE CURSOR TO THE START OF THE SCORE.
            //       ANY OTHER METHOD WOULD RESULT IN CATASTROPHIC FAILURE FOR WHATEVER REASON.
            cursor.rewind(1);
            cursor.voice = voice;
            cursor.staffIdx = staff;
            cursor.rewind(0);

            var measureCount = 0;
            // log("Populating configs. staff: " + staff + ", voice: " + voice);

            while (true) {
                // loop from first segment to last segment of this staff+voice.
                if (cursor.segment) {
                    if (voice === 0) {
                        appendNativeKeySigConfigEvent(configs, cursor, nativeKeySigState);
                        appendLoadedKeySignatureVisualConfigEvent(configs, cursor, staff, loadedKeySigState);
                    }

                    for (var i = 0; i < cursor.segment.annotations.length; i++) {
                        var annotation = cursor.segment.annotations[i];
                        log("found annotation type: " + annotation.name);
                        if ((annotation.name == 'StaffText' && Math.floor(annotation.track / 4) == staff) ||
                            (annotation.name == 'SystemText')) {
                            var maybeConfigUpdateEvent = parsePossibleConfigs(annotation.text, cursor.tick);

                            if (maybeConfigUpdateEvent != null) {
                                configs.push(maybeConfigUpdateEvent);
                            }
                        }
                    }

                    if (cursor.segment.tick == cursor.measure.firstSegment.tick &&
                        voice === 0 && staff == startStaff) {
                        // For the first staff/voice, store tick positions of the start of each bar.
                        // this is used for accidental calculations.

                        parms.bars.push(cursor.segment.tick);
                        measureCount++;
                        // log("New bar - " + measureCount);
                    }
                }

                if (!cursor.next())
                    break;
            }
        }

        parms.staffConfigs[staff] = configs.sort(sortConfigUpdateEvents);
    }

    // Staff configs have been populated!

    var startBarIdx = getBarBoundaries(startTick, parms.bars, true)[0];
    var endBarIdx = getBarBoundaries(endTick, parms.bars, true)[1];

    // Go through each staff + voice to start tuning notes.

    for (var staff = startStaff; staff <= endStaff; staff++) {

        _curScore.startCmd();
        var accidentalNotationChanged = false;

        for (var voice = 0; voice < 4; voice++) {
            // After each voice & rewind, 
            // reset all configs back to default
            resetParms(parms);
            var staffConfigs = parms.staffConfigs[staff];
            var nextConfigIdx = 0;

            // NOTE: FOR WHATEVER REASON, rewind(1) must be called BEFORE assigning voice and staffIdx,
            //       and rewind(0) MUST be called AFTER rewind(1), AND AFTER assigning voice and staffIdx.
            cursor.rewind(1);
            cursor.voice = voice; //voice has to be set after goTo
            cursor.staffIdx = staff;
            cursor.rewind(0);

            // 0-indexed bar counter.
            // Used to keep track of bar boundaries efficiently.
            var currBar = getBarBoundaries(cursor.tick, parms.bars, true)[0];

            var tickOfThisBar = parms.bars[currBar];
            var tickOfNextBar = currBar == parms.bars.length - 1 ? -1 : parms.bars[currBar + 1];

            log("Tuning. staff: " + staff + ", voice: " + voice);
            // log("Starting bar: " + currBar + ", tickOfThisBar: " + tickOfThisBar + ", tickOfNextBar: " + tickOfNextBar);

            // Tuning doesn't affect note/accidental state,
            // we can reuse bar states per bar to prevent unnecessary
            // computation.
            var reusedBarState = {};
            var tickOfLastModified = -1;

            // Loop elements of a voice
            while (cursor.segment && (fullScore || cursor.tick < endTick)) {
                if (tickOfNextBar != -1 && cursor.tick >= tickOfNextBar) {
                    // Update bar boundaries.
                    currBar++;
                    tickOfThisBar = tickOfNextBar;
                    tickOfNextBar = currBar == parms.bars.length - 1 ? -1 : parms.bars[currBar + 1];
                    // log("Next bar: " + currBar + ", tickOfThisBar: " + tickOfThisBar + ", tickOfNextBar: " + tickOfNextBar);
                    // reset bar state.
                    reusedBarState = {};
                }

                // Apply newly reached config events only once.
                nextConfigIdx = applyConfigsUpTo(staffConfigs, parms, cursor.tick, nextConfigIdx);

                // Tune the note!

                if (cursor.element) {
                    if (cursor.element.name == "Chord") {
                        var graceChords = cursor.element.graceNotes;
                        for (var i = 0; i < graceChords.length; i++) {
                            // iterate through all grace chords
                            var notes = graceChords[i].notes;
                            for (var j = 0; j < notes.length; j++) {
                                if (readFingeringAccidentalInput(
                                    tokenizeNote(notes[j]),
                                    parms.currTuning
                                ) != null) {
                                    accidentalNotationChanged = true;
                                }
                                tuneNote(notes[j], parms.currKeySig, parms.currTuning,
                                    tickOfThisBar, tickOfNextBar, cursor, reusedBarState, newElement);
                                if (display) {
                                    addStepsCentsFingering(
                                        display == 2, notes[j], parms.currKeySig, parms.currTuning,
                                        tickOfThisBar, tickOfNextBar, cursor, reusedBarState, newElement);
                                }
                            }
                        }
                        var notes = cursor.element.notes;
                        for (var i = 0; i < notes.length; i++) {
                            if (readFingeringAccidentalInput(
                                tokenizeNote(notes[i]),
                                parms.currTuning
                            ) != null) {
                                accidentalNotationChanged = true;
                            }
                            tuneNote(notes[i], parms.currKeySig, parms.currTuning,
                                tickOfThisBar, tickOfNextBar, cursor, reusedBarState, newElement);
                            if (display) {
                                addStepsCentsFingering(
                                    display == 2, notes[i], parms.currKeySig, parms.currTuning,
                                    tickOfThisBar, tickOfNextBar, cursor, reusedBarState, newElement);
                            }
                        }

                        tickOfLastModified = cursor.tick;
                    }
                }
                cursor.next();
            }
        } // end of voice loop

        _curScore.endCmd();

        _curScore.startCmd();
        
        if (accidentalNotationChanged) {
            removeUnnecessaryAccidentals(
                startTick, endTick, parms, cursor, newElement, startBarIdx, endBarIdx
            );
        }

        autoPositionAccidentals(
            startTick, endTick, parms, cursor, startBarIdx, endBarIdx
        );
    

        _curScore.endCmd();
    }
}

/**
 * Operation to transpose according to specified direction & aux
 * 
 * @param {number} stepwiseDirection
 *  1: up
 *  0: cycle enharmonics
 *  -1: down
 * @param {number} stepwiseAux
 *  This number represents the 1-index Nth user-declared auxiliary operation.
 *  0 represents no aux, step through all notes.
 *  
 *  Auxiliary operations allow the user to declare whether
 *  the nominals, or specified accidental chains, should maintain 
 *  the same nominal/degree during the transpose up/down operation.
 */
function describeTransposeOperation(stepwiseDirection, stepwiseAux) {
    var aux = parseInt(stepwiseAux, 10);
    if (isNaN(aux) || aux < 0)
        aux = 0;

    var auxText = aux > 0 ? " aux " + aux + getAuxLogSuffix(aux) : "";
    if (stepwiseDirection == 0)
        return "Cycling enharmonics" + auxText;

    var directionText = stepwiseDirection > 0 ? "up" : "down";
    return "Moving note(s) " + directionText + auxText;
}

function describeAuxChainTransposeOperation(stepwiseDirection, chainIndex, tuningConfig) {
    var directionText = stepwiseDirection > 0 ? "up" : "down";
    var suffix = "";
    var accChainCount = tuningConfig && tuningConfig.accChains ? tuningConfig.accChains.length : 0;

    if (tuningConfig && chainIndex >= 0 && chainIndex <= accChainCount) {
        var changed = [chainIndex];
        var auxText = formatAuxLogText("", changed, tuningConfig);
        if (auxText.length > 0)
            suffix = " (" + auxText + ")";
    }

    return "Moving note(s) " + directionText + " aux " + chainIndex + suffix;
}

function operationAuxChainTranspose(stepwiseDirection, chainIndex) {
    chainIndex = parseInt(chainIndex, 10);
    if (isNaN(chainIndex) || chainIndex < 0)
        return;

    var tuningConfig = getCurrentTuningConfigForLog(false);
    var accChainCount = tuningConfig && tuningConfig.accChains ? tuningConfig.accChains.length : 0;
    if (chainIndex > accChainCount) {
        logOperation("Moving note(s) " + (stepwiseDirection > 0 ? "up" : "down") +
            " aux " + chainIndex + " (acc chain " + chainIndex + " is not defined in current tuning)");
        return;
    }

    operationTransposeWithOverrides(
        stepwiseDirection,
        0,
        { singleAccChainIndex: chainIndex },
        describeAuxChainTransposeOperation(stepwiseDirection, chainIndex, tuningConfig)
    );
}

function parseTransposeTargetNativeNominals(targetNotes) {
    var result = {
        ok: false,
        targets: {},
        label: "",
        error: ""
    };
    var tokens = keySignatureSequenceTokens(targetNotes);

    if (tokens.length == 0) {
        result.error = "Target notes are empty. Use scale degrees 1-7 or letters A-G.";
        return result;
    }

    for (var i = 0; i < tokens.length; i++) {
        var nativeNominal = keySignatureNativeNominal(tokens[i]);
        if (nativeNominal === null) {
            result.error = 'Invalid target note "' + tokens[i] + '". Use scale degrees 1-7 or letters A-G.';
            return result;
        }
        result.targets[nativeNominal] = true;
    }

    result.ok = true;
    result.label = tokens.join("");
    return result;
}

function describeFilteredAuxChainTransposeOperation(stepwiseDirection, chainIndex, tuningConfig, targetText) {
    var description = describeAuxChainTransposeOperation(stepwiseDirection, chainIndex, tuningConfig);
    if (targetText && targetText.length > 0)
        description += " for " + targetText;
    return description;
}

function operationFilteredAuxChainTranspose(stepwiseDirection, chainIndex, targetNotes) {
    chainIndex = parseInt(chainIndex, 10);
    if (isNaN(chainIndex) || chainIndex < 0)
        return;

    var parsedTargets = parseTransposeTargetNativeNominals(targetNotes);
    if (!parsedTargets.ok) {
        logOperation(parsedTargets.error);
        return;
    }

    var tuningConfig = getCurrentTuningConfigForLog(false);
    var accChainCount = tuningConfig && tuningConfig.accChains ? tuningConfig.accChains.length : 0;
    if (chainIndex > accChainCount) {
        logOperation("Moving note(s) " + (stepwiseDirection > 0 ? "up" : "down") +
            " aux " + chainIndex + " (acc chain " + chainIndex + " is not defined in current tuning)");
        return;
    }

    operationTransposeWithOverrides(
        stepwiseDirection,
        0,
        {
            singleAccChainIndex: chainIndex,
            targetNativeNominals: parsedTargets.targets
        },
        describeFilteredAuxChainTransposeOperation(stepwiseDirection, chainIndex, tuningConfig, parsedTargets.label)
    );
}

function operationTranspose(stepwiseDirection, stepwiseAux) {
    operationTransposeWithOverrides(
        stepwiseDirection,
        stepwiseAux,
        null,
        describeTransposeOperation(stepwiseDirection, stepwiseAux)
    );
}

function operationHasTransposeNoteFilter(overrideConstantConstrictions) {
    return !!(overrideConstantConstrictions &&
        overrideConstantConstrictions.targetNativeNominals);
}

function noteMatchesTransposeFilter(note, overrideConstantConstrictions) {
    if (!operationHasTransposeNoteFilter(overrideConstantConstrictions))
        return true;

    if (!note)
        return false;

    var msNote = tokenizeNote(note);
    var nativeNominal = mod(msNote.nominalsFromA4, 7);
    return !!overrideConstantConstrictions.targetNativeNominals[nativeNominal];
}

function operationTransposeWithOverrides(stepwiseDirection, stepwiseAux, overrideConstantConstrictions, operationDescription) {
    log("Xen Up");

    if (typeof _curScore === 'undefined' || !_curScore)
        return;
    logOperation(operationDescription || describeTransposeOperation(stepwiseDirection, stepwiseAux));

    /** @type {Parms} */
    var parms = {};

    var cursor = _curScore.newCursor();
    cursor.rewind(1);
    var startStaff;
    var endStaff;
    var startTick = cursor.tick;
    var endTick;
    var noPhraseSelection = false;
    if (!cursor.segment) { // no selection
        // no action if no selection.
        log('no phrase selection');
        noPhraseSelection = true;
    } else {
        startStaff = cursor.staffIdx;
        cursor.rewind(2);
        if (cursor.tick == 0) {
            // this happens when the selection includes
            // the last measure of the score.
            // rewind(2) goes behind the last segment (where
            // there's none) and sets tick=0
            endTick = _curScore.lastSegment.tick + 1;
        } else {
            endTick = cursor.tick;
        }
        endStaff = cursor.staffIdx;
    }

    if (noPhraseSelection) {
        if (!_curScore.selection || _curScore.selection.elements.length == 0) {
            log('no individual selection. quitting.');
            return;
        }

        var hasSelectedNote = false;
        for (var selectedIdx = 0; selectedIdx < _curScore.selection.elements.length; selectedIdx++) {
            if (_curScore.selection.elements[selectedIdx].type == Element.NOTE) {
                hasSelectedNote = true;
                break;
            }
        }

        if (!hasSelectedNote && fallthroughUpDownCommand) {
            log('no selected note elements, defaulting to pitch-up/pitch-down shortcuts');
            if (stepwiseDirection == 1)
                cmd('pitch-up');
            else if (stepwiseDirection == -1)
                cmd('pitch-down');
            return;
        }
    }

    _curScore.createPlayEvents();

    parms.staffConfigs = {};
    parms.bars = [];

    // populate configs for all staves.

    for (var staff = 0; staff < _curScore.nstaves; staff++) {
        var configs = [];
        var nativeKeySigState = { hasValue: false, lastValue: null };
        var loadedKeySigState = { hasValue: false, lastValue: null };

        for (var voice = 0; voice < 4; voice++) {
            cursor.rewind(1);
            cursor.staffIdx = staff;
            cursor.voice = voice;
            cursor.rewind(0);

            var measureCount = 0;
            log("Populating configs. staff: " + staff + ", voice: " + voice);

            while (true) {
                if (cursor.segment) {
                    if (voice === 0) {
                        appendNativeKeySigConfigEvent(configs, cursor, nativeKeySigState);
                        appendLoadedKeySignatureVisualConfigEvent(configs, cursor, staff, loadedKeySigState);
                    }

                    // scan edo & tuning center first. key signature parsing is dependant on edo used.
                    for (var i = 0; i < cursor.segment.annotations.length; i++) {
                        var annotation = cursor.segment.annotations[i];
                        log("found annotation type: " + annotation.name);
                        if ((annotation.name == 'StaffText' && Math.floor(annotation.track / 4) == staff) ||
                            (annotation.name == 'SystemText')) {
                            var maybeConfigUpdateEvent = parsePossibleConfigs(annotation.text, cursor.tick);

                            if (maybeConfigUpdateEvent != null) {
                                configs.push(maybeConfigUpdateEvent);
                            }
                        }
                    }

                    if (cursor.segment.tick == cursor.measure.firstSegment.tick
                        && voice === 0 && staff === 0) {
                        if (!parms.bars)
                            parms.bars = [];

                        parms.bars.push(cursor.segment.tick);
                        measureCount++;
                        // log("New bar - " + measureCount + ", tick: " + cursor.segment.tick);
                    }
                }

                if (!cursor.next())
                    break;
            }
        }

        parms.staffConfigs[staff] = configs.sort(sortConfigUpdateEvents);
    }

    var startBarIdx = null, endBarIdx = null;

    if (!noPhraseSelection) {
        startBarIdx = getBarBoundaries(startTick, parms.bars, true)[0];
        endBarIdx = getBarBoundaries(endTick, parms.bars, true)[1];
    }
    var hasTransposeNoteFilter = operationHasTransposeNoteFilter(overrideConstantConstrictions);

    // End of config population.
    //
    //
    //
    // Begin pitch modification impl


    if (noPhraseSelection) {
        // No phrase/range selection mode.
        //
        // User selects individual note heads to modify.

        // - No-op if _curScore.selection.elements.length == 0.
        // - If selection doesn't contain a single element that has Element.type == Element.NOTE,
        //   default to cmd('pitch-up') or cmd('pitch-down') so MuseScore can handle moving other Elements.
        //   This allows users to use this plugin in place of the 'pitch-up' and 'pitch-down' shortcuts (up/down arrow keys)
        //   without losing any of the other functions that the up or down arrow keys originally provides.
        // - If selection contains individual notes, transpose them.

        if (_curScore.selection.elements.length == 0) {
            log('no individual selection. quitting.');
            return;
        } else {
            /** @type {PluginAPINote[]} */
            var selectedNotes = [];
            for (var i = 0; i < _curScore.selection.elements.length; i++) {
                if (_curScore.selection.elements[i].type == Element.NOTE) {
                    selectedNotes.push(_curScore.selection.elements[i]);
                }
            }

            // for debugging
            // for (var i = 0; i < selectedNotes.length; i ++) {
            //   selectedNotes[i].color = 'red';
            // }

            if (selectedNotes.length == 0 && fallthroughUpDownCommand) {
                log('no selected note elements, defaulting to pitch-up/pitch-down shortcuts');
                if (stepwiseDirection == 1)
                    cmd('pitch-up');
                else if (stepwiseDirection == -1)
                    cmd('pitch-down');
                return;
            }

            // Run transpose operation on all selected note elements.

            // contains list of notes that have already been transposed
            // this is to prevent repeat transposition in the event that
            // 2 notes tied to each other are individually selected.
            var affected = [];

            for (var i = 0; i < selectedNotes.length; i++) {
                var note = selectedNotes[i];
                var voice = note.track % 4;
                var staffIdx = Math.floor(note.track / 4);
                var tick = getTick(note);

                // handle transposing the firstTiedNote in the event that a non-first tied note
                // is selected.
                note = note.firstTiedNote;
                if (!noteMatchesTransposeFilter(note, overrideConstantConstrictions))
                    continue;

                var firstTiedTick = getTick(note);
                var lastTiedTick = getTick(note.lastTiedNote);

                var alreadyTrans = false;
                for (var j = 0; j < affected.length; j++) {
                    if (affected[j].is(note)) {
                        alreadyTrans = true;
                        break;
                    }
                }

                if (alreadyTrans)
                    continue;

                affected.push(note);

                setCursorToPosition(cursor, tick, voice, staffIdx);

                log('indiv note: line: ' + note.line + ', voice: ' + cursor.voice
                    + ', staff: ' + cursor.staffIdx + ', tick: ' + tick);


                // Reset & populate configs for each note,
                // since we're uncertain which note belongs to which bar.

                resetParms(parms);

                for (var j = 0; j < parms.staffConfigs[Math.floor(note.track / 4)].length; j++) {
                    var config = parms.staffConfigs[cursor.staffIdx][j];
                    if (config.tick <= cursor.tick) {
                        config.config(parms);
                    }
                }

                // Modify pitch.

                _curScore.startCmd();

                var firstTiedBarIdx = getBarBoundaries(firstTiedTick, parms.bars, true)[0];
                var lastTiedBarEndIdx = getBarBoundaries(lastTiedTick, parms.bars, true)[1];

                // direction: 1: up, -1 = down, 0: enharmonic cycle.
                executeTranspose(note, stepwiseDirection,
                    stepwiseAux, parms, newElement, cursor, overrideConstantConstrictions);

                // Remove unnecessary accidentals just for this bar.

                removeUnnecessaryAccidentals(
                    tick, tick, parms, cursor, newElement, firstTiedBarIdx, lastTiedBarEndIdx);

                _curScore.endCmd();
                _curScore.startCmd();

                // Auto position accidentals in this bar.
                autoPositionAccidentals(
                    tick, tick, parms, cursor, firstTiedBarIdx, lastTiedBarEndIdx
                );
                _curScore.endCmd();


            }
        }
    } // End of no-phrase selection impl
    else {
        // Standard implementation for phrase selection.
        for (var staff = startStaff; staff <= endStaff; staff++) {
            _curScore.startCmd();
            var modifiedStaff = false;
            for (var voice = 0; voice < 4; voice++) {

                // reset curr configs

                resetParms(parms);
                var staffConfigs = parms.staffConfigs[staff];
                var nextConfigIdx = 0;

                cursor.rewind(1); // goes to start of selection, will reset voice to 0

                // 0-indexed bar counter.
                // Used to keep track of bar boundaries efficiently.
                var currBar = getBarBoundaries(cursor.tick, parms.bars, true)[0];

                var tickOfThisBar = parms.bars[currBar];
                var tickOfNextBar = currBar == parms.bars.length - 1 ? -1 : parms.bars[currBar + 1];

                cursor.staffIdx = staff;
                cursor.voice = voice;

                log('processing:' + cursor.tick + ', voice: ' + cursor.voice + ', staffIdx: ' + cursor.staffIdx);

                var tickOfLastModified = -1;

                // Loop elements of a voice
                while (cursor.segment && (cursor.tick < endTick)) {
                    if (tickOfNextBar != -1 && cursor.tick >= tickOfNextBar) {
                        // Update bar boundaries.
                        currBar++;
                        tickOfThisBar = tickOfNextBar;
                        tickOfNextBar = currBar == parms.bars.length - 1 ? -1 : parms.bars[currBar + 1];
                    }

                    nextConfigIdx = applyConfigsUpTo(staffConfigs, parms, cursor.tick, nextConfigIdx);

                    if (cursor.element) {
                        if (cursor.element.name == "Chord") {
                            var modifiedChord = false;
                            var graceChords = cursor.element.graceNotes;
                            for (var i = 0; i < graceChords.length; i++) {
                                // iterate through all grace chords
                                var notes = graceChords[i].notes;
                                for (var j = 0; j < notes.length; j++) {
                                    var note = notes[j];

                                    // skip notes that are tied to previous notes.
                                    if (note.tieBack)
                                        continue;

                                    // Modify pitch.
                                    if (noteMatchesTransposeFilter(note, overrideConstantConstrictions)) {
                                        executeTranspose(note, stepwiseDirection, stepwiseAux, parms, newElement, cursor, overrideConstantConstrictions);
                                        modifiedChord = true;
                                        modifiedStaff = true;
                                    }
                                }
                            }
                            var notes = cursor.element.notes;
                            for (var i = 0; i < notes.length; i++) {
                                var note = notes[i];

                                // skip notes that are tied to previous notes.
                                if (note.tieBack)
                                    continue;

                                // Modify pitch.
                                if (noteMatchesTransposeFilter(note, overrideConstantConstrictions)) {
                                    executeTranspose(note, stepwiseDirection, stepwiseAux, parms, newElement, cursor, overrideConstantConstrictions);
                                    modifiedChord = true;
                                    modifiedStaff = true;
                                }
                            }
                            if (!hasTransposeNoteFilter || modifiedChord)
                                tickOfLastModified = cursor.tick;
                        }
                    }
                    cursor.next();
                }

                // Don't forget to remove unnecessary accidentals for the last bit of 
                // the selection that wasn't included in the loop above.

                if (tickOfLastModified != -1) {
                    removeUnnecessaryAccidentals(
                        tickOfLastModified, tickOfLastModified, parms,
                        cursor, newElement);
                }

                // Also don't forget to auto position accidentals for the last bar.
            } // end of voices

            _curScore.endCmd();

            _curScore.startCmd();
            
            if (!hasTransposeNoteFilter || modifiedStaff) {
                removeUnnecessaryAccidentals(
                    startTick, endTick, parms, cursor, newElement, startBarIdx, endBarIdx
                );

                // After processing all voices in a staff,
                // auto position accidentals in this staff in the selection range
                autoPositionAccidentals(
                    startTick, endTick, parms, cursor, startBarIdx, endBarIdx
                );
            }
            
            _curScore.endCmd();
        }
    }
}

var LOADED_KEY_SIGNATURE_METADATA_Z = 8400;
var OLD_LOADED_KEY_SIGNATURE_VISUAL_Z = 8500;
var OLD_LOADED_KEY_SIGNATURE_VISUAL_Z_LIMIT = 8999;
var LOADED_KEY_SIGNATURE_VISUAL_Z = 9200;
var LOADED_KEY_SIGNATURE_VISUAL_GROUP_SIZE = 50;
var LOADED_KEY_SIGNATURE_VISUAL_Z_LIMIT = LOADED_KEY_SIGNATURE_VISUAL_Z +
    7 * LOADED_KEY_SIGNATURE_VISUAL_GROUP_SIZE - 1;
var LOADED_KEY_SIGNATURE_INITIAL_OFFSET_X = 0.8;
var LOADED_KEY_SIGNATURE_LAYOUT_REPLACE_TOLERANCE = 0.05;

function loadedKeySignatureElementName(element) {
    if (!element || element.name === undefined || element.name === null)
        return '';
    return String(element.name).toLowerCase().replace(/[\s_-]+/g, '');
}

function loadedKeySignatureSymbolCodeFromName(name) {
    return musescoreNativeSymbolCode(name);
}

function isSamePluginElement(a, b) {
    if (!a || !b)
        return false;
    if (a === b)
        return true;

    try {
        if (a.is && a.is(b))
            return true;
    } catch (e) { }

    try {
        if (b.is && b.is(a))
            return true;
    } catch (e2) { }

    return false;
}

function isLoadedKeySignatureVisual(element) {
    try {
        return element &&
            ((element.z >= OLD_LOADED_KEY_SIGNATURE_VISUAL_Z &&
                element.z <= OLD_LOADED_KEY_SIGNATURE_VISUAL_Z_LIMIT) ||
                (element.z >= LOADED_KEY_SIGNATURE_VISUAL_Z &&
                    element.z <= LOADED_KEY_SIGNATURE_VISUAL_Z_LIMIT));
    } catch (e) {
        return false;
    }
}

function isVisibleLoadedKeySignatureVisual(element) {
    if (!isLoadedKeySignatureVisual(element))
        return false;

    try {
        if (element.visible === false)
            return false;
    } catch (e) { }

    return true;
}

function loadedKeySignatureVisualZ(nativeNominal, symbolIndex) {
    return LOADED_KEY_SIGNATURE_VISUAL_Z +
        nativeNominal * LOADED_KEY_SIGNATURE_VISUAL_GROUP_SIZE +
        Math.min(symbolIndex, LOADED_KEY_SIGNATURE_VISUAL_GROUP_SIZE - 1);
}

function loadedKeySignatureNativeNominalFromZ(z) {
    if (z < LOADED_KEY_SIGNATURE_VISUAL_Z ||
        z > LOADED_KEY_SIGNATURE_VISUAL_Z_LIMIT)
        return null;

    return Math.floor(
        (z - LOADED_KEY_SIGNATURE_VISUAL_Z) /
        LOADED_KEY_SIGNATURE_VISUAL_GROUP_SIZE
    );
}

function isLoadedKeySignatureMetadata(element) {
    try {
        return element && element.z == LOADED_KEY_SIGNATURE_METADATA_Z &&
            element.text !== undefined &&
            String(element.text).trim().match(/^keysig!(?:\s|$)/i);
    } catch (e) {
        return false;
    }
}

function isKeySignatureElement(element) {
    if (!element)
        return false;

    try {
        if (Element && Element.KEYSIG !== undefined && element.type == Element.KEYSIG)
            return true;
    } catch (e) { }

    var name = loadedKeySignatureElementName(element);
    return name == 'keysig' || name == 'keysignature' || isLoadedKeySignatureVisual(element);
}

function isBarlineElement(element) {
    if (!element)
        return false;

    try {
        if (Element && Element.BARLINE !== undefined && element.type == Element.BARLINE)
            return true;
        if (Element && Element.BAR_LINE !== undefined && element.type == Element.BAR_LINE)
            return true;
    } catch (e) { }

    var name = loadedKeySignatureElementName(element);
    return name == 'barline' || name.indexOf('barline') != -1;
}

function loadedKeySignatureMeasureStartAtOrBefore(tick, bars) {
    var selected = bars.length > 0 ? bars[0] : 0;
    for (var i = 0; i < bars.length; i++) {
        if (bars[i] > tick)
            break;
        selected = bars[i];
    }
    return selected;
}

function loadedKeySignatureMeasureStartAtOrAfter(tick, bars) {
    for (var i = 0; i < bars.length; i++) {
        if (bars[i] >= tick)
            return bars[i];
    }
    return null;
}

function resolveLoadedKeySignatureTarget(bars) {
    if (!_curScore)
        return { ok: false, error: 'No score is open.' };

    try {
        var rangeCursor = _curScore.newCursor();
        rangeCursor.rewind(1);
        if (rangeCursor.segment) {
            var startTick = rangeCursor.tick;
            var startStaff = rangeCursor.staffIdx;
            rangeCursor.rewind(2);
            var endStaff = rangeCursor.staffIdx;
            if (endStaff < startStaff) {
                var tmpStaff = startStaff;
                startStaff = endStaff;
                endStaff = tmpStaff;
            }

            return {
                ok: true,
                kind: 'range',
                tick: loadedKeySignatureMeasureStartAtOrBefore(startTick, bars),
                startStaff: startStaff,
                endStaff: endStaff,
                placement: 'before',
                selectedElements: []
            };
        }
    } catch (e) { }

    if (!_curScore.selection || !_curScore.selection.elements ||
        _curScore.selection.elements.length == 0) {
        return {
            ok: false,
            error: 'Select a key signature, a barline, or a range before loading a key signature.'
        };
    }

    var elements = _curScore.selection.elements;
    var selected = null;
    var selectedKind = '';
    for (var i = 0; i < elements.length; i++) {
        if (isKeySignatureElement(elements[i])) {
            selected = elements[i];
            selectedKind = 'keysig';
            break;
        }
    }
    if (!selected) {
        for (var j = 0; j < elements.length; j++) {
            if (isBarlineElement(elements[j])) {
                selected = elements[j];
                selectedKind = 'barline';
                break;
            }
        }
    }

    if (!selected) {
        return {
            ok: false,
            error: 'Select a key signature, a barline, or a range before loading a key signature.'
        };
    }

    var elementTick = getElementTickForLog(selected);
    var staffIdx = getElementStaffIdxForLog(selected);
    if (elementTick === null)
        return { ok: false, error: 'Could not determine the selected element position.' };
    if (staffIdx === null)
        staffIdx = 0;

    var targetTick = elementTick;
    var placement = 'before';
    if (selectedKind == 'barline') {
        targetTick = loadedKeySignatureMeasureStartAtOrAfter(elementTick, bars);
        placement = 'after';
        if (targetTick === null)
            return { ok: false, error: 'The selected barline has no following measure.' };
    }

    return {
        ok: true,
        kind: selectedKind,
        tick: targetTick,
        startStaff: staffIdx,
        endStaff: staffIdx,
        placement: placement,
        selectedElements: [selected]
    };
}

function collectLoadedKeySignatureScoreContext() {
    var context = {
        bars: [],
        staffConfigs: {}
    };
    var cursor = _curScore.newCursor();

    for (var staff = 0; staff < _curScore.nstaves; staff++) {
        var configs = [];
        var nativeKeySigState = { hasValue: false, lastValue: null };
        var loadedKeySigState = { hasValue: false, lastValue: null };
        var seenAnnotations = {};

        for (var voice = 0; voice < 4; voice++) {
            cursor.rewind(1);
            cursor.voice = voice;
            cursor.staffIdx = staff;
            cursor.rewind(0);

            while (cursor.segment) {
                if (voice === 0)
                    appendNativeKeySigConfigEvent(configs, cursor, nativeKeySigState);

                if (voice === 0)
                    appendLoadedKeySignatureVisualConfigEvent(configs, cursor, staff, loadedKeySigState);

                for (var annotationIdx = 0;
                    annotationIdx < cursor.segment.annotations.length;
                    annotationIdx++) {
                    var annotation = cursor.segment.annotations[annotationIdx];
                    if ((annotation.name == 'StaffText' &&
                        Math.floor(annotation.track / 4) == staff) ||
                        annotation.name == 'SystemText') {
                        var annotationKey = cursor.tick + '|' + annotation.name + '|' +
                            annotation.track + '|' + annotation.text;
                        if (!seenAnnotations[annotationKey]) {
                            seenAnnotations[annotationKey] = true;
                            var event = parsePossibleConfigs(annotation.text, cursor.tick);
                            if (event != null)
                                configs.push(event);
                        }
                    }
                }

                if (staff === 0 && voice === 0 &&
                    cursor.segment.tick == cursor.measure.firstSegment.tick) {
                    if (context.bars.length == 0 ||
                        context.bars[context.bars.length - 1] != cursor.segment.tick) {
                        context.bars.push(cursor.segment.tick);
                    }
                }

                if (!cursor.next())
                    break;
            }
        }

        context.staffConfigs[staff] = configs.sort(sortConfigUpdateEvents);
    }

    return context;
}

function loadedKeySignatureParmsAtTick(configs, tick) {
    var parms = {};
    resetParms(parms);
    applyConfigsUpTo(configs, parms, tick, 0);
    return parms;
}

function isLoadedKeySignatureConfigKind(kind) {
    return kind == 'keysig' ||
        kind == 'native-keysig' ||
        kind == 'loaded-keysig' ||
        kind == 'loaded-keysig-native-custom' ||
        kind == 'loaded-keysig-memory';
}

function loadedKeySignatureNextChangeTick(configs, startTick) {
    var endTick = getScoreLastTickForLog();
    for (var i = 0; i < configs.length; i++) {
        if (configs[i].tick > startTick &&
            isLoadedKeySignatureConfigKind(configs[i].kind)) {
            endTick = Math.min(endTick, configs[i].tick);
        }
    }
    return endTick;
}

function collectLoadedKeySignatureSnapshots(staff, startTick, endTick, scoreContext) {
    var snapshots = [];
    var configs = scoreContext.staffConfigs[staff];
    var bars = scoreContext.bars;
    var cursor = _curScore.newCursor();
    var order = 0;

    for (var voice = 0; voice < 4; voice++) {
        var parms = {};
        resetParms(parms);
        var nextConfigIdx = 0;

        cursor.rewind(1);
        cursor.voice = voice;
        cursor.staffIdx = staff;
        cursor.rewind(0);

        while (cursor.segment && cursor.tick < endTick) {
            nextConfigIdx = applyConfigsUpTo(configs, parms, cursor.tick, nextConfigIdx);
            if (cursor.tick >= startTick && cursor.element &&
                cursor.element.name == 'Chord') {
                var boundaries = getBarBoundaries(cursor.tick, bars, false);
                var tickOfThisBar = boundaries[0];
                var tickOfNextBar = boundaries[1];
                var addSnapshot = function (note) {
                    var noteData = readNoteData(
                        tokenizeNote(note),
                        parms.currTuning,
                        parms.currKeySig,
                        tickOfThisBar,
                        tickOfNextBar,
                        cursor,
                        null
                    );
                    if (!noteData)
                        return;

                    var oldCents = calcCentsOffset(noteData, parms.currTuning, true);
                    snapshots.push({
                        note: note,
                        tick: cursor.tick,
                        staff: staff,
                        voice: voice,
                        order: order++,
                        oldCents: oldCents,
                        oldSymbols: noteData.secondaryAccSyms.concat(
                            noteData.xen.orderedSymbols
                        )
                    });
                };

                for (var groupIdx = 0;
                    groupIdx < cursor.element.graceNotes.length;
                    groupIdx++) {
                    var notes = cursor.element.graceNotes[groupIdx].notes;
                    for (var noteIdx = 0; noteIdx < notes.length; noteIdx++) {
                        addSnapshot(notes[noteIdx]);
                    }
                }
                var mainNotes = cursor.element.notes;
                for (var mainNoteIdx = 0; mainNoteIdx < mainNotes.length; mainNoteIdx++) {
                    addSnapshot(mainNotes[mainNoteIdx]);
                }
            }

            if (!cursor.next())
                break;
        }
    }

    snapshots.sort(function (a, b) {
        if (a.tick != b.tick)
            return a.tick - b.tick;
        if (a.voice != b.voice)
            return a.voice - b.voice;
        return a.order - b.order;
    });
    return snapshots;
}

function loadedKeySignatureConfigEvent(keySignatureData, tick) {
    return {
        kind: 'loaded-keysig-memory',
        text: 'loaded key signature',
        tick: tick,
        priority: 40,
        order: 1000000,
        config: function (parms) {
            if (keySignatureData.entries) {
                setCurrentKeySignatureSource(
                    parms,
                    'native-entries',
                    keySignatureData.entries
                );
            } else {
                setCurrentKeySignatureSource(
                    parms,
                    'static',
                    keySignatureData.keySig
                );
            }
        }
    };
}

function loadedKeySignatureSequenceMatches(entries, nominalOrder) {
    if (!entries || entries.length == 0 || entries.length > nominalOrder.length)
        return false;

    for (var i = 0; i < entries.length; i++) {
        if (entries[i].nativeNominal != nominalOrder[i])
            return false;
    }

    return true;
}

function loadedKeySignatureSequenceKind(entries) {
    if (loadedKeySignatureSequenceMatches(entries, NATIVE_KEY_SIG_SHARP_NOMINALS))
        return 'sharp';
    if (loadedKeySignatureSequenceMatches(entries, NATIVE_KEY_SIG_FLAT_NOMINALS))
        return 'flat';

    for (var i = 0; i < entries.length; i++) {
        if (!entries[i].symbols || entries[i].symbols.length == 0)
            continue;

        var firstSymbol = parseInt(entries[i].symbols[0], 10);
        if (firstSymbol == 6)
            return 'flat';
        if (firstSymbol == 5)
            return 'sharp';
    }

    return 'sharp';
}

function loadedKeySignatureClefKind(cursor, staff) {
    var clefText = '';
    try {
        if (cursor.clefType !== undefined && cursor.clefType !== null)
            clefText = String(cursor.clefType);
        else if (cursor.clef !== undefined && cursor.clef !== null)
            clefText = String(cursor.clef);
    } catch (e) { }

    clefText = clefText.toLowerCase();
    if (clefText.indexOf('bass') != -1 ||
        clefText.indexOf('f_clef') != -1 ||
        clefText.match(/(^|[^a-z])f([^a-z]|$)/)) {
        return 'bass';
    }
    if (clefText.indexOf('treble') != -1 ||
        clefText.indexOf('g_clef') != -1 ||
        clefText.match(/(^|[^a-z])g([^a-z]|$)/)) {
        return 'treble';
    }

    // Piano grand staves commonly expose no clef string through the plugin API.
    // Match the usual visual convention shown in the attached reference.
    if (_curScore && _curScore.nstaves > 1 && staff % 2 == 1)
        return 'bass';

    return 'treble';
}

function loadedKeySignatureMuseScoreClefLines(clefKind) {
    if (clefKind == 'bass')
        return [2, 5, 1, 4, 7, 3, 6, 6, 3, 7, 4, 8, 5, 9];

    return [0, 3, -1, 2, 5, 1, 4, 4, 1, 5, 2, 6, 3, 7];
}

function loadedKeySignatureNativeNominalOrder(sequenceKind) {
    return sequenceKind == 'flat' ?
        NATIVE_KEY_SIG_FLAT_NOMINALS :
        NATIVE_KEY_SIG_SHARP_NOMINALS;
}

function loadedKeySignatureStandardStaffY(sequenceKind, clefKind, sequenceIndex) {
    if (sequenceIndex < 0 || sequenceIndex >= 7)
        return null;

    var lines = loadedKeySignatureMuseScoreClefLines(clefKind);
    if (sequenceKind == 'flat')
        return lines[7 + sequenceIndex] * 0.5;

    if (sequenceKind == 'sharp')
        return lines[sequenceIndex] * 0.5;

    return null;
}

function loadedKeySignatureStaffYFromNativeNominal(nativeNominal, sequenceKind,
    clefKind) {
    var nominalOrder = loadedKeySignatureNativeNominalOrder(sequenceKind);
    var sequenceIndex = nominalOrder.indexOf(nativeNominal);
    if (sequenceIndex < 0)
        return null;

    return loadedKeySignatureStandardStaffY(
        sequenceKind,
        clefKind,
        sequenceIndex
    );
}

function loadedKeySignatureStaffY(nativeNominal, sequenceKind, clefKind,
    sequenceIndex) {
    var standardY = loadedKeySignatureStandardStaffY(
        sequenceKind,
        clefKind,
        sequenceIndex
    );
    if (standardY !== null)
        return standardY;

    return loadedKeySignatureStaffYFromNativeNominal(
        nativeNominal,
        sequenceKind,
        clefKind
    );
}

function loadedKeySignatureMuseScoreStep(nativeNominal) {
    return mod(nativeNominal + 5, 7);
}

function loadedKeySignatureStaffYFromCustomKeySigApi(cursor, staff, nativeNominal,
    sequenceKind, sequenceIndex) {
    if (!cursor || typeof cursor.keySignaturePositionForStepForStaff != 'function')
        return null;

    try {
        var accidentalKind = sequenceKind == 'flat' ? -1 : 1;
        var position = cursor.keySignaturePositionForStepForStaff(
            loadedKeySignatureMuseScoreStep(nativeNominal),
            accidentalKind,
            sequenceIndex,
            cursor.tick,
            staff
        );
        if (position && position.y !== undefined && position.y !== null)
            return position.y;
    } catch (e) {
    }

    return null;
}

function loadedKeySignatureNativeNominalFromOffsetY(offsetY, cursor, staff) {
    if (offsetY === undefined || offsetY === null)
        return null;

    var clefKind = loadedKeySignatureClefKind(cursor, staff);
    var lines = loadedKeySignatureMuseScoreClefLines(clefKind);
    var maps = [
        {
            nominalOrder: NATIVE_KEY_SIG_SHARP_NOMINALS,
            offset: 0
        },
        {
            nominalOrder: NATIVE_KEY_SIG_FLAT_NOMINALS,
            offset: 7
        }
    ];

    var bestNominal = null;
    var bestDistance = 0.08;
    for (var mapIdx = 0; mapIdx < maps.length; mapIdx++) {
        for (var orderIdx = 0; orderIdx < maps[mapIdx].nominalOrder.length; orderIdx++) {
            var nominal = maps[mapIdx].nominalOrder[orderIdx];
            var staffY = lines[maps[mapIdx].offset + orderIdx] * 0.5;
            var distance = Math.abs(offsetY - staffY);
            if (distance < bestDistance) {
                bestDistance = distance;
                bestNominal = nominal;
            }
        }
    }

    return bestNominal;
}

function loadedKeySignatureSymbolCodeFromAnnotation(annotation) {
    if (!annotation)
        return null;

    try {
        if (annotation.symbol) {
            return loadedKeySignatureSymbolCodeFromName(annotation.symbol);
        }
    } catch (e) { }

    try {
        if (annotation.text !== undefined && annotation.text !== null) {
            var rawText = String(annotation.text);
            var symMatch = rawText.match(/<sym>([^<]+)<\/sym>/i);
            if (symMatch) {
                return loadedKeySignatureSymbolCodeFromName(symMatch[1]);
            }

            var text = removeFormattingCode(rawText);
            if (text.length > 0)
                return "'" + text;
        }
    } catch (e2) { }

    return null;
}

function loadedKeySignatureVisualEntriesAtCursor(cursor, staff) {
    var entriesByNominal = {};
    if (!cursor.segment)
        return [];

    for (var annotationIdx = 0;
        annotationIdx < cursor.segment.annotations.length;
        annotationIdx++) {
        var annotation = cursor.segment.annotations[annotationIdx];
        if (!isVisibleLoadedKeySignatureVisual(annotation))
            continue;

        try {
            if (Math.floor(annotation.track / 4) != staff)
                continue;
        } catch (trackError) {
            continue;
        }

        var nativeNominal = loadedKeySignatureNativeNominalFromZ(annotation.z);
        if (nativeNominal === null) {
            nativeNominal = loadedKeySignatureNativeNominalFromOffsetY(
                annotation.offsetY,
                cursor,
                staff
            );
        }
        if (nativeNominal === null)
            continue;

        var symbolCode = loadedKeySignatureSymbolCodeFromAnnotation(annotation);
        if (symbolCode === null)
            continue;

        if (!entriesByNominal[nativeNominal]) {
            entriesByNominal[nativeNominal] = {
                nativeNominal: nativeNominal,
                symbolsWithOrder: [],
                minOffsetX: annotation.offsetX || 0
            };
        }

        entriesByNominal[nativeNominal].symbolsWithOrder.push({
            symbolCode: symbolCode,
            z: annotation.z || 0,
            offsetX: annotation.offsetX || 0
        });
        entriesByNominal[nativeNominal].minOffsetX = Math.min(
            entriesByNominal[nativeNominal].minOffsetX,
            annotation.offsetX || 0
        );
    }

    var entries = [];
    for (var key in entriesByNominal) {
        var entry = entriesByNominal[key];
        entry.symbolsWithOrder.sort(function (a, b) {
            if (a.offsetX != b.offsetX)
                return a.offsetX - b.offsetX;
            return a.z - b.z;
        });

        var symbols = [];
        for (var i = 0; i < entry.symbolsWithOrder.length; i++) {
            symbols.push(entry.symbolsWithOrder[i].symbolCode);
        }

        entries.push({
            nativeNominal: entry.nativeNominal,
            symbols: symbols,
            minOffsetX: entry.minOffsetX
        });
    }

    entries.sort(function (a, b) {
        if (a.minOffsetX != b.minOffsetX)
            return a.minOffsetX - b.minOffsetX;
        return a.nativeNominal - b.nativeNominal;
    });

    return entries;
}

function loadedKeySignatureCustomApiElementAtCursor(cursor, staff) {
    if (!cursor || !cursor.segment)
        return null;

    var track = staff * 4;
    var tick = cursor.tick;

    try {
        var element = cursor.segment.elementAt(track);
        if (isKeySignatureElement(element))
            return element;
    } catch (e) { }

    try {
        var measure = cursor.measure;
        var segment = measure ? measure.firstSegment : null;
        var guard = 0;
        while (segment && guard++ < 1000) {
            if (segment.tick == tick) {
                var keySig = segment.elementAt(track);
                if (isKeySignatureElement(keySig))
                    return keySig;
            } else if (segment.tick > tick) {
                break;
            }

            segment = segment.nextInMeasure;
        }
    } catch (e2) { }

    return null;
}

function loadedKeySignatureElementHasCustomApi(element) {
    try {
        return !!(element && typeof element.setCustomKeySymbols == 'function');
    } catch (e) {
        return false;
    }
}

function loadedKeySignatureEntriesFromCustomSymbols(customSymbols, cursor, staff) {
    if (!customSymbols || customSymbols.length === undefined ||
        customSymbols.length == 0)
        return [];

    var entriesByNominal = {};
    for (var i = 0; i < customSymbols.length; i++) {
        var item = customSymbols[i];
        if (!item)
            continue;

        var symbolName = item.symbol;
        if (symbolName === undefined || symbolName === null)
            symbolName = item.sym;
        if (symbolName === undefined || symbolName === null)
            continue;

        var symbolCode = loadedKeySignatureSymbolCodeFromName(symbolName);
        if (symbolCode === null)
            continue;

        var x = parseFloat(item.x);
        var y = parseFloat(item.y);
        if (isNaN(x))
            x = 0;
        if (isNaN(y))
            y = 0;

        var nativeNominal = loadedKeySignatureNativeNominalFromOffsetY(
            y,
            cursor,
            staff
        );
        if (nativeNominal === null)
            continue;

        if (!entriesByNominal[nativeNominal]) {
            entriesByNominal[nativeNominal] = {
                nativeNominal: nativeNominal,
                symbolsWithOrder: [],
                minOffsetX: x
            };
        }

        entriesByNominal[nativeNominal].symbolsWithOrder.push({
            symbolCode: symbolCode,
            offsetX: x
        });
        entriesByNominal[nativeNominal].minOffsetX = Math.min(
            entriesByNominal[nativeNominal].minOffsetX,
            x
        );
    }

    var entries = [];
    for (var key in entriesByNominal) {
        var entry = entriesByNominal[key];
        entry.symbolsWithOrder.sort(function (a, b) {
            return a.offsetX - b.offsetX;
        });

        var symbols = [];
        for (var symbolIdx = 0; symbolIdx < entry.symbolsWithOrder.length; symbolIdx++) {
            symbols.push(entry.symbolsWithOrder[symbolIdx].symbolCode);
        }

        entries.push({
            nativeNominal: entry.nativeNominal,
            symbols: symbols,
            minOffsetX: entry.minOffsetX
        });
    }

    entries.sort(function (a, b) {
        if (a.minOffsetX != b.minOffsetX)
            return a.minOffsetX - b.minOffsetX;
        return a.nativeNominal - b.nativeNominal;
    });

    return entries;
}

function loadedKeySignatureCursorCustomApiEntriesAtCursor(cursor, staff) {
    try {
        if (cursor.keySignatureCustom !== true)
            return [];
    } catch (e) {
        return [];
    }

    try {
        return loadedKeySignatureEntriesFromCustomSymbols(
            cursor.keySignatureCustomSymbols,
            cursor,
            staff
        );
    } catch (e2) {
        return [];
    }
}

function loadedKeySignatureCustomApiEntriesAtCursor(cursor, staff) {
    var keySig = loadedKeySignatureCustomApiElementAtCursor(cursor, staff);
    if (!keySig)
        return [];

    try {
        if (keySig.custom === false)
            return [];
    } catch (e) { }

    var customSymbols;
    try {
        customSymbols = keySig.customSymbols;
    } catch (e2) {
        return [];
    }

    if (!customSymbols || customSymbols.length === undefined ||
        customSymbols.length == 0)
        return [];

    return loadedKeySignatureEntriesFromCustomSymbols(customSymbols, cursor, staff);
}

function loadedKeySignatureVisualSymbolCountAtCursor(cursor, staff) {
    var entries = loadedKeySignatureVisualEntriesAtCursor(cursor, staff);
    var symbolCount = 0;
    for (var i = 0; i < entries.length; i++) {
        symbolCount += entries[i].symbols.length;
    }
    return symbolCount;
}

function loadedKeySignatureKeySigFromVisualEntries(entries, tuningConfig) {
    if (!entries || entries.length == 0)
        return null;
    return nativeNominalKeySignatureEntriesToKeySig(entries, tuningConfig);
}

function loadedKeySignatureEntriesStateKey(kind, cursor, entries) {
    var keySignatureTick = cursor.tick;
    var tickState = cursorNativeKeySignatureTick(cursor);
    if (tickState.hasValue)
        keySignatureTick = tickState.tick;

    return kind + '|' + keySignatureTick + '|' + JSON.stringify(entries);
}

function appendLoadedKeySignatureVisualConfigEvent(configs, cursor, staff, state) {
    var entries = loadedKeySignatureCursorCustomApiEntriesAtCursor(cursor, staff);
    var kind = 'loaded-keysig-native-custom';
    var text = 'loaded custom key signature';
    if (entries.length == 0) {
        entries = loadedKeySignatureCustomApiEntriesAtCursor(cursor, staff);
    }
    if (entries.length == 0) {
        entries = loadedKeySignatureVisualEntriesAtCursor(cursor, staff);
        kind = 'loaded-keysig';
        text = 'loaded key signature visuals';
    }
    if (entries.length == 0)
        return;

    if (state && kind == 'loaded-keysig-native-custom') {
        var stateKey = loadedKeySignatureEntriesStateKey(kind, cursor, entries);
        if (state.hasValue && state.lastValue == stateKey)
            return;
        state.hasValue = true;
        state.lastValue = stateKey;
    }

    var configTick = cursor.tick;
    if (kind == 'loaded-keysig-native-custom') {
        var tickState = cursorNativeKeySignatureTick(cursor);
        if (tickState.hasValue)
            configTick = tickState.tick;
    }

    configs.push({
        kind: kind,
        text: text,
        tick: configTick,
        priority: 40,
        config: function (parms) {
            setCurrentKeySignatureSource(parms, 'native-entries', entries);
        }
    });
}

function hideLoadedKeySignatureAtTarget(cursor, staff, selectedElements, keepElement) {
    for (var i = 0; i < selectedElements.length; i++) {
        if (isKeySignatureElement(selectedElements[i]) &&
            !isSamePluginElement(selectedElements[i], keepElement)) {
            try {
                selectedElements[i].visible = false;
            } catch (e) { }
        }
    }

    if (!cursor.segment)
        return;
    for (var annotationIdx = 0;
        annotationIdx < cursor.segment.annotations.length;
        annotationIdx++) {
        var annotation = cursor.segment.annotations[annotationIdx];
        try {
            if (Math.floor(annotation.track / 4) == staff) {
                if (isLoadedKeySignatureMetadata(annotation)) {
                    annotation.text = '';
                    annotation.visible = false;
                } else if (isLoadedKeySignatureVisual(annotation)) {
                    annotation.visible = false;
                }
            }
        } catch (e2) { }
    }
}

function addLoadedKeySignatureSymbol(cursor, symbolCode, offsetX, offsetY, z,
    tuningConfig) {
    var element = newElement(Element.STAFF_TEXT);
    if (typeof symbolCode == 'string' && symbolCode.charAt(0) == "'") {
        element.text = escapeHTML(symbolCode.slice(1));
        element.fontStyle = tuningConfig.nonBoldTextAccidental ?
            FontStyle.Normal : FontStyle.Bold;
        element.fontSize = ASCII_ACC_FONT_SIZE;
    } else {
        var labels = Lookup.CODE_TO_LABELS[symbolCode];
        if (!labels || labels.length == 0)
            return false;
        element.text = '<sym>' + labels[0] + '</sym>';
        element.fontSize = 20;
        element.fontStyle = FontStyle.Normal;
    }

    cursor.add(element);
    element.autoplace = false;
    element.offsetX = offsetX;
    element.offsetY = offsetY;
    element.z = z;
    return true;
}

function loadedKeySignatureSymbolSpacing(symbolCount) {
    if (!symbolCount || symbolCount <= 1)
        return 1.18;
    if (symbolCount <= 3)
        return 1.12;
    if (symbolCount <= 5)
        return 1.05;
    return 0.98;
}

function loadedKeySignatureRightPad(symbolCount) {
    if (!symbolCount || symbolCount <= 1)
        return 1.35;
    if (symbolCount <= 3)
        return 1.7;
    if (symbolCount <= 5)
        return 2.05;
    return 2.35;
}

function loadedKeySignatureRequiredLeadingSpace(symbolCount) {
    if (!symbolCount || symbolCount <= 0)
        return 0;

    return LOADED_KEY_SIGNATURE_INITIAL_OFFSET_X +
        symbolCount * loadedKeySignatureSymbolSpacing(symbolCount) +
        loadedKeySignatureRightPad(symbolCount);
}

function loadedKeySignatureVisualStartOffsetX(layoutSpace) {
    if (layoutSpace > 0)
        return LOADED_KEY_SIGNATURE_INITIAL_OFFSET_X - layoutSpace;

    return LOADED_KEY_SIGNATURE_INITIAL_OFFSET_X;
}

function isLoadedKeySignatureChordRestElement(element) {
    if (!element)
        return false;

    try {
        if (Element && Element.CHORD !== undefined && element.type == Element.CHORD)
            return true;
    } catch (e) { }

    try {
        if (Element && Element.REST !== undefined && element.type == Element.REST)
            return true;
    } catch (e2) { }

    try {
        var name = String(element.name).toLowerCase();
        return name == 'chord' || name == 'rest' || name == 'mmrest';
    } catch (e3) { }

    return false;
}

function findLoadedKeySignatureLayoutTarget(tick, staff) {
    var best = null;
    var bestSegment = null;
    var bestTick = null;
    var bestVoice = 0;

    for (var voice = 0; voice < 4; voice++) {
        var cursor = _curScore.newCursor();
        setCursorToPosition(cursor, tick, voice, staff);

        var guard = 0;
        while (cursor.segment && cursor.tick < tick && guard++ < 10000) {
            if (!cursor.next())
                break;
        }

        guard = 0;
        while (cursor.segment && guard++ < 10000) {
            if (cursor.element &&
                isLoadedKeySignatureChordRestElement(cursor.element)) {
                if (bestTick === null || cursor.tick < bestTick ||
                    (cursor.tick == bestTick && voice < bestVoice)) {
                    best = cursor.element;
                    bestSegment = cursor.segment;
                    bestTick = cursor.tick;
                    bestVoice = voice;
                }
                break;
            }

            if (!cursor.next())
                break;
        }
    }

    return {
        segment: bestSegment,
        element: best
    };
}

function loadedKeySignatureLeadingSpaceValue(object) {
    if (!object)
        return 0;

    try {
        var value = parseFloat(object.leadingSpace);
        return isNaN(value) ? 0 : value;
    } catch (e) { }

    return 0;
}

function applyLoadedKeySignatureLeadingSpaceToObject(object, requiredSpace,
    previousSpace) {
    if (!object || requiredSpace <= 0)
        return { reserved: false, space: 0 };

    try {
        var currentSpace = loadedKeySignatureLeadingSpaceValue(object);

        if (previousSpace > 0 &&
            Math.abs(currentSpace - previousSpace) <=
            LOADED_KEY_SIGNATURE_LAYOUT_REPLACE_TOLERANCE) {
            object.leadingSpace = requiredSpace;
            return { reserved: true, space: requiredSpace };
        }

        if (currentSpace < requiredSpace) {
            object.leadingSpace = requiredSpace;
            return { reserved: true, space: requiredSpace };
        }

        return { reserved: true, space: currentSpace };
    } catch (e) {
        return { reserved: false, space: 0 };
    }
}

function applyLoadedKeySignatureLeadingSpace(target, requiredSpace, previousSpace) {
    if (!target)
        return { reserved: false, space: 0 };

    var segmentResult = applyLoadedKeySignatureLeadingSpaceToObject(
        target.segment,
        requiredSpace,
        previousSpace
    );
    if (segmentResult.reserved)
        return segmentResult;

    return applyLoadedKeySignatureLeadingSpaceToObject(
        target.element,
        requiredSpace,
        previousSpace
    );
}

function releaseLoadedKeySignatureLeadingSpaceFromObject(object, previousSpace) {
    if (!object || previousSpace <= 0)
        return false;

    try {
        var currentSpace = loadedKeySignatureLeadingSpaceValue(object);
        if (Math.abs(currentSpace - previousSpace) <=
            LOADED_KEY_SIGNATURE_LAYOUT_REPLACE_TOLERANCE) {
            object.leadingSpace = 0;
            return true;
        }
    } catch (e) { }

    return false;
}

function releaseLoadedKeySignatureLayoutSpace(tick, staff, previousSpace) {
    var target = findLoadedKeySignatureLayoutTarget(tick, staff);
    if (!target)
        return false;

    if (releaseLoadedKeySignatureLeadingSpaceFromObject(target.segment, previousSpace))
        return true;

    return releaseLoadedKeySignatureLeadingSpaceFromObject(
        target.element,
        previousSpace
    );
}

function reserveLoadedKeySignatureLayoutSpace(tick, staff, requiredSpace,
    previousSpace) {
    var target = findLoadedKeySignatureLayoutTarget(tick, staff);
    return applyLoadedKeySignatureLeadingSpace(target, requiredSpace, previousSpace);
}

function loadedKeySignatureCanUseCustomKeySigApi(keySignatureData) {
    if (!keySignatureData || !keySignatureData.entries)
        return false;

    for (var entryIdx = 0; entryIdx < keySignatureData.entries.length; entryIdx++) {
        var symbols = keySignatureData.entries[entryIdx].symbols || [];
        for (var symbolIdx = 0; symbolIdx < symbols.length; symbolIdx++) {
            var symbolCode = symbols[symbolIdx];
            if (typeof symbolCode == 'string' && symbolCode.charAt(0) == "'")
                return false;

            var labels = Lookup.CODE_TO_LABELS[symbolCode];
            if (!labels || labels.length == 0)
                return false;
        }
    }

    return true;
}

function loadedKeySignatureCustomKeySigApiSymbols(keySignatureData, cursor, staff) {
    var sequenceKind = loadedKeySignatureSequenceKind(keySignatureData.entries);
    var clefKind = loadedKeySignatureClefKind(cursor, staff);
    var symbolCount = 0;
    for (var countIdx = 0; countIdx < keySignatureData.entries.length; countIdx++) {
        symbolCount += keySignatureData.entries[countIdx].symbols.length;
    }

    var symbols = [];
    var x = 0;
    var spacing = loadedKeySignatureSymbolSpacing(symbolCount);
    for (var entryIdx = 0; entryIdx < keySignatureData.entries.length; entryIdx++) {
        var entry = keySignatureData.entries[entryIdx];
        var y = loadedKeySignatureStaffYFromCustomKeySigApi(
            cursor,
            staff,
            entry.nativeNominal,
            sequenceKind,
            entryIdx
        );
        if (y === null) {
            y = loadedKeySignatureStaffY(
                entry.nativeNominal,
                sequenceKind,
                clefKind,
                entryIdx
            );
        }

        for (var symbolIdx = 0; symbolIdx < entry.symbols.length; symbolIdx++) {
            var labels = Lookup.CODE_TO_LABELS[entry.symbols[symbolIdx]];
            symbols.push({
                symbol: labels[0],
                x: x,
                y: y
            });
            x += spacing;
        }
    }

    return symbols;
}

function setLoadedKeySignatureCustomKeySigApiSymbols(keySig, symbols) {
    try {
        if (typeof keySig.setCustomKeySymbols == 'function')
            return keySig.setCustomKeySymbols(symbols) !== false;
    } catch (e) {
        return false;
    }

    return false;
}

function addLoadedKeySignatureToStaffWithCustomKeySigApi(target, staff,
    keySignatureData) {
    if (!loadedKeySignatureCanUseCustomKeySigApi(keySignatureData))
        return { ok: false, unsupported: true };

    var cursor = _curScore.newCursor();
    setCursorToPosition(cursor, target.tick, 0, staff);
    if (!cursor.segment || cursor.tick != target.tick)
        return { ok: false, error: 'Could not place the key signature at tick ' + target.tick + '.' };

    var keySig = loadedKeySignatureCustomApiElementAtCursor(cursor, staff);
    var created = false;
    if (!loadedKeySignatureElementHasCustomApi(keySig)) {
        try {
            keySig = newElement(Element.KEYSIG);
        } catch (e) {
            keySig = null;
        }
        if (!loadedKeySignatureElementHasCustomApi(keySig))
            return { ok: false, unsupported: true };
        created = true;
    }

    var symbols = loadedKeySignatureCustomKeySigApiSymbols(
        keySignatureData,
        cursor,
        staff
    );
    var previousLayoutSpace = loadedKeySignatureRequiredLeadingSpace(
        loadedKeySignatureVisualSymbolCountAtCursor(cursor, staff)
    );

    hideLoadedKeySignatureAtTarget(cursor, staff, target.selectedElements, keySig);
    releaseLoadedKeySignatureLayoutSpace(
        target.tick,
        staff,
        previousLayoutSpace
    );

    if (!setLoadedKeySignatureCustomKeySigApiSymbols(keySig, symbols))
        return { ok: false, error: 'The MuseScore custom key signature API rejected the symbol list.' };

    if (created) {
        cursor.add(keySig);
        if (!setLoadedKeySignatureCustomKeySigApiSymbols(keySig, symbols))
            return { ok: false, error: 'The MuseScore custom key signature API rejected the symbol list after insertion.' };
    }

    try {
        keySig.visible = true;
    } catch (e2) { }

    return { ok: true, usedCustomKeySigApi: true };
}

function addLoadedKeySignatureToStaff(target, staff, keySignatureData, tuningConfig) {
    var customApiResult = addLoadedKeySignatureToStaffWithCustomKeySigApi(
        target,
        staff,
        keySignatureData
    );
    if (customApiResult.ok || !customApiResult.unsupported)
        return customApiResult;

    var cursor = _curScore.newCursor();
    setCursorToPosition(cursor, target.tick, 0, staff);
    if (!cursor.segment || cursor.tick != target.tick)
        return { ok: false, error: 'Could not place the key signature at tick ' + target.tick + '.' };

    var previousLayoutSpace = loadedKeySignatureRequiredLeadingSpace(
        loadedKeySignatureVisualSymbolCountAtCursor(cursor, staff)
    );
    hideLoadedKeySignatureAtTarget(cursor, staff, target.selectedElements);

    var sequenceKind = loadedKeySignatureSequenceKind(keySignatureData.entries);
    var clefKind = loadedKeySignatureClefKind(cursor, staff);
    var symbolCount = 0;
    for (var countIdx = 0; countIdx < keySignatureData.entries.length; countIdx++) {
        symbolCount += keySignatureData.entries[countIdx].symbols.length;
    }
    var layoutResult = reserveLoadedKeySignatureLayoutSpace(
        target.tick,
        staff,
        loadedKeySignatureRequiredLeadingSpace(symbolCount),
        previousLayoutSpace
    );
    var offsetX = loadedKeySignatureVisualStartOffsetX(layoutResult.space);
    var symbolSpacing = loadedKeySignatureSymbolSpacing(symbolCount);

    for (var entryIdx = 0; entryIdx < keySignatureData.entries.length; entryIdx++) {
        var entry = keySignatureData.entries[entryIdx];
        var offsetY = loadedKeySignatureStaffY(
            entry.nativeNominal,
            sequenceKind,
            clefKind,
            entryIdx
        );
        for (var symbolIdx = 0; symbolIdx < entry.symbols.length; symbolIdx++) {
            if (addLoadedKeySignatureSymbol(
                cursor,
                entry.symbols[symbolIdx],
                offsetX,
                offsetY,
                loadedKeySignatureVisualZ(entry.nativeNominal, symbolIdx),
                tuningConfig
            )) {
                offsetX += symbolSpacing;
            }
        }
    }

    return { ok: true };
}

function compensateLoadedKeySignatureNotes(staffInfo, scoreContext) {
    var configs = scoreContext.staffConfigs[staffInfo.staff];
    var bars = scoreContext.bars;
    var snapshots = staffInfo.snapshots;
    var cursor = _curScore.newCursor();
    var parms = {};
    resetParms(parms);
    parms.staffConfigs = scoreContext.staffConfigs;
    parms.bars = bars;
    var nextConfigIdx = 0;
    var adjusted = 0;

    for (var i = 0; i < snapshots.length; i++) {
        var snapshot = snapshots[i];
        nextConfigIdx = applyConfigsUpTo(configs, parms, snapshot.tick, nextConfigIdx);
        setCursorToPosition(cursor, snapshot.tick, snapshot.voice, snapshot.staff);
        var boundaries = getBarBoundaries(snapshot.tick, bars, false);
        var noteData = readNoteData(
            tokenizeNote(snapshot.note),
            parms.currTuning,
            parms.currKeySig,
            boundaries[0],
            boundaries[1],
            cursor,
            null
        );
        if (!noteData)
            continue;

        var newCents = calcCentsOffset(noteData, parms.currTuning, true);
        if (Math.abs(newCents - snapshot.oldCents) > ENHARMONIC_EQUIVALENT_THRESHOLD) {
            var desiredSymbols = snapshot.oldSymbols.length == 0 ?
                [2] : snapshot.oldSymbols;
            setAccidental(
                snapshot.note,
                desiredSymbols,
                newElement,
                parms.currTuning
            );
            adjusted++;
        }

        tuneNote(
            snapshot.note,
            parms.currKeySig,
            parms.currTuning,
            boundaries[0],
            boundaries[1],
            cursor,
            null,
            newElement
        );
    }

    var cleanupEndTick = Math.max(staffInfo.startTick, staffInfo.endTick - 1);
    cursor.staffIdx = staffInfo.staff;
    removeUnnecessaryAccidentals(
        staffInfo.startTick,
        cleanupEndTick,
        parms,
        cursor,
        newElement
    );
    autoPositionAccidentals(
        staffInfo.startTick,
        cleanupEndTick,
        parms,
        cursor
    );
    return adjusted;
}

/**
 * Load, draw, and apply a key signature JSON file at the current selection.
 *
 * @param {string} jsonText
 * @param {string} sourceName
 * @returns {{ok:boolean,message:string}}
 */
function operationLoadKeySignature(jsonText, sourceName) {
    if (!_curScore)
        return { ok: false, message: 'No score is open.' };

    var scoreContext = collectLoadedKeySignatureScoreContext();
    if (scoreContext.bars.length == 0)
        return { ok: false, message: 'The score does not contain any measures.' };

    var target = resolveLoadedKeySignatureTarget(scoreContext.bars);
    if (!target.ok)
        return { ok: false, message: target.error };

    var staffInfos = [];
    for (var staff = target.startStaff; staff <= target.endStaff; staff++) {
        var targetParms = loadedKeySignatureParmsAtTick(
            scoreContext.staffConfigs[staff],
            target.tick
        );
        var keySignatureData = parseKeySignatureJSON(jsonText, targetParms.currTuning);
        if (!keySignatureData.ok)
            return { ok: false, message: keySignatureData.error };

        var endTick = loadedKeySignatureNextChangeTick(
            scoreContext.staffConfigs[staff],
            target.tick
        );
        staffInfos.push({
            staff: staff,
            startTick: target.tick,
            endTick: endTick,
            tuningConfig: targetParms.currTuning,
            keySignatureData: keySignatureData,
            snapshots: collectLoadedKeySignatureSnapshots(
                staff,
                target.tick,
                endTick,
                scoreContext
            )
        });
    }

    var displayName = staffInfos[0].keySignatureData.name;
    logOperation('Load key signature "' + displayName + '" from ' +
        (sourceName || 'JSON file'));
    _curScore.createPlayEvents();
    _curScore.startCmd();
    var adjustedNotes = 0;
    try {
        for (var addIdx = 0; addIdx < staffInfos.length; addIdx++) {
            var staffInfo = staffInfos[addIdx];
            var addResult = addLoadedKeySignatureToStaff(
                target,
                staffInfo.staff,
                staffInfo.keySignatureData,
                staffInfo.tuningConfig
            );
            if (!addResult.ok)
                throw new Error(addResult.error);

            scoreContext.staffConfigs[staffInfo.staff].push(
                loadedKeySignatureConfigEvent(
                    staffInfo.keySignatureData,
                    target.tick
                )
            );
            scoreContext.staffConfigs[staffInfo.staff].sort(sortConfigUpdateEvents);
        }

        for (var compensateIdx = 0; compensateIdx < staffInfos.length; compensateIdx++) {
            adjustedNotes += compensateLoadedKeySignatureNotes(
                staffInfos[compensateIdx],
                scoreContext
            );
        }
    } catch (e) {
        _curScore.endCmd();
        console.error('Failed to load key signature: ' + e);
        return { ok: false, message: 'Failed to load key signature: ' + e };
    }
    _curScore.endCmd();

    var message = 'Loaded key signature "' + displayName + '" at tick ' +
        target.tick + '; adjusted ' + adjustedNotes +
        ' following note' + (adjustedNotes == 1 ? '' : 's') +
        ' to preserve pitch.';
    log(message);
    return { ok: true, message: message };
}
