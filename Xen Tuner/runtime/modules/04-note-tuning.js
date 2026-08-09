// Copyright (C) 2023 euwbah
// This file is part of Xen Tuner. See ../fns.js for license.
// Module: effective note parsing, fingering input, cents calculation, and note tuning.
/**
 * Use this function if you need to get the xen nominal of a note, but don't need
 * any other information.
 * 
 * @param {MSNote} msNote Tokenized musescore Note object
 * @param {TuningConfig} tuningConfig 
 */
function getNominal(msNote, tuningConfig) {
    var nominalsFromTuningNote = msNote.nominalsFromA4 - tuningConfig.tuningNominal;

    return mod(nominalsFromTuningNote, tuningConfig.numNominals);
}

/**
 * 
 * Uses TuningConfig and cursor to read XenNote data from a tokenized musescore note.
 * 
 * Uses cursor & getAccidental() to find the effective accidental being applied
 * on `msNote`, including accidentals on `msNote` itself.
 * 
 * If no prior explicit accidentals found, looks for accidentals on key signature.
 * 
 * Otherwise, just returns the nominal XenNote object.
 * 
 * @param {MSNote} msNote Representation of tokenized musescore note
 * @param {TuningConfig} tuningConfig The current tuning config applied.
 * @param {KeySig?} keySig The current key signature applied, or null if none.
 * @param {number} tickOfThisBar Tick of first segment of this bar
 * @param {number} tickOfNextBar Tick of first seg of the next bar, or -1 if last bar
 * @param {Cursor} MuseScore Cursor object
 * @param {BarState?} reusedBarState See parm description of {@link getAccidental()}.
 * @returns {NoteData?} 
 *      The parsed note data. If the note's accidentals are not valid within the
 *      declared TuningConfig, returns `null`.
 */
function readNoteData(msNote, tuningConfig, keySig, tickOfThisBar, tickOfNextBar, cursor, reusedBarState) {
    // Convert nominalsFromA4 to nominals from tuning note.

    var debugStr = ''; // to be printed during error

    var nominalsFromTuningNote = msNote.nominalsFromA4 - tuningConfig.tuningNominal;
    var equaves = Math.floor(nominalsFromTuningNote / tuningConfig.numNominals);

    var nominal = mod(nominalsFromTuningNote, tuningConfig.numNominals);

    var currAccStateHash = getAccidental(
        cursor, msNote.internalNote, tickOfThisBar, tickOfNextBar, 0, null,
        reusedBarState, tuningConfig);

    var accSyms = accidentalSymbolsFromHash(currAccStateHash);
    accSyms = removeUnusedSymbols(accSyms, tuningConfig);

    // Check fingerings for accidental declarations
    var maybeFingeringAccSymbols = readFingeringAccidentalInput(msNote, tuningConfig);
    if (maybeFingeringAccSymbols != null) {
        // log('found fingering acc input: ' + JSON.stringify(maybeFingeringAccSymbols.symCodes));
        if (!CLEAR_ACCIDENTALS_AFTER_ASCII_ENTRY &&
            maybeFingeringAccSymbols.type == "ascii" && currAccStateHash != null) {
            // We need to combine existing accidentals and newly created ones
            accSyms = addAccSym(accSyms, maybeFingeringAccSymbols.symCodes);
        } else {
            // Simply replace existing accidentals with newly created ones
            accSyms = accidentalSymbolsFromList(maybeFingeringAccSymbols.symCodes);
        }
        debugStr += '\nCreated symbols from fingering: ' + JSON.stringify(accSyms);
    }

    accSyms = normalizeAccidentalSymbols(accSyms);

    // If no accidental found, check key signature
    if (accSyms == null) {
        var nativeKeySigAccHash = cursorKeySignatureAccidentalHashAtLine(
            cursor, msNote.line, msNote.tick, Math.floor(msNote.internalNote.track / 4), tuningConfig);
        if (nativeKeySigAccHash != null) {
            accSyms = accidentalSymbolsFromHash(nativeKeySigAccHash);
            debugStr += '\nCreated symbols from native key sig API: ' + JSON.stringify(accSyms);
        }
    }

    if (accSyms == null && keySig && keySig[nominal] != null
        // Check if KeySig has a valid number of nominals.
        && keySig.length == tuningConfig.numNominals) {
        accSyms = accidentalSymbolsFromHash(keySig[nominal]);
        accSyms = removeUnusedSymbols(accSyms, tuningConfig);
        debugStr += '\nCreated symbols from key sig: ' + JSON.stringify(accSyms);
    }

    if (accSyms != null) {
        // make sure that if the only symbols present are natural symbols,
        // we make accSyms null.
        var syms = Object.keys(accSyms);
        if (syms.length == 1 && syms[0] == '2') {
            accSyms = null;
            debugStr += '\nOnly natural symbols found, setting accSyms to null.';
        }
    }

    /** @type {SymbolCode[]} */
    var primarySyms = []; // left-to-right display order
    /** @type {SymbolCode[]} */
    var secondarySyms = []; // left-to-right display order
    /** @type {SecondaryAccMatches} */
    var secondaryAccMatches = {};
    if (accSyms != null) {
        // First, check for ligatures, they count as primary accidentals.
        tuningConfig.ligatures.forEach(function (lig, idx) {
            // log('checking ligature: ' + JSON.stringify(lig));
            var mostSymbolsMatched = 0;
            /** @type {SymbolCode[]} */
            var bestSymbolMatch = null;
            /** @type {AccidentalSymbols} */
            var bestSubtracted = accSyms;
            for (var key in lig.ligAvToSymbols) {
                var syms = lig.ligAvToSymbols[key];
                var trySubtract = subtractAccSym(accSyms, syms);
                if (trySubtract != null && syms.length > mostSymbolsMatched) {
                    // log('lig subtracted ' + JSON.stringify(syms) + ' from ' + JSON.stringify(accSyms));
                    mostSymbolsMatched = syms.length;
                    bestSymbolMatch = syms;
                    bestSubtracted = trySubtract;
                }
            }
            if (bestSymbolMatch != null) {
                // If a match was found, add the best match to the primary symbols.
                // The matched accidentals go to the left of the earlier accidentals
                // from earlier chains.
                primarySyms = bestSymbolMatch.concat(primarySyms);

                // Remove the best match from the list of symbols to be matched.
                accSyms = bestSubtracted;

                debugStr += '\nMatched ligature: ' + JSON.stringify(bestSymbolMatch) +
                    ' from lig no. ' + (idx + 1);
            }
        });

        // Search from first declared acc Chain onwards
        for (var i = 0; i < tuningConfig.accChains.length; i++) {
            var chain = tuningConfig.accChains[i];

            // Find the best accidental match for this chain, which is assumed
            // to be the one with most symbols matched.
            var mostSymbolsMatched = 0;
            /** @type {SymbolCode[]} */
            var bestSymbolMatch = null;
            /** @type {AccidentalSymbols} */
            var bestSubtracted = accSyms;

            chain.degreesSymbols.forEach(function (syms) {
                if (syms == null) {
                    return; // skip central natural index.
                }
                var trySubtract = subtractAccSym(accSyms, syms);
                if (trySubtract != null && syms.length > mostSymbolsMatched) {
                    mostSymbolsMatched = syms.length;
                    bestSymbolMatch = syms;
                    bestSubtracted = trySubtract;
                }
            });

            if (bestSymbolMatch != null) {
                // If a match was found, add the best match to the primary symbols.
                // The matched accidentals go to the left of the earlier accidentals
                // from earlier chains.
                primarySyms = bestSymbolMatch.concat(primarySyms);

                // Remove the best match from the list of symbols to be matched.
                accSyms = bestSubtracted;

                debugStr += '\nMatched primary accidental: ' + JSON.stringify(bestSymbolMatch) +
                    ' from acc. chain no. ' + (i + 1);
            }
        }

        // Search from first declared secondary accidental.
        for (var i = 0; i < tuningConfig.secondaryAccList.length; i++) {
            var accHash = tuningConfig.secondaryAccList[i];
            var syms = tuningConfig.secondaryAccTable[accHash];

            // secondary accidentals can be stacked indefinitely.
            // match this secondary accidental's symbols until no more
            // are matchable.

            var numTimesMatched = 0;

            var count = 0;
            while (count++ < 70) { // limit reps to prevent freezing
                var trySubtract = subtractAccSym(accSyms, syms);

                if (trySubtract == null) {
                    break;
                }

                accSyms = trySubtract;
                numTimesMatched++;
            }

            // Register secondary accidental matches.

            if (numTimesMatched > 0) {
                var secAccIndex = tuningConfig.secondaryAccIndexTable[accHash];
                for (var j = 0; j < numTimesMatched; j++) {
                    secondarySyms = syms.concat(secondarySyms);
                }

                secondaryAccMatches[secAccIndex] = numTimesMatched;

                debugStr += '\nMatched secondary accidental: ' + JSON.stringify(syms) +
                    ' (no. ' + (i + 1) + ')' + numTimesMatched + ' times';
            }
        }
    }

    debugStr += '\nLeftover unmatched symbols: ' + JSON.stringify(accSyms);

    // Create hash manually.
    // Don't use the createXenHash function, that works on the AccidentalSymbols object
    // instead of the hash.
    var xenHash = nominal;

    var primarySymsHash = accidentalsHash(primarySyms);

    if (primarySymsHash != '') {
        xenHash += ' ' + primarySymsHash;
    }

    var xenNote = tuningConfig.notesTable[xenHash];

    if (xenNote == undefined) {
        console.error("\n-----------------------\nFATAL ERROR: Could not find XenNote (" + xenHash +
            ") in tuning config. " + "\n\nNote parsing trace:" + debugStr +
            "\n\n...this is likely due to an incorrect order of declaration of ligature/secondary accidentals. "
            + "Read the above note parsing trace messages to see how the plugin mis-parsed this note.\n"
            + "\n-----------------------\n");
        // log("Tuning config: " + JSON.stringify(tuningConfig.notesTable));
        return null;
    }

    // If new accidentals created from fingerings, use the best representation
    // of the accidental so that the proper ligatures are applied.

    if (maybeFingeringAccSymbols != null) {
        var av = tuningConfig.avTable[xenNote.hash];
        var newHash = createXenHash(xenNote.nominal, tuningConfig.avToSymbols[av]);
        xenNote = tuningConfig.notesTable[newHash];
    }

    return {
        ms: msNote,
        xen: xenNote,
        equaves: equaves,
        secondaryAccSyms: secondarySyms,
        secondaryAccMatches: secondaryAccMatches,
        updatedSymbols: maybeFingeringAccSymbols == null ? null :
            secondarySyms.concat(xenNote.orderedSymbols)
    };
}

/**
 * Parses a user-input string which converts into an array of {@link SymbolCode}s.
 * 
 * The entire user input must be matched with not a single character left over.
 * Otherwise, this is not a valid ASCII accidental input string.
 * 
 * @param {string} str Text containing ascii representation of accidentals.
 * @param {TuningConfig} tuningConfig
 * @returns {SymbolCode[]?} List of symbols, or null if the string couldn't be fully parsed.
 */
function parseAsciiAccInput(str, tuningConfig) {
    /** 
     * A list of strings.
     * 
     * Every time a match is found, the string will be split into the parts
     * before and after the match.
     * @type {string[]} 
     */
    var strParts = [str];

    /**
     * Stores converted {@link SymbolCode}s
     * @type {SymbolCode[]}
     */
    var convertedSymbols = [];

    tuningConfig.asciiToSmuflConvList.forEach(function (searchStr) {
        // contains strParts for the next iteration.
        var newStrParts = [];
        var numMatches = 0;
        strParts.forEach(function (sourceStr) {
            var splitStr = sourceStr.split(searchStr);
            numMatches += splitStr.length - 1;
            for (var i = 0; i < splitStr.length; i++) {
                var strPart = splitStr[i];
                if (strPart != '') {
                    newStrParts.push(strPart);
                }
            }
        });

        if (numMatches > 0) {
            var symCodes = tuningConfig.asciiToSmuflConv[searchStr];
            for (var i = 0; i < numMatches; i++) {
                // It doesn't really matter what order the individual SymCodes are in.
                // It will get parsed properly by readNoteData().
                convertedSymbols = convertedSymbols.concat(symCodes);
            }

            strParts = newStrParts;
        }
    });

    if (strParts.length != 0) {
        // fail silently. Not all fingerings are meant to be accidentals.
        return null;
    }

    return convertedSymbols;
}

/**
 * Checks if user enters accidentals via using fingering text attached
 * to this note.
 * 
 * If so, returns an {@link SymbolCode[]} list containing
 * accidental symbols that should replace existing accidentals.
 * 
 * When parsing accidentals, this {@link SymbolCode}[] object, if any, 
 * should be used in place of the original tokenized {@link AccidentalSymbols}
 * on the {@link MSNote}
 * 
 * Accidental fingering text could either be an {@link AccidentalVector}, 
 * or ASCII-representation accidental entry.
 * 
 * For ASCII-representation accidental entry, the user must declare conversion rules
 * in the secondary accidentals section of the tuning config.
 * 
 * AccidentalVector fingering is prefixed by 'a', followed
 * by the accidental vector that is comma-separated.
 * 
 * Recap: The Nth integer of the accidental vector represents the degree 
 * of the Nth accidental chain to be applied to this note.
 * 
 * Unprocessed fingerings have z-index of DEFAULT_FINGERING_Z_INDEX
 * 
 * @param {MSNote} msNote
 * @param {TuningConfig} tuningConfig
 * @returns {{
 *  type: 'av' | 'ascii',
 *  symCodes: SymbolCode[]
 * }?}
 * Returns `null`, if there are no fingerings that affect the accidentals of this note.
 * Otherwise, returns an object containing the `symbols` property which contains
 * a list of symbol codes that this fingering applies on to the note, and the 
 * `type` property which is either 'av' or 'ascii' depending on what kind of
 * fingering created the new accidental symbols.
 */
function readFingeringAccidentalInput(msNote, tuningConfig) {
    for (var i = 0; i < msNote.fingerings.length; i++) {
        // Loop through all non-accidental fingerings attached to this note.

        var fingering = msNote.fingerings[i];
        var text = fingering.text;
        text = removeFormattingCode(text);

        if (fingering.z != DEFAULT_FINGERING_Z_INDEX) {
            // only process unprocessed fingerings.
            continue;
        }

        // first, we try to match the fingering to user-declared ASCII
        // representations as declared in the sec() accidentals declarations

        var maybeSymCodes = parseAsciiAccInput(text, tuningConfig);

        if (maybeSymCodes != null) {
            // These new accidental symbols are converted from the 
            // ascii-representation fingering.
            msNote.internalNote.remove(fingering);
            return {
                symCodes: maybeSymCodes,
                type: 'ascii',
            };
        }

        if (strStartsWith(text, 'a')) {
            // test accidental vector fingering.

            // Each space-separated number represents the degree of the
            // nth accidental chain.
            var isValid = true;
            var degrees =
                text
                    .slice(1)
                    .trim()
                    .split(',')
                    .map(function (x) {
                        var i = parseInt(x);
                        if (isNaN(i)) isValid = false
                        return i;
                    });

            if (isValid) {
                // We found an accidental vector fingering.

                var av = [];

                // If the number of degrees is less than the number of chains,
                // assume the rest to be 0.

                // If it is more, ignore the extra degrees.
                for (var accChainIdx = 0; accChainIdx < tuningConfig.accChains.length; accChainIdx++) {
                    var deg = degrees[accChainIdx];
                    if (deg)
                        av.push(deg);
                    else
                        av.push(0);
                }

                // remove the fingering.
                msNote.internalNote.remove(fingering);

                var orderedSymbols = tuningConfig.avToSymbols[av];

                if (orderedSymbols != undefined) {
                    return {
                        symCodes: orderedSymbols,
                        type: 'av',
                    };
                }
            }
        }
    }

    // nothing found

    return null;
}

/**
 * Parse a MuseScore Note into `NoteData`.
 * 
 * Checks for fingering-based accidental entry and adds accidental symbols/fingerings
 * if accidental vector fingerings or ascii-representation fingerings are present.
 * 
 * If fingering accidental entry is performed, the note will have its accidentals
 * replaced/updated with the new symbols.
 * 
 * @param {PluginAPINote} note MuseScore Note object
 * @param {TuningConfig} tuningConfig Current tuning config applied.
 * @param {KeySig} keySig Current key signature applied.
 * @param {number} tickOfThisBar Tick of first segment of this bar
 * @param {number} tickOfNextBar Tick of first segment of next bar, or -1 if last bar.
 * @param {Cursor} cursor MuseScore Cursor object
 * @param {*} newElement reference to the `PluginAPI::newElement` function.
 * @param {BarState?} reusedBarState See parm description of {@link getAccidental()}.
 * @returns {NoteData} NoteData object
 */
function parseNote(note, tuningConfig, keySig, tickOfThisBar, tickOfNextBar, cursor, newElement, reusedBarState) {
    var msNote = tokenizeNote(note);
    var noteData = readNoteData(msNote, tuningConfig, keySig, tickOfThisBar, tickOfNextBar, cursor, reusedBarState);

    if (noteData && noteData.updatedSymbols) {
        forceExplicitAccidentalsAfterNote(
            note, note.line, noteData.ms.tick, tickOfThisBar, tickOfNextBar,
            tuningConfig, keySig, cursor, newElement
        );

        // update new symbols if fingering-based accidental entry is performed.
        setAccidental(note, noteData.updatedSymbols, newElement, tuningConfig);
    }
    return noteData;
}

/**

████████ ██    ██ ███    ██ ██ ███    ██  ██████  
   ██    ██    ██ ████   ██ ██ ████   ██ ██       
   ██    ██    ██ ██ ██  ██ ██ ██ ██  ██ ██   ███ 
   ██    ██    ██ ██  ██ ██ ██ ██  ██ ██ ██    ██ 
   ██     ██████  ██   ████ ██ ██   ████  ██████  
                                                  
*/

/**
 * Given current `NoteData` and a `TuningConfig`, calculate the
 * required note's tuning offset in cents.
 * 
 * This function also applies per-note tuning offsets denoted by
 * fingering annotations.
 * 
 * @param {NoteData} noteData The note to be tuned
 * @param {TuningConfig} tuningConfig The tuning configuration
 * @param {boolean?} absoluteFromA4
 * If `true`, returns the cents interval between the note and 440hz.
 * @returns {number} 
 * Returns the cents offset to apply to `Note.tuning` property,
 * 
 * or if `absoluteFromA4`, returns the absolute cents offset from 440hz.
 */
function calcCentsOffset(noteData, tuningConfig, absoluteFromA4) {
    // lookup tuning table [cents, equavesAdjusted]
    var cents_equaves = tuningConfig.tuningTable[noteData.xen.hash];

    // calc XenNote cents from A4

    // include equave offset (caused by equave modulo wrapping)
    var xenCentsFromA4 = cents_equaves[0] - cents_equaves[1] * tuningConfig.equaveSize;

    // apply reference note tuning offset
    xenCentsFromA4 += log2(tuningConfig.tuningFreq / 440) * 1200;

    // apply NoteData equave offset.
    xenCentsFromA4 += noteData.equaves * tuningConfig.equaveSize;

    // apply secondary accidentals
    Object.keys(noteData.secondaryAccMatches).forEach(function (secAccIdx) {
        var accHash = tuningConfig.secondaryAccList[secAccIdx];
        var secAccTuning = tuningConfig.secondaryTunings[accHash];
        if (Array.isArray(secAccTuning)) {
            secAccTuning = secAccTuning[noteData.xen.nominal];
        }
        xenCentsFromA4 +=
            noteData.secondaryAccMatches[secAccIdx] // number of matched accidentals
            * secAccTuning;
    });

    /*
    Different fingering tuning annotations can be applied to a note.
    (and can be applied simultaneously).
    
    They are applied in this order:
    
    1. The fingering JI interval/ratio tuning overrides the tuning entirely,
    tuning the note as the specified ratio against the reference note.
    Its octave is automatically reduced/expanded to be as close as possible to 
    xenCentsFromA4. By default, this fingering must be suffixed by a period
    unless the REQUIRE_PERIOD_AFTER_FINGERING_RATIO flag is set to false.
    
    2. The fingering cents offset simply offsets tuning by the specified
       amount of cents.
    */

    var fingeringCentsOffset = 0;
    var fingeringJIOffset = null; // this is in cents

    noteData.ms.fingerings.forEach(function (fingering) {
        if (fingering.z != DEFAULT_FINGERING_Z_INDEX && fingering.z != PROCESSED_FINGERING_ANNOTATION_Z) {
            // Only accept processed & unprocessed fingering annotations.
            // Other fingering types should be ignored.
            return;
        }

        var text = fingering.text;

        try {
            if (text[0] && (text[0] == '+' || text[0] == '-')) {
                // Cents offset fingering
                var cents = parseFloat(eval(text.slice(1)));
                if (!isNaN(cents)) {
                    fingeringCentsOffset += cents * (text[0] == '+' ? 1 : -1);
                }
                fingering.z = PROCESSED_FINGERING_ANNOTATION_Z;
            } else if (!REQUIRE_PERIOD_AFTER_FINGERING_RATIO || strEndsWith(text, '.')) {
                // Ratio.
                if (REQUIRE_PERIOD_AFTER_FINGERING_RATIO)
                    text = text.slice(0, -1);
                var ratio = parseFloat(eval(text));
                if (!isNaN(ratio) && ratio != 0) {
                    if (ratio > 0) {
                        fingeringJIOffset = log2(ratio) * 1200;
                    } else {
                        // negative ratio is treated as a negative cents offset
                        fingeringJIOffset = -log2(-ratio) * 1200;
                    }
                    var nomsOffset = mod(tuningConfig.relativeTuningNominal, tuningConfig.numNominals);
                    var eqvOffset = Math.floor(tuningConfig.relativeTuningNominal / tuningConfig.numNominals);
                    fingeringJIOffset += tuningConfig.nominals[nomsOffset] + eqvOffset * tuningConfig.equaveSize;
                }
                fingering.z = PROCESSED_FINGERING_ANNOTATION_Z;
            }
        }
        catch (e) {
            // ignore possible syntax errors. ascii-repr accidental
            // entry may begin with + or - and may match this form
            //
            // Even though the fingering element is removed from the note
            // immediately after rendering down, it will still show up
            // in PluginAPINote wrapper object, until endCmd() is called.
        }
    });

    if (fingeringJIOffset) {
        // 1. If JI ratio is present on the note, override the tuning of the note.

        // We need to octave reduce/expand this until it is as close as possible to 
        // xenCentsFromA4.

        xenCentsFromA4 = fingeringJIOffset - Math.round((fingeringJIOffset - xenCentsFromA4) / 1200) * 1200;
    }

    // 2. Apply cents offset.

    xenCentsFromA4 += fingeringCentsOffset;

    if (absoluteFromA4)
        return xenCentsFromA4;

    // calculate 12 edo interval from A4

    var standardCentsFromA4 =
        (noteData.ms.midiNote - 69) * 100;

    // the final tuning calculation is the difference between the two
    return xenCentsFromA4 - standardCentsFromA4;
}

/**
 * Literally just tunes the note. It's that simple!
 * 
 * If a note's cent offset is too great (especially in
 * systems with weird nominals/non-octave) we will have to use a different MIDI pitch
 * than the original `Note.pitch`, otherwise, the playback will have a very
 * weird timbre.
 * 
 * This function tunes a note by adjusting both its `.tuning` and `.playEvents`
 * properties. Make sure to always re-run the tune function when notes are
 * changed, (especially when using Shift+Alt+Up/Down diatonic transpose)
 * because it's not obvious when the `.playEvents` property is
 * tempered with, and a note may seemingly play back with the wrong pitch if
 * the tune function isn't run again.
 * 
 * **Make sure _curScore.createPlayEvents() is called** so that play events
 * are populated & modifiable from the plugin API!
 * 
 * This function also generates MIDI CSV entries for PlayEvents of the note
 * if `returnMidiCSV` is set to true.
 * 
 * **IMPORTANT: Cursor must be positioned where the msNote is before 
 * calling this function!**
 * 
 * `cursor.element` must point to the Chord of msNote, or if msNote is
 * a grace note, `cursor.element` must point to the Chord the grace note is
 * attached to.
 * 
 * @param {PluginAPINote} note MuseScore note object
 * @param {KeySig} keySig 
 * @param {TuningConfig} tuningConfig 
 * @param {number} tickOfThisBar Tick of first segment of this bar
 * @param {number} tickOfNextBar Tick of first segment of next bar, or -1 if last bar.
 * @param {Cursor} cursor MuseScore note object
 * @param {BarState?} reusedBarState See parm description of {@link getAccidental()}.
 * @param {boolean} newElement Reference to the `PluginAPI::newElement` function.
 * @param {boolean} returnMidiCSV 
 *  If true, this function will iterate play events of this note and create
 *  midi text events for each play event.
 * @param {number?} partVelocity 
 *  If `returnMidiCSV` is true, you will need to specify the velocity of
 *  the part (from Dynamic segment annotations). Individual note velocity
 *  is usually set to an offset relative to the part velocity.
 * @returns {string} MIDI CSV string to append to the midi csv file.
 */
function tuneNote(note, keySig, tuningConfig, tickOfThisBar, tickOfNextBar, cursor,
    reusedBarState, newElement, returnMidiCSV, partVelocity) {

    var noteData = parseNote(note, tuningConfig, keySig,
        tickOfThisBar, tickOfNextBar, cursor, newElement, reusedBarState);

    var centsOffset = calcCentsOffset(noteData, tuningConfig);

    // log("Found note: " + noteData.xen.hash + ", equave: " + noteData.equaves);

    var midiOffset = Math.round(centsOffset / 100);

    if (Math.abs(midiOffset) <= getPlayEventModSemitonesThreshold(returnMidiCSV)) {
        // If the midiOffset required is within the current optimization threshold,
        // don't affect PlayEvents.

        // When PlayEvent is changed, the playback of a Note when selected
        // will not match the actual playback of the note, which can be 
        // quite annoying.

        // This reduces the chance of that happening when the tuning
        // & nominals are close to 12.
        midiOffset = 0;
    }


    /*
     * This is a hacky quickfix for https://github.com/euwbah/musescore-xen-tuner/issues/1
     * 
     * Two notes with the same internal MIDI pitch will be regarded as one note,
     * making it impossible to tune them differently.
     * 
     * This solution scans the chord this note is attached to, so at least within
     * the same chord, augmented unisons et al will be played back properly.
     * 
     * However, this doesn't solve the problem when it occurs over two voices,
     * two Staffs under the same Part, or in play events caused by ornamentation.
     */

    var chord = note.parent;
    /**
     * Contains a lookup of MIDI pitches of PlayEvents of notes in this chord, 
     * excluding play events of this current note.
     */
    var midiPitchesInChord = {};

    if (chord) {
        for (var i = 0; i < chord.notes.length; i++) {
            var n = chord.notes[i];
            if (n.is(note)) // skip self
                continue;

            var p = n.pitch;
            for (var nPevIdx = 0; nPevIdx < n.playEvents.length; nPevIdx++) {
                var pev = n.playEvents[nPevIdx];
                midiPitchesInChord[p + pev.pitch] = true;
            }
        }
    }


    if (midiPitchesInChord[note.pitch + midiOffset]) {
        // If the original midi offset won't work because another note in the same chord already has the 
        // same midi pitch, work in a zig-zag fashion to find a 'hole' to insert the note.

        for (var offset = 1; offset < 80; offset++) { // god forbid someone actually having 80-note clusters in ONE chord.
            var bestOffset = 100;
            var foundSpace = false;
            for (var direction = -1; direction <= 1; direction += 2) {
                // test both directions in case the MIDI pitch is already offset and
                // going in one direction reduces offset more than the other.
                var testOffset = midiOffset + offset * direction;
                if (!midiPitchesInChord[note.pitch + testOffset] && Math.abs(testOffset) < Math.abs(bestOffset)) {
                    // hole found!
                    bestOffset = testOffset;
                    foundSpace = true;
                }
            }

            if (foundSpace) {
                midiOffset = bestOffset;
                break;
            }
        }
    }

    centsOffset -= midiOffset * 100;

    note.tuning = centsOffset;

    // Update midi offset as well.

    // If there are ornaments on this note, the ornaments
    // will result in multiple play events. Though,
    // it's not possible to microtune the ornaments, you can still at least
    // tune them within +/- 100 cents.
    for (var i = 0; i < note.playEvents.length; i++) {
        // the PlayEvent.pitch property is relative
        // to the original note's pitch.
        note.playEvents[i].pitch = midiOffset;
        // log('play event: ' + JSON.stringify(note.playEvents[i]));
    }

    if (!returnMidiCSV) {
        return;
    }

    var midiText = '';
    var staffIdx = Math.floor(note.track / 4);
    var velo = (note.veloType == 0) ? (partVelocity + note.veloOffset) : note.veloOffset;

    // iterate play events
    for (var i = 0; i < note.playEvents.length; i++) {
        var pev = note.playEvents[i];
        var pitch = note.pitch + pev.pitch; // midi pitch, to nearest semitone

        // Actual default duration information is tied to the Chord.actualDuration.ticks
        // property.
        var duration = noteData.ms.internalNote.parent.actualDuration.ticks;
        var ontime = noteData.ms.tick + (pev.ontime / 1000 * duration);
        var len = pev.len / 1000 * duration;

        var midiOffset = Math.round(centsOffset / 100);

        pitch += midiOffset;

        var tuning = centsOffset - midiOffset * 100;
        tuning = tuning.toFixed(5); // don't put too many decimal places

        log('registered: staff: ' + staffIdx + ', pitch: ' + pitch + ', ontime: ' + ontime
            + ', len: ' + len + ', vel: ' + velo + ', cents: ' + tuning);
        log('veloType: ' + note.veloType);

        midiText += staffIdx + ', ' + pitch + ', ' + ontime + ', ' + len + ', '
            + velo + ', ' + tuning + '\n';
    }

    return midiText;
}
