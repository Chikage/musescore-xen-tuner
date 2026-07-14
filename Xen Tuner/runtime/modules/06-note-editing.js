// Copyright (C) 2023 euwbah
// This file is part of Xen Tuner. See ../fns.js for license.
// Module: accidental mutation, explicit accidental propagation, transposition, and cleanup.
/**
 * Attach given {@link SymbolCode}s to a note (clears existing accidentals),
 * clearing prior accidentals.
 * 
 * Assigns z-index (stacking order) from 1000 onwards, acting as
 * metadata which the layout algorithm will use to maintain the
 * correct right-to-left order of the accidental symbols if
 * multiple-symbol accidentals are used.
 * 
 * The higher z-index = further to the left (1000 is to the right of 1001)
 * 
 * This function does not handle layout of accidentals.
 * 
 * Layout is only done after a whole chord is processed,
 * and is performed for all 4 voices at the same time.
 * 
 * @param {PluginAPINote} note `PluginAPI::Note`
 * @param {SymbolCode[]?} orderedSymbols 
 *  A list of `SymbolCode`s representing accidental symbols in left-to-right order.
 * 
 *  `null` or `[]` to remove all accidentals.
 * @param {newElement} newElement reference to the `PluginAPI.newElement()` function
 * @param {TuningConfig} tuningConfig
 *  If provided, any accidentals symbols that are not included in the tuning config
 *  will not be altered/removed by this function.
 */
function setAccidental(note, orderedSymbols, newElement, tuningConfig) {

    var elements = note.elements;
    var elemsToRemove = [];
    var nativeAccidentalCode = nativeAccidentalSymbolCode(note);

    // First, remove any accidental symbols from note.

    for (var i = 0; i < elements.length; i++) {
        if (elements[i].symbol) {
            var symCode = nativeAccidentalLabelToSymbolCode(elements[i].symbol);
            var isPluginOwnedSymbol = elements[i].z >= 1000 &&
                elements[i].z < 2000;
            if (isPluginOwnedSymbol || !tuningConfig ||
                tuningConfigUsesAccidentalSymbol(tuningConfig, symCode)) {
                // This element is an accidental symbol, remove it.
                elemsToRemove.push(elements[i]);
            }
        } else if (elements[i].name == 'Fingering') {
            if (elements[i].z >= 1000 && elements[i].z < 2000) {
                // This fingering is an accidental symbol, remove it.
                elemsToRemove.push(elements[i]);
            }
        }
    }

    elemsToRemove.forEach(function (elem) {
        note.remove(elem);
    });

    if (!orderedSymbols || orderedSymbols.length == 0) {
        if (elemsToRemove.length > 0 || !tuningConfig ||
            tuningConfigUsesAccidentalSymbol(tuningConfig, nativeAccidentalCode)) {
            clearMuseScoreNativeAccidental(note);
        }
        return;
    }

    // Prefer MuseScore's native accidental element whenever the requested
    // spelling is exactly one supported SMuFL accidental. This gives native
    // layout, accidental carry, selection, import/export and enharmonic
    // behavior while retaining plugin Symbols for compound/ASCII spellings.
    if (orderedSymbols.length == 1 &&
        setMuseScoreNativeAccidentalSymbol(note, orderedSymbols[0])) {
        return;
    }

    // A compound/plugin accidental replaces the native accidental rather than
    // stacking on top of it. Its symbols below become the sole explicit state.
    clearMuseScoreNativeAccidental(note);

    // Create new SymId symbols and attach to note.
    var zIdx = 1000;
    // go right-to-left.
    for (var i = orderedSymbols.length - 1; i >= 0; i--) {
        /** @type {PluginAPIElement} */
        var elem;
        var symCode = orderedSymbols[i];
        if (typeof (symCode) == 'string' && symCode[0] == "'") {
            // Create a fingering accidental
            elem = newElement(Element.FINGERING);
            note.add(elem);
            elem.text = escapeHTML(symCode.slice(1));
            /*  Autoplace is required for this accidental to push back prior
                segments. */
            elem.autoplace = true;
            elem.align = Align.LEFT | Align.VCENTER;
            elem.fontStyle = tuningConfig.nonBoldTextAccidental ?
                FontStyle.Normal : FontStyle.Bold;
            elem.fontSize = ASCII_ACC_FONT_SIZE;
            /*  Set offsetY to some random number to re-trigger vertical align later.
                Otherwise, the fingering will be auto-placed above the notehead, even though
                offsetY is set to 0. */
            elem.offsetY = -3;
            elem.z = zIdx;
        } else {
            // Create a SMuFL symbol accidental
            var symId = Lookup.CODE_TO_LABELS[symCode][0];
            var elem = newElement(Element.SYMBOL);
            elem.symbol = SymId[symId];
            note.add(elem);
            elem.z = zIdx;
        }

        // Just put some arbitrary 1.4sp offset
        // between each symbol for now.
        elem.offsetX = -1.4 * (zIdx - 999);

        zIdx++;
    }
}

/**
 * Makes a note's accidentals explicit.
 * 
 * @param {PluginAPINote} note 
 * @param {TuningConfig} tuningConfig 
 * @param {KeySig} keySig 
 * @param {number} tickOfThisBar 
 * @param {number} tickOfNextBar 
 * @param {*} newElement 
 * @param {Cursor} cursor 
 */
function makeAccidentalsExplicit(note, tuningConfig, keySig, tickOfThisBar, tickOfNextBar, newElement, cursor) {
    var noteData = parseNote(note, tuningConfig, keySig, tickOfThisBar, tickOfNextBar, cursor, newElement);
    var symbols = noteData.secondaryAccSyms.concat(noteData.xen.orderedSymbols);
    log('makeAccidentalsExplicit: ' + JSON.stringify(symbols));
    if (symbols.length != 0) {
        setAccidental(note, symbols, newElement, tuningConfig);
    } else {
        // If no accidentals, also make the natural accidental explicit.
        setAccidental(note, [2], newElement, tuningConfig);
    }
}

/**
 * Modifies accidentals & nominal on a MuseScore note.
 * 
 * @param {PluginAPINote} note `PluginAPI::Note` to set pitch, tuning & accidentals of
 * @param {number} lineOffset Nominals offset from current note's pitch
 * @param {SymbolCode[]} orderedSymbols 
 * Left-to-right ordered {@link SymbolCode}s. Obtained by concatenating
 * {@link NoteData.secondaryAccSyms} and {@link XenNote.orderedSymbols}.
 * @param {*} newElement 
 * @param {TuningConfig} tuningConfig
 */
function modifyNote(note, lineOffset, orderedSymbols, newElement, tuningConfig) {
    log('modifyNote(' + (note.line + lineOffset) + ')');
    var newLine = note.line + lineOffset;

    // This is the easiest hacky solution to move a note's line.

    note.line = newLine;

    note.accidentalType = Accidental.NATURAL;
    note.accidentalType = Accidental.NONE;

    note.line = newLine;

    setAccidental(note, orderedSymbols, newElement, tuningConfig);
}

/**
 * Aggressively applies explicit accidental to ALL notes with the same Note.line 
 * as the current (old) note and the new Note.line of the modified note,
 * whose .tick values match, or come after the current note's .tick value,
 * 
 * This will include grace notes that come before the actual note.
 * 
 * The idea is to brute-force as many explicit accidentals as possible first,
 * then remove unnecessary accidentals later.
 * 
 * @param {PluginAPINote} note Current note being adjusted
 * @param {number} newLine New {@link PluginAPINote.line} of note after adjustment
 * @param {number} noteTick tick of note
 * @param {number} tickOfThisBar 
 * @param {number} tickOfNextBar 
 * @param {TuningConfig} tuningConfig 
 * @param {KeySig} keySig 
 * @param {Cursor} cursor 
 * @param {newElement} newElement 
 */
function forceExplicitAccidentalsAfterNote(
    note, newLine, noteTick, tickOfThisBar, tickOfNextBar,
    tuningConfig, keySig, cursor, newElement
) {

    var ogCursorPos = saveCursorPosition(cursor);

    for (var voice = 0; voice < 4; voice++) {

        setCursorToPosition(cursor, noteTick, voice, ogCursorPos.staffIdx);

        while (cursor.segment && (cursor.tick < tickOfNextBar || tickOfNextBar == -1)) {
            // log('cursor.tick: ' + cursor.tick + ', tickOfNextBar: ' + tickOfNextBar);

            if (!(cursor.element && cursor.element.name == "Chord")) {
                cursor.next();
                continue;
            }

            /** @type {PluginAPIChord} */
            var chord = cursor.element;

            var notes = chord.notes;
            var graceChords = chord.graceNotes;

            for (var i = 0; i < graceChords.length; i++) {
                var graceNotes = graceChords[i].notes;
                for (var j = 0; j < graceNotes.length; j++) {
                    var gnote = graceNotes[j];
                    // We need to ensure that we're not mistakenly setting
                    // an accidental of a note that ties back to the current note.
                    if (!gnote.is(note) && !gnote.firstTiedNote.is(note) &&
                        (gnote.line == note.line || gnote.line == newLine)) {
                        makeAccidentalsExplicit(gnote, tuningConfig, keySig,
                            tickOfThisBar, tickOfNextBar, newElement, cursor);
                    }
                }
            }

            for (var i = 0; i < notes.length; i++) {
                var n = notes[i];
                if (!n.is(note) && !n.firstTiedNote.is(note) &&
                    (n.line == note.line || n.line == newLine)) {
                    makeAccidentalsExplicit(n, tuningConfig, keySig,
                        tickOfThisBar, tickOfNextBar, newElement, cursor);
                }
            }

            cursor.next();
        }
    }

    restoreCursorPosition(ogCursorPos);
}

/**
 * Executes up/down/enharmonic on a note.
 * 
 * **IMPORTANT:**
 * - **The cursor must currently be at the note position**
 * - **In a sequence of tied notes, this function should only be called on
 *   the {@link PluginAPINote.firstTiedNote firstTiedNote}**
 * 
 * <br/>
 * 
 * What it does:
 * - Finds next pitch to transpose to
 * - Aggresively apply explicit accidentals on notes that may be affected by the
 *   modification of the current note.
 * - Modifies pitch & accidental of note. Explicit accidentals are always used.
 * - If tuningConfig has {@link TuningConfig.alwaysExplicitAccidental} `true`, then
 *   sets all tied notes to have the updated explicit accidental.
 * - Tunes the note.
 * 
 * <br/>
 * 
 * This function will create some unnecessary accidentals that should be
 * removed after this bar is processed.
 * 
 * @param {PluginAPINote} note `PluginAPI::Note` object to modify
 * @param {number} direction 1 for up, -1 for down, 0 for enharmonic cycle
 * @param {number?} aux 
 *  The Nth auxiliary operation for up/down operations. If 0/null, defaults
 *  to normal stepwise up/down. Otherwise, the Nth auxiliary operation will
 *  be performed.
 * @param {ConstantConstrictions|Object?} overrideConstantConstrictions
 *  Optional constrictions for panel-triggered operations that are not backed
 *  by a declared aux slot.
 * 
 * @param {Parms} parms Reference to `parms` object.
 * @param {*} newElement Reference to `PluginAPI.newElement()` function
 * @param {Cursor} cursor Cursor object.
 * 
 * @returns {BarState}
 *  Returns an updated `BarState` object which includes changes made to
 *  the newly modified note.
 *  
 *  Use this for layout & formatting purposes so that `BarState` does not
 *  need to be recalculated so often.
 */
function buildSingleAccChainConstrictions(tuningConfig, chainIndex) {
    var constantConstrictions = [];
    var accChainCount = tuningConfig && tuningConfig.accChains ? tuningConfig.accChains.length : 0;

    for (var i = 1; i <= accChainCount; i++) {
        if (i != chainIndex)
            constantConstrictions.push(i);
    }

    if (chainIndex > 0)
        constantConstrictions.push(0);

    return constantConstrictions;
}

function getTransposeConstantConstrictions(tuningConfig, aux, overrideConstantConstrictions) {
    if (overrideConstantConstrictions &&
        overrideConstantConstrictions.singleAccChainIndex !== undefined) {
        return buildSingleAccChainConstrictions(
            tuningConfig,
            overrideConstantConstrictions.singleAccChainIndex
        );
    }

    return overrideConstantConstrictions || tuningConfig.auxList[aux];
}

function executeTranspose(note, direction, aux, parms, newElement, cursor, overrideConstantConstrictions) {
    var tuningConfig = parms.currTuning;
    var keySig = parms.currKeySig; // may be null/invalid
    /** @type {ConstantConstrictions} */
    var constantConstrictions = getTransposeConstantConstrictions(
        tuningConfig,
        aux,
        overrideConstantConstrictions
    ); // may be null/undefined
    var bars = parms.bars;
    var noteTick = getTick(note);

    var barBoundaries = getBarBoundaries(noteTick, bars, false);
    var tickOfThisBar = barBoundaries[0];
    var tickOfNextBar = barBoundaries[1];

    log('executeTranspose(' + direction + ', ' + aux + '). Tick: ' + noteTick);

    var noteData = parseNote(note, tuningConfig, keySig,
        tickOfThisBar, tickOfNextBar, cursor, newElement);

    // STEP 1: Choose the next note.
    var nextNote = chooseNextNote(
        direction, constantConstrictions, noteData,
        keySig, tuningConfig, tickOfThisBar, tickOfNextBar, cursor);

    if (!nextNote) {
        // If no next note (e.g. no enharmonic)
        // simple do nothing, return bar state.
        var newBarState = {};
        tuneNote(note, keySig, tuningConfig, tickOfThisBar, tickOfNextBar, cursor, newBarState, newElement);

        return newBarState;
    }

    // log('nextNote: ' + JSON.stringify(nextNote));

    var newLine = note.line + nextNote.lineOffset;

    // STEP 2: Apply explicit accidentals on notes that may be affected
    //         by the modification process.

    forceExplicitAccidentalsAfterNote(
        note, newLine, noteTick, tickOfThisBar, tickOfNextBar,
        tuningConfig, keySig, cursor, newElement
    );

    //
    // STEP 3
    //
    //

    var accSymbols = nextNote.xen.orderedSymbols;
    var canUseImplicitAccidental = !!nextNote.matchPriorAcc;

    if (!accSymbols || accSymbols.length == 0) {
        // If the nextNote is a nominal, use explicit natural symbol.
        // This may still be cleared below if the current accidental state
        // or key signature already supplies the natural.
        accSymbols = [2];
    }

    // Here we need to check whether or not to include prior secondary
    // accidentals in the new note depending on the operation.

    var isEnharmonic = direction == 0;
    var isDiatonic = !isEnharmonic && constantConstrictions &&
        constantConstrictions.length == tuningConfig.accChains.length && constantConstrictions.indexOf(0) == -1;
    var isNonDiatonicTranspose = !isEnharmonic && !isDiatonic;

    if (KEEP_SECONDARY_ACCIDENTALS_AFTER_DIATONIC && isDiatonic ||
        KEEP_SECONDARY_ACCIDENTALS_AFTER_ENHARMONIC && isEnharmonic ||
        KEEP_SECONDARY_ACCIDENTALS_AFTER_TRANSPOSE && isNonDiatonicTranspose) {

        // We need to keep secondary accidentals.
        // Carry forward secondary symbols and prepend them
        accSymbols = noteData.secondaryAccSyms.concat(accSymbols);
        canUseImplicitAccidental = canUseImplicitAccidental &&
            noteData.secondaryAccSyms.length == 0;
        log('keeping acc symbols: ' + JSON.stringify(accSymbols));
        log('secondary: ' + JSON.stringify(noteData.secondaryAccSyms));
    }

    if (!tuningConfig.alwaysExplicitAccidental && canUseImplicitAccidental) {
        accSymbols = null;
    }

    modifyNote(note, nextNote.lineOffset, accSymbols, newElement, tuningConfig);

    if (tuningConfig.alwaysExplicitAccidental) {
        // if we're in explicit accidentals/atonal mode, make sure that explicit
        // accidentals also appear on all tied notes, and that these accidentals are
        // updated.

        // We don't have to worry about these accidentals affecting subsequent notes
        // in the next bar (if the tie carries over a barline), because we're in
        // atonal/explicit accidental mode.
        var notePointer = note;
        while (notePointer.tieForward) {
            notePointer = notePointer.tieForward.endNote;
            setAccidental(notePointer, accSymbols, newElement, tuningConfig);
        }
    }

    //
    // STEP 4
    //

    var newBarState = {};
    tuneNote(note, keySig, tuningConfig, tickOfThisBar, tickOfNextBar, cursor, newBarState, newElement);

    return newBarState;
}

/**
 * Remove unnecessary accidentals within a staff in selected range of bars.
 * 
 * This function assumes that the accidental state is always valid.
 * 
 * Valid as in: {@link getAccidental()} will always return the correct effective
 * accidental on every single note in this bar.
 * 
 * **IMPORTANT:** {@link Cursor.staffIdx} must be set to the staff to operate on.
 * 
 * @param {number} startBarTick Any tick position within the starting bar (or start of selection)
 * @param {number} endBarTick 
 *  Any tick pos within ending bar (or end of selection).
 *  If -1, performs the operation till the end of the score.
 * @param {Parms} parms Global `parms` object.
 * @param {Cursor} cursor Cursor object
 * @param {newElement} newElement Reference to the `PluginAPI.newElement()` function
 * @param {number?} firstBarTickIndex 
 * Pre-calculated {@link getBarBoundaries} output to reduce repeated computation.
 * If provided, {@link startBarTick} will be ignored.
 * @param {number?} lastBarTickIndex 
 * Pre-calculated {@link getBarBoundaries} output to reduce repeated computation.
 * If provided, {@link endBarTick} will be ignored.
 */
function removeUnnecessaryAccidentals(startBarTick, endBarTick, parms, cursor, newElement, firstBarTickIndex, lastBarTickIndex) {

    var staff = cursor.staffIdx;
    var bars = parms.bars;

    var lastBarTickIndex = isNullish(lastBarTickIndex) ? getBarBoundaries(endBarTick, bars, true)[1] : lastBarTickIndex; // if -1, means its the last bar of score
    var firstBarTickIndex = isNullish(firstBarTickIndex) ? getBarBoundaries(startBarTick, bars, true)[0] : firstBarTickIndex;

    if (lastBarTickIndex == -1)
        lastBarTickIndex = bars.length - 1;

    var tickOfThisBar = bars[firstBarTickIndex];

    log('removeUnnec( from bar ' + firstBarTickIndex + ' (' + tickOfThisBar + ') to ' + lastBarTickIndex + ')');

    // Repeat procedure for 1 bar at a time.

    for (var barIdx = firstBarTickIndex; barIdx <= lastBarTickIndex; barIdx++) {

        /*
        Procedure for each bar:

        1. Generate BarState
        
        2. Iterate the notes of each staff line in order that they should appear
           (remember to sort Object.keys by tick first)

           As it iterates, keep track of accidentals. If no accidental has occured
           yet, defer to the key signature. 
           
           If any accidental is found redundant remove it.
        */


        var tickOfNextBar;
        if (barIdx == bars.length - 1) {
            tickOfNextBar = -1;
        } else {
            tickOfNextBar = bars[barIdx + 1];
        }

        var barState = readBarState(tickOfThisBar, tickOfNextBar, cursor);

        // Mapping of lines to accidental hash
        // If a line has no accidentals thus far, check key signature
        // to see if an accidental is redundant.
        var accidentalState = {};

        var lines = Object.keys(barState);
        var staffConfigs = parms.staffConfigs[staff];

        for (var lineIdx = 0; lineIdx < lines.length; lineIdx++) {
            var lineNum = lines[lineIdx]; // staff line number
            var lineTickVoices = barState[lineNum]; // tick to voices mappings.

            // Each line is traversed independently from left to right, so give
            // it an independent config cursor. This supports tuning/key-signature
            // changes that occur in the middle of a measure.
            /** @type {Parms} */
            var lineParms = {};
            resetParms(lineParms);
            var nextLineConfigIdx = applyConfigsUpTo(
                staffConfigs,
                lineParms,
                tickOfThisBar,
                0
            );

            // Sort ticks in increasing order.
            var ticks = Object.keys(barState[lineNum]).sort(
                function (a, b) {
                    return parseInt(a) - parseInt(b)
                }
            );

            // traversing ticks left to right.
            for (var tickIdx = 0; tickIdx < ticks.length; tickIdx++) {
                var currTick = ticks[tickIdx];
                var previousLineConfigIdx = nextLineConfigIdx;
                nextLineConfigIdx = applyConfigsUpTo(
                    staffConfigs,
                    lineParms,
                    parseInt(currTick),
                    nextLineConfigIdx
                );

                // MuseScore resets accidental carry at a key-signature change.
                // Tuning/reference changes can also reinterpret the same glyph,
                // so do not compare post-change notes with pre-change state.
                for (var appliedConfigIdx = previousLineConfigIdx;
                    appliedConfigIdx < nextLineConfigIdx;
                    appliedConfigIdx++) {
                    var appliedKind = staffConfigs[appliedConfigIdx].kind || '';
                    if (appliedKind == 'tuning' || appliedKind == 'reference' ||
                        appliedKind.indexOf('keysig') != -1) {
                        delete accidentalState[lineNum];
                        break;
                    }
                }

                var tuningConfig = lineParms.currTuning;
                var keySig = lineParms.currKeySig;

                if (tuningConfig.alwaysExplicitAccidental) {
                    // Do not remove accidentals while the active config requests
                    // every accidental to remain explicit.
                    continue;
                }

                // go from voice 1 to 4.
                for (var voice = 0; voice < 4; voice++) {
                    // We are traversing all voices left to right in order,
                    // there is no need to reset accidental state.

                    var chds = lineTickVoices[currTick][voice];

                    // go from leftmost to rightmost chord
                    for (var chdIdx = 0; chdIdx < chds.length; chdIdx++) {
                        /** 
                         * All these notes are on the same line => all have the same nominal.
                         * @type {MSNote[]} 
                         */
                        var msNotes = chds[chdIdx].map(
                            function (note) {
                                return tokenizeNote(note);
                            }
                        );
                        // All these notes have the same nominal.
                        var nominal = getNominal(msNotes[0], tuningConfig);

                        // Before we proceed, make sure that all explicit accidentals 
                        // attached to notes within this same chord & line
                        // are exactly the same.

                        // Note that it is fine for these notes to be
                        // a mix of implicit and explicit accidentals, 
                        // as long as the accidentals are all the same.
                        // In that situation, it is clear that all the notes
                        // are the exact same note.

                        // Of course, people wouldn't write music like that,
                        // but while spamming transpose up/down, it is possible
                        // that such a scenario is reached, and the plugin should
                        // be able to smoothly handle it.

                        var prevExplicitAcc = null;
                        var proceed = true;
                        for (var noteIdx = 0; noteIdx < msNotes.length; noteIdx++) {
                            var accHash = effectiveAccidentalHash(
                                msNotes[noteIdx], tuningConfig) || '';

                            if (accHash != '') {
                                if (prevExplicitAcc == null) {
                                    prevExplicitAcc = accHash;
                                } else if (prevExplicitAcc != accHash) {
                                    // this chord contains notes on the same line
                                    // with different explicit accidentals.
                                    // We should not remove these accidentals.
                                    proceed = false;
                                    break;
                                }
                            }
                        }

                        if (!proceed) continue;

                        for (var noteIdx = 0; noteIdx < msNotes.length; noteIdx++) {
                            var msNote = msNotes[noteIdx];

                            var accHash = effectiveAccidentalHash(
                                msNote, tuningConfig) || '';
                            var accHashWords = accHash.split(' ');
                            var isNatural = accHashWords.length == 2 && accHashWords[0] == '2';

                            if (accHash != '') {
                                // we found an explicit accidental on this note.
                                // check if we really need it or not.

                                var prevExplicitAccHash = accidentalState[lineNum];

                                log('currAccState: ' + prevExplicitAccHash + ', accHash: ' + accHash
                                    + ', keySig: ' + JSON.stringify(keySig) + ', nominal: ' + nominal);

                                var realKeySig = '';

                                if (prevExplicitAccHash && prevExplicitAccHash == accHash) {
                                    // if the exact same accidental hash is found on the
                                    // accidental state and this note, this note's
                                    // accidental is redundant. Remove it.

                                    setAccidental(msNote.internalNote, null, newElement, tuningConfig);
                                    continue;
                                } 
                                
                                if (!prevExplicitAccHash) {
                                    // If no prior accidentals before this note, and
                                    // this note matches KeySig, this note's acc
                                    // is also redundant. Remove.

                                    realKeySig = cursorKeySignatureAccidentalHashAtLine(
                                        cursor, parseInt(lineNum), parseInt(currTick),
                                        staff, tuningConfig) || '';
                                    if (realKeySig == '' && keySig)
                                        realKeySig = removeUnusedSymbols(keySig[nominal], tuningConfig) || '';
                                    log('realKeySig: ' + realKeySig);
                                    if (realKeySig != '' && realKeySig == accHash) {
                                        setAccidental(msNote.internalNote, null, newElement, tuningConfig);
                                        continue;
                                    }
                                } 
                                
                                if (isNatural && !prevExplicitAccHash && realKeySig == '') {
                                    // This note has a natural accidental, but it is not
                                    // needed, since the prior accidental state/key sig is natural.

                                    setAccidental(msNote.internalNote, null, newElement, tuningConfig);
                                    continue;
                                }

                                // Otherwise, if we find an explicit accidental
                                // that is necessary, update the accidental state.

                                accidentalState[lineNum] = accHash;
                                
                            }
                        }
                    }
                }
            }
        }


        // go next bar
        tickOfThisBar = tickOfNextBar;
    }
}
