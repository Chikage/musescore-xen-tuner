// Copyright (C) 2023 euwbah
// This file is part of Xen Tuner. See ../fns.js for license.
// Module: bar state, cursor positioning, accidental lookup, and next-note choice.
/**
 * Finds the tick of the first segment of the bar that 'tick'
 * lives in, and also the first segment of the next bar.
 * 
 * If `tick` is within the last bar of the score,
 * returns `-1` for the next bar tick.
 * 
 * @param {number} tick The tick position to check
 * @param {number[]} bars List of tick positions of each barline. These must be sorted in increasing order.
 * @param {boolean?} returnIndices If `true`, returns indices of the bars array instead of the ticks themselves.
 * @returns {number[]} 
 * `[tickOfThisBar, tickOfNextBar]` or `[currBarIdx, nextBarIdx]`
 */
function getBarBoundaries(tick, bars, returnIndices) {

    if (tick >= bars[bars.length - 1]) {
        return returnIndices ? [bars.length - 1, -1] : [bars[bars.length - 1], -1];
    }

    var guessIdx = Math.floor(bars.length / 2);
    var highGuess = bars.length - 1;
    var lowGuess = 0;
    for (var i = 0; i < bars.length; i++) {
        if (tick >= bars[guessIdx] && tick < bars[guessIdx + 1]) {
            // log('found target bar', guessIdx, bars[guessIdx]);
            return returnIndices ? [guessIdx, guessIdx + 1] : [bars[guessIdx], bars[guessIdx + 1]];
        }
        if (tick < bars[guessIdx]) {
            // log('guess too high: ', guessIdx, bars[guessIdx], lowGuess, highGuess);
            highGuess = guessIdx;
            guessIdx = Math.floor((highGuess + lowGuess) / 2);
        } else {
            // log('guess too low', guessIdx, bars[guessIdx], lowGuess, highGuess);
            lowGuess = guessIdx;
            guessIdx = Math.floor((highGuess + lowGuess) / 2);
        }
    }

    console.error('ERROR: getBarBoundaries() failed to find bar boundaries of tick ' + tick + ' in bars: ' + JSON.stringify(bars));
    return [-1, -1];
}

/**
 * Reads all notes & grace notes of all voices within a bar and
 * in the current staff. Represents them as a `BarState` object.
 * 
 * The current staffIdx of the cursor is used to determine which
 * staff to read from.
 * 
 * This object is useful for traversing all Notes within a bar
 * on a line-by-line (nominal) basis. Useful for checking things
 * like accidental state etc...
 * 
 * Returns cursor to original position after operation.
 * 
 * @param {number} tickOfThisBar Tick of the start of the bar
 * @param {number} tickOfNextBar 
 * @param {Cursor} cursor 
 * @returns {BarState} `BarState` object
 */
function readBarState(tickOfThisBar, tickOfNextBar, cursor) {

    // log('readBarState(' + tickOfThisBar + ', ' + tickOfNextBar + ')');

    var ogCursorPos = saveCursorPosition(cursor);

    if (tickOfNextBar == null || tickOfNextBar == -1) {
        tickOfNextBar = 1e9;
    }

    // Mapping of each line to list of [Note]s in order
    // of appearance.
    var barState = {};

    // Loop all 4 voices to populate notes map

    for (var voice = 0; voice < 4; voice++) {
        setCursorToPosition(cursor, tickOfThisBar, voice, ogCursorPos.staffIdx);

        while (cursor.segment && cursor.tick < tickOfNextBar) {
            if (cursor.element && cursor.element.name == "Chord") {
                var notes = cursor.element.notes;
                var graceChords = cursor.element.graceNotes;
                var currTick = cursor.tick;

                // grace notes come first, add them to list first
                for (var i = 0; i < graceChords.length; i++) {
                    var graceNotes = graceChords[i].notes;

                    // contains mapping of { line: [Note], ... }
                    var notesInCurrChord = {};

                    for (var j = 0; j < graceNotes.length; j++) {
                        var n = graceNotes[j];
                        if (!notesInCurrChord[n.line]) {
                            notesInCurrChord[n.line] = [];
                        }
                        notesInCurrChord[n.line].push(n);
                    }
                    Object.keys(notesInCurrChord).forEach(function (line) {
                        var notes = notesInCurrChord[line];
                        if (!barState[line]) {
                            barState[line] = {};
                        }
                        if (!barState[line][currTick]) {
                            // Init empty lists for each voice
                            barState[line][currTick] =
                                [[], [], [], []];
                        }
                        // add all the notes within the same chord, voice & line
                        // to the lines lookup.
                        barState[line][currTick][voice].push(notes);
                    });
                }

                // Add the final main chord at this tick position.

                // mapping of { line: [Note] }
                var notesInCurrChord = {};

                for (var i = 0; i < notes.length; i++) {
                    var n = notes[i];
                    if (!notesInCurrChord[n.line]) {
                        notesInCurrChord[n.line] = [];
                    }
                    notesInCurrChord[n.line].push(n);
                }
                Object.keys(notesInCurrChord).forEach(function (line) {
                    var notes = notesInCurrChord[line];
                    if (!barState[line]) {
                        barState[line] = {};
                    }
                    if (!barState[line][currTick]) {
                        // Init empty lists for each voice
                        barState[line][currTick] =
                            [[], [], [], []];
                    }
                    // add all the notes within the same chord, voice & line
                    // to the lines lookup.
                    barState[line][currTick][voice].push(notes);
                });
            }

            cursor.next();
        }
    }

    restoreCursorPosition(ogCursorPos);

    return barState;
}

/**
 * Retrieve the next note up/down/enharmonic from the current {@link PluginAPINote}, and
 * returns {@link XenNote} and {@link PluginAPINote.line} offset to be applied on the note.
 * 
 * This function does not read/regard secondary accidentals. The returned {@link NextNote} will
 * not contain any secondary accidentals.
 * 
 * The returned `lineOffset` property represents change in `Note.line`.
 * This is a negated value of the change in nominal ( +pitch = -line )
 * 
 * In up/down mode, the enharmonic spelling is decided with the following rules:
 * 
 * - If the new note has an enharmonic spelling that matches prior accidental state/key signature,
 *   the new note returned will use the enharmonic spelling matching.
 * 
 * - Otherwise, the enharmonic spelling with the smallest accidental vector distance
 *   from the current note's AV (sum of squares) is to be chosen.
 *   This ensures that accidentals used will stay roughly within the same
 *   ball park.
 * 
 * - Otherwise, if two options have very similar {@link AccidentalVector} distances, choose the one with
 *   lesser accidental symbols. This ensures that ligatures will always take effect.
 * 
 * - Otherwise, we should pick the enharmonic spelling that 
 *   minimizes nominal/line offset amount.
 * 
 * - If all else are the same, up should prefer sharp side of acc chains (simply
 *   the sum of all degrees in the vector), and down should prefer flat side.
 * 
 * 
 * A `NextNote.matchPriorAcc` flag will be returned `true` if an enharmonic
 * spelling is found that matches prior accidental state.
 * 
 * @param {number} direction `1` for upwards, `0` for enharmonic cycling, `-1` for downwards.
 * @param {number[]?} constantConstrictions
 *  An optional list of indices of accidental chains specifying the accidental chains
 *  that must maintain at the same degree.
 *  
 *  This is applied for auxiliary up/down function where certain accidental movements
 *  are skipped.
 * 
 *  (Only applicable if direction is `1`/`-1`. Not applicable for enharmonic)
 * 
 * @param {NoteData} noteData parsed note data of the note to be transposed.
 * @param {KeySig} keySig Current key signature
 * @param {TuningConfig} tuningConfig Tuning Config object
 * @param {number} tickOfThisBar Tick of first segment of the bar
 * @param {number} tickOfNextBar Tick of first segment of the next bar, or -1 if last bar.
 * @param {Cursor} cursor MuseScore cursor object
 * @param {BarState} reusedBarState
 * @returns {NextNote?} 
 *  `NextNote` object containing info about how to spell the newly modified note.
 *  Returns `null` if no next note can be found.
 */
function chooseNextNote(direction, constantConstrictions, noteData, keySig,
    tuningConfig, tickOfThisBar, tickOfNextBar, cursor) {

    var note = noteData.ms.internalNote;

    log('Choosing next note for (' + noteData.xen.hash + ', eqv: ' + noteData.equaves + ')');

    if (direction === 0) {
        // enharmonic cycling
        var enharmonicNoteHash = tuningConfig.enharmonics[noteData.xen.hash];

        log('retrieved enharmonicNoteHash: ' + enharmonicNoteHash);

        if (enharmonicNoteHash === undefined) {
            // No enharmonic spelling found. Return null.
            // log(JSON.stringify(tuningConfig.enharmonics));
            return null;
        }

        var enhXenNote = tuningConfig.notesTable[enharmonicNoteHash];

        // Account for equave offset between enharmonic notes.

        // Reminder: equavesAdjusted represents how many equaves has to be added
        // in order to fit the equave-0 spelling of the note within the equave
        // e.g. Ab has to be shifted up 1 equave to fit within the A-G equave range.

        var currNoteEqvsAdj = tuningConfig.tuningTable[noteData.xen.hash][1];
        var enhNoteEqvsAdj = tuningConfig.tuningTable[enharmonicNoteHash][1];
        var equaveOffset = enhNoteEqvsAdj - currNoteEqvsAdj;

        // E.g. if G# and Ab are enharmonics, and G# is the currNote,
        // enhNoteEqvsAdj - currNoteEqvsAdj = 1 - 0 = 1
        // 1 means that, when going from the note G# to Ab, the plugin has to
        // use the Ab that is 1 equave abovet the G#, instead of the Ab that is
        // within the same equave. Otherwise, the Ab would incorrectly be
        // an equave lower than the G#.

        var nominalsOffset = enhXenNote.nominal - noteData.xen.nominal +
            equaveOffset * tuningConfig.numNominals;

        // when cycling enharmonics, do not care about matching the prior accidental spelling
        // (defeats purpose of cycling enharmonics).

        // the only thing to check for is whether or not explicit accidentals should be created
        // for the new note.
        // However, that's NOT the goal of this function. Simply return the new note spelling.

        return {
            xen: enhXenNote,
            nominal: enhXenNote.nominal,
            equaves: noteData.equaves + equaveOffset,
            lineOffset: -nominalsOffset, // negative line = higher pitch.
            matchPriorAcc: false, // always false, doesn't matter.
            // The enharmonic plugin should check for the need of explicit accidentals
            // on its own.
        }
    }


    // Otherwise, it's an up/down operation.

    // The index of the StepwiseList this note is currently at.
    var currStepIdx = tuningConfig.stepsLookup[noteData.xen.hash];

    log('currStepIdx: ' + currStepIdx);

    // If a valid step is found, this will contain list of enharmonically equivalent
    // XenNote.hashes that matches the accidental vector requirements of `regarding`.
    var validOptions = null;

    // If the steps reaches 0 when moving upwards, or last step when moving downwards,
    // this means that an additional equave has to be added/removed.
    // Keep track of this.
    var equaveOffset = 0;

    for (var i = 1; i < tuningConfig.stepsList.length; i++) {
        // Loop through every step within an equave once until an appropriate step is found
        // which differs in accidentalVector according to `regarding`.

        var offset = i;
        if (direction == -1) {
            // reverse search direction if offset negative.
            offset = -i;
        }

        var newStepIdx = mod(currStepIdx + offset, tuningConfig.stepsList.length);

        // These assumes that the equave has positive size.
        // For negative equaves, use the negative value of equaveOffset later.
        if (newStepIdx == 0 && direction == 1) {
            // looped back from end of stepsList. Add an equave.
            equaveOffset++;
        } else if (newStepIdx == tuningConfig.stepsList.length - 1 && direction == -1) {
            // looped back from beginning of stepsList. Remove an equave.
            equaveOffset--;
        }

        // list of xenHashes that are enharmonic to newStep
        var enharmonicOptions = tuningConfig.stepsList[newStepIdx];

        // this map will be populated with enharmonic option hashes
        // that match accidental vector requirements of `regarding`.
        // If a hash maps to 'false', it is invalidated forever.
        // If a hash maps to 'true', it is valid (but further checks can invalidate it)
        var validEnharmonicOptions = {};

        // check for accidental vector requirements according to
        // constantConstrictions

        var currNoteAccVec = tuningConfig.avTable[noteData.xen.hash];

        if (constantConstrictions != null) {
            // Loop each accidental chain to check degree matches one at a time.
            for (var foo = 0; foo < constantConstrictions.length; foo++) {
                // newNote.accVec[accChainIdx] needs to match currNote.accVec[accChainIdx]
                // for it to be considered a valid option for this auxiliary up/down.

                // If referring to accidental chains, these are 1-indexed, subtract 1
                // Otherwise, -1 will represent that nominals should stay unchanged.
                var nomOrAccChainIdx = constantConstrictions[foo] - 1;

                // loop enharmonic spellings at newStepIdx
                for (var j = 0; j < enharmonicOptions.length; j++) {
                    var option = enharmonicOptions[j];

                    // The user enters aux(0,...) to specify that the
                    // nominal should be changed. 
                    // If accChainIdx == -1, this means
                    // 0 was not specified by the user,
                    // so the nominal should not change.

                    if ((nomOrAccChainIdx == -1 && tuningConfig.notesTable[option].nominal != noteData.xen.nominal)
                        || (nomOrAccChainIdx != -1 && tuningConfig.avTable[option][nomOrAccChainIdx] != currNoteAccVec[nomOrAccChainIdx])) {
                        // this enharmonic spelling does not match the requirements. flag as invalid
                        validEnharmonicOptions[option] = false;
                    } else if (validEnharmonicOptions[option] == undefined) {
                        validEnharmonicOptions[option] = true;
                    }
                }
            }
        }

        validOptions = enharmonicOptions.filter(function (opt) {
            return validEnharmonicOptions[opt] == undefined ||
                validEnharmonicOptions[opt] == true;
        });

        if (validOptions.length == 0) continue; // Does not meet `regarding` criteria... try next step

        break;
    }

    if (validOptions == null || validOptions.length == 0) {
        log('WARNING: no valid next note options found for note: ' + noteData.xen.hash +
            '\nDid you declare an invalid tuning system?');
        return null;
    }

    if (tuningConfig.equaveSize < 0) {
        equaveOffset = -equaveOffset;
        log('equaveSize < 0, reversing equaveOffset: ' + equaveOffset);
    }

    /** 
     * A list of next note options with pre-calculated metrics.
     * 
     * To be sorted based on the metrics to obtain the best option.
     * 
     * @type {NextNoteOptions} 
     */
    var nextNoteOptions = [];

    for (var i = 0; i < validOptions.length; i++) {
        var option = validOptions[i]; // contains XenNote hash of enharmonic option.

        var newXenNote = tuningConfig.notesTable[option];

        var newNoteEqvsAdj = tuningConfig.tuningTable[option][1];
        var currNoteEqvsAdj = tuningConfig.tuningTable[noteData.xen.hash][1];

        var totalEqvOffset = newNoteEqvsAdj - currNoteEqvsAdj + equaveOffset;

        var nominalOffset = newXenNote.nominal - noteData.xen.nominal +
            totalEqvOffset * tuningConfig.numNominals;

        var nextNoteObj = {
            xen: newXenNote,
            nominal: newXenNote.nominal,
            equaves: noteData.equaves + totalEqvOffset,
            lineOffset: -nominalOffset,
            matchPriorAcc: false
        };

        // check each option to see if it would match a prior accidental
        // on the new line. An AccidentalVector match is considered a match,
        // The `regarding` constriction is not so strict to the point where
        // enharmonics based on prior existing accidentals are disallowed.

        var priorAcc = getAccidental(
            cursor, note, tickOfThisBar, tickOfNextBar, 2,
            note.line - nominalOffset, null, tuningConfig);

        if (priorAcc == null) {
            priorAcc = cursorKeySignatureAccidentalHashAtLine(
                cursor, note.line - nominalOffset, noteData.ms.tick,
                Math.floor(note.track / 4), tuningConfig);
        }

        if (priorAcc == null && keySig) {
            var keySigAcc = keySig[newXenNote.nominal];
            if (keySigAcc != null && keySig.length == tuningConfig.numNominals) {
                priorAcc = keySigAcc;
            }
        }

        priorAcc = removeUnusedSymbols(priorAcc, tuningConfig);
        var priorXenNote = null;
        var priorAV = null;
        if (priorAcc != null) {
            var priorPrimaryAcc = primaryAccidentalHash(
                priorAcc,
                tuningConfig
            );
            if (priorPrimaryAcc != null) {
                var priorXenHash = newXenNote.nominal + ' ' + priorPrimaryAcc;
                priorXenNote = tuningConfig.notesTable[priorXenHash];
                if (priorXenNote != null)
                    priorAV = tuningConfig.avTable[priorXenNote.hash];
            }
        }

        var optionAV = tuningConfig.avTable[option];

        if (priorAV != null && arraysEqual(optionAV, priorAV)) {
            // Direct accidental match. Return this.
            nextNoteObj.matchPriorAcc = true;

            // Having the same accidental vector as the prior accidental
            // doesn't necessarily mean it's the exact same symbols.
            // Make sure we use the exact same symbols as the prior accidental,
            // but retain the target nominal selected for this enharmonic option.
            nextNoteObj.xen = priorXenNote;
            return nextNoteObj;
        } else if (priorAV == null && option.split(' ').length == 1) {
            // If there's no prior accidental nor key signature accidental on this line,
            // and a note can be represented as a nominal, use the nominal.
            // This avoids unnecessary enharmonics.

            nextNoteObj.matchPriorAcc = true;
            return nextNoteObj;
        }

        // If no immediate match found, calculate metrics and
        // add this to the list of options to be sorted.

        // square distance between prior acc state and this option
        var avDist = 0;
        // absolute square distance between nominal/natural/origin and this option
        var absAvDist = 0;

        for (var j = 0; j < optionAV.length; j++) {
            absAvDist += optionAV[j] * optionAV[j];

            if (priorAV != null) {
                avDist += (priorAV[j] - optionAV[j]) * (priorAV[j] - optionAV[j]);
            } else {
                avDist = absAvDist;
            }
        }

        var sumOfDeg = optionAV.reduce(function (acc, deg) {
            return acc + deg;
        }, 0);

        nextNoteOptions.push({
            nextNote: nextNoteObj,
            avDist: avDist,
            absAvDist: absAvDist,
            numSymbols: newXenNote.orderedSymbols.length,
            lineOffset: -nominalOffset,
            sumOfDegree: sumOfDeg
        });
    }

    /**
     * Returns true if the line offset of the next note option
     * matches the operation direction.
     * 
     * Staying on the same line is also considered 'matching direction'.
     * 
     * If negative equave the preferred direction is reversed.
     * @returns {boolean} `true` if matches direction
     */
    function matchesDirection(lineOffset) {
        var up = tuningConfig.equaveSize > 0 ? direction > 0 : direction < 0;
        return up ? lineOffset <= 0 : lineOffset >= 0;
    }

    /**
     * 
     * @param {NextNoteOption} a 
     * @param {NextNoteOption} b 
     * @param {boolean} debug set to `true` to print why a note was picked over the other.
     * @returns 
     */
    var nextNoteSortFn = function (a, b, debug) {
        var dlog = debug ? function (sortDirection, str) {
            var first = sortDirection <= 0 ? a.nextNote.xen.hash : b.nextNote.xen.hash;
            var second = sortDirection <= 0 ? b.nextNote.xen.hash : a.nextNote.xen.hash;
            if (sortDirection == 0) {
                log('No preference between ' + first + ' and ' + second);
                return 0;
            }
            log('picked ' + first + ' over ' + second + ' because: ' + str);
            return sortDirection;
        } : function (sortDirection, str) {
            return sortDirection;
        };

        // Important ligatures should be preferred
        if (a.nextNote.xen.hasImportantLigature && !b.nextNote.xen.hasImportantLigature) {
            return dlog(-1, 'important ligature');
        } else if (!a.nextNote.xen.hasImportantLigature && b.nextNote.xen.hasImportantLigature) {
            return dlog(1, 'important ligature');
        }

        // Strong ligatures should be preferred
        if (a.nextNote.xen.hasLigaturePriority && !b.nextNote.xen.hasLigaturePriority) {
            return dlog(-1, 'strong ligature');
        } else if (!a.nextNote.xen.hasLigaturePriority && b.nextNote.xen.hasLigaturePriority) {
            return dlog(1, 'strong ligature');
        }

        var aMatchDir = matchesDirection(a.lineOffset);
        var bMatchDir = matchesDirection(b.lineOffset);

        // Prefer line offset matching the direction of transpose
        if (aMatchDir && !bMatchDir) {
            return dlog(-1, 'line offset matches direction');
        } else if (!aMatchDir && bMatchDir) {
            return dlog(1, 'line offset matches direction');
        }

        // choose the one with lesser line offset
        if (Math.abs(a.lineOffset) < Math.abs(b.lineOffset)) {
            return dlog(-1, 'line offset');
        } else if (Math.abs(a.lineOffset) > Math.abs(b.lineOffset)) {
            return dlog(1, 'line offset');
        }

        // Lower AV Dist is better. Give leeway for
        // 'similar' AV dist.
        if (a.avDist - b.avDist <= -0.7) {
            return dlog(-1, 'relative AV dist ' + a.avDist + ' vs ' + b.avDist);
        } else if (a.avDist - b.avDist >= 0.7) {
            return dlog(1, 'relative AV dist ' + b.avDist + ' vs ' + a.avDist);
        }

        // Lower absolute AV dist (less accidental degrees) preferred
        if (a.absAvDist - b.absAvDist <= -0.3) {
            return dlog(-1, 'absolute AV dist ' + a.absAvDist + ' vs ' + b.absAvDist);
        } else if (a.absAvDist - b.absAvDist >= 0.3) {
            return dlog(1, 'absolute AV dist ' + b.absAvDist + ' vs ' + a.absAvDist);
        }

        // Choose the one with lesser symbols
        if (a.numSymbols < b.numSymbols) {
            return dlog(-1, 'lesser symbols: ' + a.numSymbols + ' vs ' + b.numSymbols);
        } else if (a.numSymbols > b.numSymbols) {
            return dlog(1, 'lesser symbols: ' + b.numSymbols + ' vs ' + a.numSymbols);
        }

        // Line offset similar, choose the one with sumOfDegree
        // that matches the direction of transpose.
        //
        // Up should favor upward accidentals (sharps)
        if ((a.sumOfDegree > b.sumOfDegree && direction == 1) ||
            (a.sumOfDegree < b.sumOfDegree && direction == -1)) {
            return dlog(-1, 'sum of degree matches direction: ' + a.sumOfDegree + ' vs ' + b.sumOfDegree);
        } else if ((a.sumOfDegree < b.sumOfDegree && direction == 1) ||
            (a.sumOfDegree > b.sumOfDegree && direction == -1)) {
            return dlog(1, 'sum of degree matches direction: ' + b.sumOfDegree + ' vs ' + a.sumOfDegree);
        }

        return dlog(0, '');
    }

    // Sort them such that the best option is at the front
    // The sorting precedence & preference is as declared in order:
    nextNoteOptions.sort(function (a, b) {
        var sortOutcome = nextNoteSortFn(a, b, false);

        return sortOutcome;
    });

    // debug log why this option was chosen over the others.
    // TODO: comment this out when note choices are optimal & thoroughly tested.
    for (var i = 1; i < nextNoteOptions.length; i++) {
        nextNoteSortFn(nextNoteOptions[0], nextNoteOptions[i], true);
    }

    return nextNoteOptions[0].nextNote;
}

/**
 * Move the cursor to a specified position.
 * 
 * If the cursor cannot move exactly to the specified position,
 * i.e. the selected `voice` does not have any element at specified
 * `tick` position, then the cursor position will be set to
 * the nearest element to the **LEFT** of specified `tick`.
 * 
 * @param {Cursor} cursor MuseScore cursor object
 * @param {number} tick Tick to move cursor to
 * @param {number} voice Voice to move cursor to
 * @param {number} staffIdx staff index to move cursor to
 */
function setCursorToPosition(cursor, tick, voice, staffIdx) {
    cursor.rewind(1);
    cursor.voice = voice;
    cursor.staffIdx = staffIdx;

    if (voice < 0 || voice > 3) {
        console.error("FATAL ERROR: setCursorToPosition voice out of range: " + voice);
        return;
    }

    if (staffIdx < 0 || (cursor.score && staffIdx >= cursor.score.nstaves)) {
        console.error("FATAL ERROR: setCursorToPosition staffIdx out of range: " + staffIdx);
        return;
    }

    cursor.rewindToTick(tick);

    if (cursor.tick != tick) {
        // This happens very frequently because the position to move to
        // may not contain any elements (e.g. voices 2, 3 and 4 are usually mostly blank).
        //
        // In these cases, the cursor will not move to the 'correct' location, but it is
        // fine since there is nothing to check anyways.
        // log('WARN: didn\'t set Cursor correctly (This is fine if voice/staff is blank).\n' +
        //     'requested: ' + tick + ', got t|v: ' + cursor.tick + ' cursor.voice: ' + cursor.voice);
    }
}

/**
 * Returns a SavedCursorPosition to be fed into {@link restoreCursorPosition()}.
 * 
 * @returns {SavedCursorPosition}
 */
function saveCursorPosition(cursor) {
    return { // SavedCursorPosition
        tick: cursor.tick,
        staffIdx: cursor.staffIdx,
        voice: cursor.voice,
        cursor: cursor
    }
}

/**
 * Restores cursor positioned to the saved position.
 * 
 * @param {SavedCursorPosition} savedPosition SavedCursorPosition object
 */
function restoreCursorPosition(savedPosition) {
    setCursorToPosition(savedPosition.cursor, savedPosition.tick, savedPosition.voice, savedPosition.staffIdx);
}

/**
 * 
 * Retrieves the effective accidental applied to the note.
 * 
 * If natural or no accidental to be applied, will return `null`.
 * 
 * If `before` is true, does not include accidentals attached to the current note 
 * in the search.
 * 
 * This function DOES NOT read MuseScore accidentals. Due to how
 * score data is exposed to the plugins API, it is not possible to
 * reliably determine accidentals when MS accidentals and SMuFL-only symbols
 * are used interchangeably.
 * 
 * Thus, only SMuFL symbols ("Symbols" category in the Master Palette)
 * are supported.
 * 
 * @param {Cursor} cursor MuseScore Cursor object
 * @param {PluginAPINote} note The note to check the accidental of.
 * @param {number} tickOfThisBar Tick of the first segment of the bar to check accidentals in
 * @param {number} tickOfNextBar Tick of first seg of next bar, or -1 if its the last bar.
 * @param {0|1|2|null} exclude
 *  If `0` or falsey, include accidentals attached to the current operating `note`.
 * 
 *  If `1` ignore accidentals attached to the current `note`
 *  and only look for accidentals that are considered to appear 
 *  'before' `note`.
 * 
 *  If `2`, ignore any accidentals from any note that belongs to the same chord
 *  as `note`.
 * 
 *  The search will still return accidentals on prior notes in the same
 *  chord, or in a prior grace chord.
 * @param {number?} lineOverride 
 *  If `lineOverride` specified, reads accidentals on this line instead of
 *  the line of the `note` parameter.
 *  
 *  If `lineOverride` is different than the original `note.line`,
 *  `exclude=2` will be used, no matter what it was set to.
 * 
 *  TODO: Check if this may cause any problems.
 * @param {BarState?} reusedBarState
 *  If an empty object is provided, a shallow copy of the read bar state
 *  will be stored in this object.
 *  
 *  If the same bar is being read again, and nothing has changed in
 *  the bar, this object can be passed back to this function to reuse the bar state,
 *  so that it doesn't need to repeat `readBarState`.
 * 
 * @param {TuningConfig?} tuningConfig
 *  Active tuning used to decide whether plugin-attached symbols belong to
 *  the notation. If they do not, MuseScore's native accidental is used.
 *
 * @returns {string?} 
 *  If an accidental is found, returns the accidental hash of the
 *  {@link AccidentalSymbols} object. 
 *  
 *  If no accidentals found, returns null.
 */
function getAccidental(cursor, note, tickOfThisBar,
    tickOfNextBar, exclude, lineOverride, reusedBarState, tuningConfig) {

    var nTick = getTick(note);
    var nLine = isNullish(lineOverride) ? note.line : lineOverride;

    // log("getAccidental() tick: " + nTick + " (within " + tickOfThisBar + " - " 
    //     + tickOfNextBar + "), line: " + nLine);

    if ((tickOfNextBar != -1 && nTick > tickOfNextBar) || nTick < tickOfThisBar) {
        console.error("FATAL ERROR: getAccidental() tick " + nTick +
            " not within given bar ticks: " + tickOfThisBar + " to " + tickOfNextBar);
        return null;
    }

    var barState;
    if (reusedBarState && Object.keys(reusedBarState).length != 0) {
        barState = reusedBarState;
    } else {
        barState = readBarState(tickOfThisBar, tickOfNextBar, cursor);
        if (reusedBarState) {
            // if empty reusedBarState provided, populate it with the generated
            // bar state.

            // TODO: If lagging, check if for-in is more performant for QJS engine.
            for (var key in barState) {
                reusedBarState[key] = barState[key];
            }
        }
    }

    var lineState = barState[nLine];

    if (!lineState) {
        // Nothing on this line. Return null.
        return null;
    }

    // METHOD: Traverse notes in line in reverse order.
    // 
    // Find the first note with an explicit accidental that is
    // closest to the currentOperatingNote.

    // contains ticks of chords on line sorted from right-to-left.
    var lineTicks = Object.keys(lineState).sort(
        function (a, b) {
            return parseInt(b) - parseInt(a);
        }
    );

    for (var tIdx = 0; tIdx < lineTicks.length; tIdx++) {
        var currTick = lineTicks[tIdx];
        // log('tick: ' + currTick);
        if (currTick > nTick) {
            // Accidentals cannot possibly affect a previous note.
            // skip.
            continue;
        }

        // loop each voice from back to front.
        // Remember, every chord here is registered with the same tick!
        for (var voice = 3; voice >= 0; voice--) {
            if (currTick == nTick && voice > note.voice) {
                // E.g.: Within the same tick, voice 2's accidental 
                //       cannot carry over to voice 1
                continue;
            }

            var chords = lineState[currTick][voice];

            // If we're at the same tick & voice as the note in question,
            // we need to make sure that only accidentals from prior chords
            // can affect this note.
            var chdIdxOfNote = -1;

            // If we're in the same chord as the note in question,
            // we need to make sure that only lower-indexed notes
            // can affect this note.
            var nIdxOfNote = -1;

            // loop chords back to front. (start from main chord, then
            // proceeds to grace chords).
            for (var chdIdx = chords.length - 1; chdIdx >= 0; chdIdx--) {
                var chd = chords[chdIdx];

                if (currTick == nTick && voice == note.voice) {
                    // We need to make sure that the curr chord not after
                    // the note in question.

                    if (chdIdxOfNote == -1) {
                        // We haven't found the chdIdx of the note yet...

                        for (var nIdx = chd.length - 1; nIdx >= 0; nIdx--) {
                            var currNote = chd[nIdx];

                            if (currNote.is(note)) {
                                chdIdxOfNote = chdIdx;
                                nIdxOfNote = nIdx;
                                break;
                            }
                        }

                        // If we still haven't found the chord this note belongs to,
                        // we cannot proceed, because we're traversing backwards
                        // and a future accidental cannot affect a previous note.
                        if (chdIdxOfNote == -1) {
                            // log('skip chd. chdIdx: ' + chdIdx);
                            continue; // go to previous chdIdx
                        }
                    }

                    // We also need to make sure that if we're excluding accidentals
                    // from the same chord entirely, we make sure that we skip
                    // this chd if the note belongs to it.

                    if (exclude == 2 && chdIdx == chdIdxOfNote) {
                        continue;
                    }

                    // otherwise, we can proceed knowing that we're traversing a chord
                    // that could affect the note's effective accidental.
                }

                // loop notes back to front.
                for (var nIdx = chd.length - 1; nIdx >= 0; nIdx--) {
                    if (currTick == nTick && voice == note.voice && chdIdx == chdIdxOfNote) {
                        if (nIdx > nIdxOfNote || (exclude == 1 && nIdx == nIdxOfNote)) {
                            // If we're traversing the same chord as the note in question,
                            // We need to make sure that only prior-indexed notes can affect
                            // the note in question,
                            //
                            // and check that we exclude the note itself if required.
                            // log('skipped: nIdx: ' + nIdx + ', nIdxOfNote: ' + nIdxOfNote);
                            continue;
                        }
                    }
                    var currNote = chd[nIdx];

                    var msNote = tokenizeNote(currNote);
                    var accHash = effectiveAccidentalHash(msNote, tuningConfig);

                    if (accHash) {
                        // we found the first explicit accidental! return it!
                        log('Found accidental (' + accHash + ') at: t: ' +
                            currTick + ', v: ' + voice + ', chd: ' + chdIdx + ', n: ' + nIdx);

                        return accHash;
                    }
                } // end of note loop
            }// end of chord loop
        }// end of voice loop
    }// end of ticks loop

    // By the end of everything, if we still haven't found any explicit accidental,
    // return nothing.

    return null;
}
