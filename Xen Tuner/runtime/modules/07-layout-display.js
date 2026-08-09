// Copyright (C) 2023 euwbah
// This file is part of Xen Tuner. See ../fns.js for license.
// Module: accidental auto-positioning and steps/cents display fingerings.
/**
 * Checks if two intervals on a number line overlap/touch
 * each other.
 * 
 * E.g. [1, 3] and [2, 4] overlap, but [1, 2] and [2, 3] do not.
 * 
 * @param {number} a1 Start of first interval
 * @param {number} a2 End of first interval
 * @param {number} b1 Start of second interval
 * @param {number} b2 End of second interval
 * @returns {boolean} `true` if intervals overlap, `false` otherwise.
 */
function intervalOverlap(a1, a2, b1, b2) {
    // log('intervalOverlap(' + a1 + ', ' + a2 + ', ' + b1 + ', ' + b2 + ')');
    return (a1 - b2) * (a2 - b1) <= 0;
}


/**
 * Reads notes in a Bar according to {@link Chords} structure.
 * 
 * Each {@link Chords} object represents the chords (+ grace chords) available
 * at a given tick for all voices.
 * 
 * @param {number} tickOfThisBar
 * @param {number | -1 | null} tickOfNextBar
 * @param {Cursor} cursor MuseScore cursor object
 * 
 * @returns {Object.<number, Chords>} 
 *  A mapping of `Chords` objects indexed by tick position.
 */
function partitionChords(tickOfThisBar, tickOfNextBar, cursor) {
    // log('partitionChords(' + tickOfThisBar + ', ' + tickOfNextBar + ')');

    var ogCursorPos = saveCursorPosition(cursor);

    if (tickOfNextBar == null || tickOfNextBar == -1) {
        tickOfNextBar = 1e9;
    }

    // mapping of ticks to Chords objects.
    /** @type {Object.<number, Chords>} */
    var chordsPerTick = {};

    // Loop all 4 voices to populate notes map

    for (var voice = 0; voice < 4; voice++) {
        setCursorToPosition(cursor, tickOfThisBar, voice, ogCursorPos.staffIdx);

        while (cursor.segment && cursor.tick < tickOfNextBar) {
            if (cursor.element && cursor.element.name == "Chord") {
                var notes = cursor.element.notes;
                var graceChords = cursor.element.graceNotes;
                var currTick = cursor.tick;

                if (!chordsPerTick[currTick]) {
                    chordsPerTick[currTick] = [[], [], [], []];
                }

                // Move right-to-left. Start with the rightmost main chord.

                var listOfNotes = [];
                for (var i = 0; i < notes.length; i++) {
                    listOfNotes.push(notes[i]);
                }
                chordsPerTick[currTick][voice].push(listOfNotes);

                // Then add grace notes to the list in right-to-left order.

                for (var i = graceChords.length - 1; i >= 0; i--) {
                    var graceNotes = graceChords[i].notes;

                    var listOfNotes = [];

                    for (var j = 0; j < graceNotes.length; j++) {
                        listOfNotes.push(graceNotes[j]);
                    }
                    chordsPerTick[currTick][voice].push(listOfNotes);
                }
            }

            cursor.next();
        }
    }

    restoreCursorPosition(ogCursorPos);

    return chordsPerTick;
}

/**
 * Retrieves custom position & size offsets (according to {@link Lookup.SYMBOL_LAYOUT}
 * or {@link Lookup.ASCII_LAYOUT}) of an accidental symbol/fingering element respectively.
 * 
 * @param {PluginAPIElement} elem Symbol or fingering element
 * 
 * @param {boolean} staffLineIntersectsNote
 * `true` if the note is a 'line note' (EGBDF treble clef).
 * 
 * `false` if the note is a 'space note' (FACE treble clef).
 * 
 * @returns {{
 *  additionalXOffset: number,
 *  additionalYOffset: number,
 *  halfAddWidth: number,
 *  halfAddHeight: number
 * }}
 * 
 * `additionalXOffset` and `additionalYOffset` are X and Y position offsets,
 * (X offset will affect push-back of further-left symbols)
 * 
 * `halfAddWidth` and `halfAddHeight` are half the additional width and height
 * specified to apply to the {@link PluginAPIElement.bbox} property, such that
 * the rectangular bounds are expanded centrally (half the additional width/height each).
 * 
 * If no custom offsets are found, all values are 0, signifying no deviation from
 * standard auto-positioning.
 */
function retrieveCustomOffsets(elem, staffLineIntersectsNote) {
    var offsets = {
        additionalXOffset: 0,
        additionalYOffset: 0,
        halfAddWidth: 0,
        halfAddHeight: 0
    };

    var lookupMapping;
    var key;

    if (elem.symbol) {
        lookupMapping = Lookup.SYMBOL_LAYOUT;
        key = musescoreNativeSymbolNameFromValue(elem.symbol);
        if (MUSESCORE_NATIVE_SYMBOL_ALIASES[key] !== undefined)
            key = MUSESCORE_NATIVE_SYMBOL_ALIASES[key];
        else if (MUSESCORE_NATIVE_SYMBOL_ALIASES[String(key).toUpperCase()] !== undefined)
            key = MUSESCORE_NATIVE_SYMBOL_ALIASES[String(key).toUpperCase()];
    } else if (elem.name == 'Fingering') {
        lookupMapping = Lookup.ASCII_LAYOUT;
        key = removeFormattingCode(elem.text);
    } else {
        return offsets;
    }

    var quartupletOffsets = lookupMapping[key] && lookupMapping[key][staffLineIntersectsNote ? 1 : 0];

    if (!quartupletOffsets) {
        return offsets;
    }

    return {
        additionalXOffset: quartupletOffsets[0],
        additionalYOffset: quartupletOffsets[1],
        halfAddWidth: quartupletOffsets[2],
        halfAddHeight: quartupletOffsets[3]
    };
}

/**
 * Positions accidental symbols for all voices' chords that are to be
 * vertically-aligned.
 * 
 * Uses the [zig-zag algorithm](https://musescore.org/en/node/25055) to auto-position symbols.
 * 
 * Also positions text-based accidentals to the left of any other accidental symbols, treating it
 * as if it were an accidental symbol.
 * 
 * returns the largest (negative) distance between the left-most symbol the notehead 
 * it is attached to. This returned value will decide how much should
 * grace chords be pushed back.
 * 
 * **IMPORTANT**: `chord` is NOT the wrapped {@link PluginAPIChord} plugin object.
 * It is a list of unwrapped {@link PluginAPINote} objects!
 * 
 * @param {PluginAPINote[]} chord Notes from all voices at a single tick & vertical-chord position.
 * @param {TuningConfig} tuningConfig
 * @returns {number} most negative distance between left-most symbol and left-most notehead.
 */
function positionAccSymbolsOfChord(chord, tuningConfig) {

    // First, we need to sort the chord by increasing line number. (top-to-bottom)
    chord.sort(function (a, b) { return a.line - b.line });

    // log("chord.length: " + chord.length);
    // chord.forEach(function(n) { log("HALLO: " + Object.keys(n)); });

    // Then, we create two indices, one ascending and one descending.
    // This is to accomplish zigzag pattern.

    var ascIdx = 0;
    var descIdx = chord.length - 1;

    var mostNegativeDistance = 0;

    // zig means use ascending index (top note)
    // zag means use descending index (bottom note)
    var isZig = true;

    // contains absolute bboxes of already positioned elements.
    // this is what we check against to prevent collision within this
    // vertical-stack.

    // This list is to be kept sorted by decreasing x position.
    // (right to left).
    var positionedElemsBbox = [];

    // first we populate the positioned elems with noteheads. The positions
    // of noteheads are all fixed relative to the chord segment.

    chord.forEach(function (note) {
        // log('noteline: ' + note.line);
        positionedElemsBbox.push(
            {
                left: note.pagePos.x + note.bbox.left - ACC_NOTESPACE,
                right: note.pagePos.x + note.bbox.right,
                top: note.pagePos.y + note.bbox.top,
                bottom: note.pagePos.y + note.bbox.bottom
            }
        );
    });

    // then we sort the bboxes by decreasing x position.

    positionedElemsBbox.sort(function (a, b) { return b.left - a.left });

    // stores positions of positioned symbols to be updated all at once at the end.
    /**
     * @type {{
     *  elem: PluginAPIElement,
     *  x: number,
     *  y: number
     * }[]}
     */
    var registeredSymbolOffsets = [];

    var count = 0;
    while (count++ < chord.length) {
        // Iterate notes in chord in zig zag pattern.

        // log(count + ') posElemsBbox: ' + JSON.stringify(positionedElemsBbox.map(function (bbox) {
        //     return bbox.left;
        // })));
        var note = chord[isZig ? ascIdx : descIdx];

        /**
         * If `true`, staff line intersects the notehead (E G B D F treble clef).
         */
        var staffLineIntersectsNote = (note.line % 2 === 0);
        // for some NONSENSE reason, x % 2 == 0 always returns true, but x % 2 === 0 checks isEven.
        // log('staffLineIntersectsNote: ' + staffLineIntersectsNote + ', line: ' + note.line + ', mod 2: ' + (note.line % 2));

        // var absNoteBbox = {
        //     left: note.pagePos.x + note.bbox.left,
        //     right: note.pagePos.x + note.bbox.right,
        //     top: note.pagePos.y + note.bbox.top,
        //     bottom: note.pagePos.y + note.bbox.bottom
        // };

        var accSymbolsRTL = []; // right-to-left

        // We treat all the symbols to be attached as one big symbol with a bounding box
        // that encapsulates all the bounding boxes of the symbols.

        // total amount of sp used by all symbols attached to this notehead.
        var symbolsWidth = 0;
        // top most absolute position of top bbox of symbols
        var symbolsTop = 1e7;
        // bottom most abs pos of bottom bbox of symbols
        var symbolsBottom = -1e7;

        // stores list of all accidental symbols attached to this notehead.
        for (var i = 0; i < note.elements.length; i++) {
            var elem = note.elements[i];
            var isAccSym = false;
            // log(JSON.stringify(elem.bbox));
            if (elem.symbol) {
                var symCode = nativeAccidentalLabelToSymbolCode(elem.symbol);
                if (symCode !== null && (tuningConfig.usedSymbols[symCode]
                    || tuningConfig.usedSecondarySymbols[symCode])) {
                    isAccSym = true;
                }
            } else if (elem.name && elem.name == 'Fingering' &&
                elem.z >= 1000 && elem.z <= 2000) {
                // Found ASCII accidental symbols implemented as fingerings.
                isAccSym = true;
            }

            if (isAccSym) {
                accSymbolsRTL.push(elem);
                var cusOff = retrieveCustomOffsets(elem, staffLineIntersectsNote);

                symbolsWidth += elem.bbox.right - elem.bbox.left + cusOff.halfAddWidth * 2;

                var absTopPos, absBottomPos;
                if (elem.name == 'Fingering') {
                    // When fingerings are just created, they are above the notehead, meaning that
                    // we can't use the current Y position of the fingering to determine
                    // whether it will vertically collide with said note.
                    // Instead, we use the Y positions of the notehead as a guideline.

                    // We assume that the tallest symbol will protrude the notehead height by 
                    // +/- 0.5sp. (pipe symbol |). 
                    // This is a very conservative estimate and may cause wasted space.

                    absTopPos = note.pagePos.y + note.bbox.top - 0.5;
                    absBottomPos = note.pagePos.y + note.bbox.bottom + 0.5;
                } else {
                    absTopPos = elem.pagePos.y + elem.bbox.top;
                    absBottomPos = elem.pagePos.y + elem.bbox.bottom;
                }
                // apply custom offsets
                absTopPos += cusOff.additionalYOffset - cusOff.halfAddHeight;
                absBottomPos += cusOff.additionalYOffset + cusOff.halfAddHeight;

                if (absTopPos < symbolsTop) {
                    symbolsTop = absTopPos;
                }
                if (absBottomPos > symbolsBottom) {
                    symbolsBottom = absBottomPos;
                }
            }
        }

        // Symbols on the right have lower z index.
        accSymbolsRTL.sort(function (a, b) { return a.z - b.z });


        if (accSymbolsRTL.length != 0) {
            // Found acc symbols to position on this note.

            // Now that we have the list of symbols to add to this notehead, 
            // we need to find holes in the positionedElemsBbox list to insert them.

            var prevElemLeft = null;
            for (var i = 0; i < positionedElemsBbox.length; i++) {
                var bbox = positionedElemsBbox[i];
                var willCollideVertically = intervalOverlap(bbox.top, bbox.bottom, symbolsTop, symbolsBottom);

                // log('check bbox: ' + bbox.left + ', willCollideVertically: ' + willCollideVertically);
                if (!willCollideVertically) continue;

                if (prevElemLeft == null) {
                    prevElemLeft = bbox.left;
                    continue;
                }

                var gapWidth = prevElemLeft - bbox.right;

                prevElemLeft = bbox.left; // absolute x left pos of positioned bbox.

                if (gapWidth >= symbolsWidth && prevElemLeft <= note.pagePos.x) {
                    // log('gapWidth: ' + gapWidth + ', symbolsWidth: ' + symbolsWidth + ', prevElemLeft: ' + prevElemLeft + ', note.pagePos.x: ' + note.pagePos.x)
                    // the symbols can be added in this gap.
                    // exit loop. prevElemLeft now contains the absolute position
                    // to put the right most symbol.
                    break;
                }
            }

            // The above loop will stop once a hole has been found, or once
            // all elements have been looped and no holes are found.
            // At this point, prevElemLeft contains the absolute X position that the
            // 'hole' begins and expands leftward, which is the absolute left bbox
            // of the leftmost element before the 'hole' starts.

            // In case none of the symbols vertically intersects with any existing positioned
            // bbox (perhaps this symbol has specific overrides to be positioned atop a notehead),
            // we assume that prevX is 0sp by default.

            if (prevElemLeft == null) {
                console.warn('WARNING: Symbol does not vertically intersect with any positioned elements, setting ' +
                    'x offset to 0.');
            }

            // prevX is the relative offset to assign to the curr symbol.
            var prevX = prevElemLeft != null ? (prevElemLeft - note.pagePos.x) : 0;

            accSymbolsRTL.forEach(function (elem) {
                var cusOff = retrieveCustomOffsets(elem, staffLineIntersectsNote);
                var actualSymWidth = elem.bbox.right - elem.bbox.left;
                var effectiveSymWidth = actualSymWidth + cusOff.halfAddWidth * 2 + ACC_SPACE;
                var spaceCentralizationOffset = cusOff.halfAddWidth;

                if (effectiveSymWidth < MIN_ACC_WIDTH) {
                    spaceCentralizationOffset += (MIN_ACC_WIDTH - effectiveSymWidth) / 2;
                    effectiveSymWidth = MIN_ACC_WIDTH;
                }

                var offX = prevX - effectiveSymWidth + cusOff.additionalXOffset;
                var offY = cusOff.additionalYOffset;
                // log('offX: ' + offX);
                registeredSymbolOffsets.push({
                    elem: elem,
                    x: offX + spaceCentralizationOffset,
                    y: offY
                });

                if (offX < mostNegativeDistance) {
                    mostNegativeDistance = offX;
                }

                // create abs bbox for newly positioned symbol
                var symBbox = {
                    left: note.pagePos.x + elem.bbox.left + offX - cusOff.halfAddWidth,
                    right: note.pagePos.x + elem.bbox.right + offX + cusOff.halfAddWidth,
                    top: note.pagePos.y + elem.bbox.top + offY - cusOff.halfAddHeight,
                    bottom: note.pagePos.y + elem.bbox.bottom + offY + cusOff.halfAddHeight
                };

                // find index to insert symBbox into positioned elements.

                var insertIdx = positionedElemsBbox.length;
                for (var j = 0; j < positionedElemsBbox.length; j++) {
                    if (positionedElemsBbox[j].left < symBbox.left) {
                        insertIdx = j;
                        break;
                    }
                }

                // Mark symbol as positioned.
                positionedElemsBbox.splice(insertIdx, 0, symBbox);

                prevX = offX;
            });
        }


        if (isZig) {
            ascIdx++;
        } else {
            descIdx--;
        }
        isZig = !isZig;
    } // finish registering positions

    // log(count + ') posElemsBbox: ' + JSON.stringify(positionedElemsBbox.map(function (bbox) {
    //     return bbox.left;
    // })));

    // Now, we need to apply the offsets

    registeredSymbolOffsets.forEach(function (symOff) {
        if (symOff.elem.name == 'Fingering') {
            // because the HEWM accidental has autoplace on,
            // the offsetX needs to be further left.
            // TODO: Check if there's some kind of Score Formatting rules that
            //       affects this offset. It can't possibly be alright to hardcode this.
            symOff.elem.offsetX = symOff.x - 0.65;
        } else {
            symOff.elem.offsetX = symOff.x;
        }
        symOff.elem.offsetY = symOff.y;
    });

    return mostNegativeDistance;
}

/**
 * Automatically positions accidentals in a staff within specified
 * selection range.
 * 
 * @param {number} startTick Tick inside first bar of selection
 * @param {number} endTick Tick inside last bar of selection. If -1, performs operation
 *  till the end of the score.
 * @param {number[]} bars List of ticks of bars.
 * @param {Cursor} cursor MuseScore cursor object
 * @param {number?} firstBarTickIndex 
 * Pre-calculated {@link getBarBoundaries} output to reduce repeated computation.
 * If provided, {@link startTick} will be ignored.
 * @param {number?} lastBarTickIndex 
 * Pre-calculated {@link getBarBoundaries} output to reduce repeated computation.
 * If provided, {@link endTick} will be ignored.
 */
function autoPositionAccidentals(startTick, endTick, parms, cursor, firstBarTickIndex, lastBarTickIndex) {
    var bars = parms.bars;
    var staff = cursor.staffIdx;

    var lastBarTickIndex = isNullish(lastBarTickIndex) ? getBarBoundaries(endTick, bars, true)[1] : lastBarTickIndex; // if -1, means its the last bar of score
    var firstBarTickIndex = isNullish(firstBarTickIndex) ? getBarBoundaries(startTick, bars, true)[0] : firstBarTickIndex;

    if (lastBarTickIndex == -1)
        lastBarTickIndex = bars.length - 1;

    var tickOfThisBar = bars[firstBarTickIndex];

    log('autoPosition(' + startTick + ', ' + endTick + ') from bar '
        + firstBarTickIndex + ' (' + tickOfThisBar + ') to ' + lastBarTickIndex);

    // Repeat procedure for 1 bar at a time.

    for (var barIdx = firstBarTickIndex; barIdx <= lastBarTickIndex; barIdx++) {

        var tickOfNextBar;
        if (barIdx == bars.length - 1) {
            tickOfNextBar = -1;
        } else {
            tickOfNextBar = bars[barIdx + 1];
        }

        // Don't modify parms. Create a fake parms to store current
        // configs applied at this bar.
        var fakeParms = {};
        resetParms(fakeParms);

        for (var i = 0; i < parms.staffConfigs[staff].length; i++) {
            var config = parms.staffConfigs[staff][i];
            if (config.tick <= tickOfThisBar) {
                config.config(fakeParms);
            }
        }

        // mapping of ticks to Chords object of all chords present at that tick.
        var chordsByTick = partitionChords(tickOfThisBar, tickOfNextBar, cursor);
        var ticks = Object.keys(chordsByTick);

        // log('auto positioning from ' + tickOfThisBar + ' to ' + tickOfNextBar +
        //     '\nTicks found: ' + ticks.join(', '));

        ticks.forEach(function (tick) {
            /**
             * @type {Chords}
             */
            var chords = chordsByTick[tick];

            // One vert stack = all chords at a tick that should be
            // more or less aligned vertically.

            // The 0th vert stack represent the main chord.
            // 1st = right most grace chord
            // etc..
            var vertStackIndex = 0;

            // keeps track of how far back to push the grace chords.
            var graceOffset = 0;

            while (true) {
                // Loop through each vert stack startng with main chord
                // followed by grace chords right to left.

                // contains array of Note elements
                // for all voices, at this tick.
                var vertStack = [];
                for (var voice = 0; voice <= 3; voice++) {
                    // log('num chords in voice ' + voice + ': ' + chords[voice].length);
                    var chord = chords[voice][vertStackIndex]; // [Note]
                    if (!chord) {
                        // log('no chord in voice ' + voice + ' at vertStackIndex ' + vertStackIndex);
                        continue;
                    }

                    if (chord.length == 0) {
                        // log('chord no notes');
                        continue;
                    }

                    // log('num notes in chord: ' + chord.length);

                    // At the same time, we need to push back the chord
                    // by graceOffset, so that the symbols that were just
                    // don't overlap with the noteheads of this chord.

                    // chdElement contains one of the notes of the chord.
                    // We use this to get the parent MScore Chord element
                    // so that we can push it back.
                    var chdElement = chord[0];

                    if (!chdElement) {
                        // this shouldn't happen...
                        console.error("ERROR: chord object is present but no note inside!");
                        continue;
                    }

                    if (chdElement.parent.name != "Chord") {
                        console.error("ERROR: parent of note object isn't a chord??");
                        continue;
                    }

                    chdElement.parent.offsetX = graceOffset;
                    // log('applied grace chord offset: ' + graceOffset);

                    vertStack = vertStack.concat(chord);
                }

                // log('vertStack.length: ' + vertStack.length);
                // log('vertStack[0]: ' + vertStack[0]);

                // If no more chords at this vert stack index,
                // finish.
                if (vertStack.length == 0) break;

                // Now, we have all notes that should be vertically aligned.
                // Position symbols for this vert stack.
                // log(vertStack.length);
                var biggestXOffset = positionAccSymbolsOfChord(vertStack, fakeParms.currTuning);

                graceOffset += biggestXOffset;

                vertStackIndex++;
            }
        });

        tickOfThisBar = tickOfNextBar;
    }
}

/**
 * 
 * @param {boolean} isSteps `true` to display steps info, `false` to display cents data
 * @param {PluginAPINote} note 
 * @param {KeySig} keySig 
 * @param {TuningConfig} tuningConfig 
 * @param {number} tickOfThisBar 
 * @param {number} tickOfNextBar 
 * @param {Cursor} cursor 
 * @param {BarState?} reusedBarState 
 * @param {newElement} newElement 
 */
function addStepsCentsFingering(
    isSteps, note, keySig, tuningConfig, tickOfThisBar, tickOfNextBar,
    cursor, reusedBarState, newElement) {

    var noteData = parseNote(note, tuningConfig, keySig,
        tickOfThisBar, tickOfNextBar, cursor, newElement, reusedBarState);

    // Nominal index of the relative reference note.
    var relRefNominal = mod(tuningConfig.relativeTuningNominal, tuningConfig.numNominals);
    var relRefOctOffset = Math.floor(tuningConfig.relativeTuningNominal / tuningConfig.numNominals);
    var relRefCentsFromAbsRef = tuningConfig.nominals[relRefNominal] + relRefOctOffset * tuningConfig.equaveSize;
    var absRefCentsFromA440 = 1200 * log2(tuningConfig.tuningFreq / 440);
    var relRefCentsFromA440 = relRefCentsFromAbsRef + absRefCentsFromA440;

    if (isSteps && tuningConfig.displaySteps != null) {
        // Create steps info fingering.
        var steps = 0;

        if (tuningConfig.stepsList.length == tuningConfig.displaySteps
            && noteData.secondaryAccSyms.length == 0) {
            // Use steps lookup table to get the edo/neji step

            // Reference nominal doubles as XenNote hash.
            var referenceSteps = tuningConfig.stepsLookup[relRefNominal];
            var currNoteSteps = tuningConfig.stepsLookup[noteData.xen.hash];
            steps = mod(currNoteSteps - referenceSteps, tuningConfig.displaySteps);
        } else {
            // Use cents offset to calculate edosteps.
            var centsFromA440 = calcCentsOffset(noteData, tuningConfig, true);
            var centsFromRef = centsFromA440 - relRefCentsFromA440;
            steps = mod(
                Math.round(centsFromRef / tuningConfig.equaveSize * tuningConfig.displaySteps),
                tuningConfig.displaySteps);
        }

        // Remove prior steps display fingerings.

        var elemsToRemove = [];
        for (var i = 0; i < note.elements.length; i++) {
            var elem = note.elements[i];
            if (elem.name == 'Fingering' && elem.z == STEPS_DISPLAY_FINGERING_Z) {
                // This fingering is an accidental symbol, remove it.
                elemsToRemove.push(elem);
            }
        }
        elemsToRemove.forEach(function (elem) {
            note.remove(elem);
        });

        var elem = newElement(Element.FINGERING);
        note.add(elem);
        elem.text = escapeHTML(steps.toString());
        /*  Autoplace is required for this accidental to push back prior
            segments. */
        elem.autoplace = true;
        elem.fontSize = STEPS_DISPLAY_FONT_SIZE;
        elem.placement = tuningConfig.displayStepsPosition == 'above' ?
            Placement.ABOVE : Placement.BELOW;
        elem.z = STEPS_DISPLAY_FINGERING_Z;
        return;
    }

    if (!isSteps) {
        // Create cents info fingering.
        var cents = 0;
        var centsText = '';

        var centsFromA440 = calcCentsOffset(noteData, tuningConfig, true);

        var precisionMult = Math.pow(10, tuningConfig.displayCentsPrecision);

        if (tuningConfig.displayCentsReference == 'absolute') {
            var centsFromRef = centsFromA440 - relRefCentsFromA440;
            var centsFromEquave = mod(centsFromRef, tuningConfig.equaveSize);
            cents = Math.round(centsFromEquave * precisionMult)
                / precisionMult;
        } else if (tuningConfig.displayCentsReference == 'nominal') {
            var nomCentsFromA440 =
                absRefCentsFromA440
                + tuningConfig.nominals[noteData.xen.nominal]
                + noteData.equaves * tuningConfig.equaveSize;
            var centsFromNom = centsFromA440 - nomCentsFromA440;
            cents = Math.round(centsFromNom * precisionMult)
                / precisionMult;
            if (cents >= 0) {
                centsText = '+';
            }
        } else if (tuningConfig.displayCentsReference == 'semitone') {
            var centsFromRef = centsFromA440 - relRefCentsFromA440;
            var centsModSemitone = mod(centsFromRef + 49.99999999, 100) - 49.99999999;
            cents = Math.round(centsModSemitone * precisionMult)
                / precisionMult;
            if (cents >= 0) {
                centsText = '+';
            }
        }

        centsText += cents
            .toFixed(tuningConfig.displayCentsPrecision);

        // Remove prior steps display fingerings.

        var elemsToRemove = [];
        for (var i = 0; i < note.elements.length; i++) {
            var elem = note.elements[i];
            if (elem.name == 'Fingering' && elem.z == CENTS_DISPLAY_FINGERING_Z) {
                // This fingering is an accidental symbol, remove it.
                elemsToRemove.push(elem);
            }
        }
        elemsToRemove.forEach(function (elem) {
            note.remove(elem);
        });

        var elem = newElement(Element.FINGERING);
        note.add(elem);
        elem.text = escapeHTML(centsText);
        /*  Autoplace is required for this accidental to push back prior
            segments. */
        elem.autoplace = true;
        elem.fontSize = CENTS_DISPLAY_FONT_SIZE;
        elem.placement = tuningConfig.displayCentsPosition == 'above' ?
            Placement.ABOVE : Placement.BELOW;
        elem.z = CENTS_DISPLAY_FINGERING_Z;
        return;
    }
}
