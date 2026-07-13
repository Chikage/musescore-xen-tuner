// Copyright (C) 2023 euwbah
// This file is part of Xen Tuner. See ../fns.js for license.
// Module: symbol math, accidental hashes, and raw MuseScore note tokenization.
/**
 * Modulo function that always returns a positive number.
 * 
 * @param {number} x
 * @param {number} y
 */
function mod(x, y) {
    return ((x % y) + y) % y;
}

/**
 * Check if two arrays are equal.
 */
function arraysEqual(a, b) {
    if (a === b) return true;
    if (a == null || b == null) return false;
    if (a.length !== b.length) return false;

    for (var i = 0; i < a.length; ++i) {
        if (a[i] !== b[i]) return false;
    }
    return true;
}

/**
 * Check if two notes are to be considered enharmonically equivalent
 * based on cents.
 * 
 * @param {number} cents1
 * @param {number} cents2
 * @param {number} equaveSize Size of equave in cents.
 * @returns 
 */
function isEnharmonicallyEquivalent(cents1, cents2, equaveSize) {
    var equaveMagnitude = Math.abs(equaveSize);
    return (Math.abs(cents1 - cents2) < ENHARMONIC_EQUIVALENT_THRESHOLD) ||
        (equaveMagnitude - Math.abs(cents1 - cents2) < ENHARMONIC_EQUIVALENT_THRESHOLD);
}

/**
 * Convert user-input {@link SymbolCode} or Text Code ({@link Lookup.TEXT_TO_CODE}) into SymbolCode ID.
 * 
 * This function only reads SMuFL symbol {@link SymbolCode}s or Text Codes.
 * 
 * In v0.2, an update was made such that SymbolCodes can now be ASCII as well.
 * 
 * The full parsing implementation of symbols is in {@link parseSymbolsDeclaration}.
 * 
 * @param {string} codeOrText
 * @returns {SymbolCode?} {@link SymbolCode} or null if invalid.
 */
function readSymbolCode(codeOrText) {
    var codeOrText = codeOrText.trim();
    var code = Lookup.TEXT_TO_CODE[codeOrText];
    if (!code)
        code = parseInt(codeOrText);

    if (isNaN(code) || code >= Lookup.CODE_TO_LABELS.length) {
        return null;
    }
    return code;
}

/**
 * Gets the tick of a MuseScore note object.
 * 
 * Can be used on notes & grace notes.
 * 
 * @param {PluginAPINote} note 
 * @returns {number} tick time-position of note.
 */
function getTick(note) {
    console.assert(note !== undefined && note !== null, "getTick called on non existent note");
    if (note.parent.parent.tick !== undefined)
        return note.parent.parent.tick;
    else
        return note.parent.parent.parent.tick;
}

var MUSESCORE_NATIVE_SYMBOL_ALIASES = {
    'DOUBLE_SHARP': 'accidentalDoubleSharp',
    'DOUBLE_FLAT': 'accidentalDoubleFlat',
    'TRIPLE_SHARP': 'accidentalTripleSharp',
    'TRIPLE_FLAT': 'accidentalTripleFlat',
    'SHARP_SHARP': 'accidentalSharpSharp',
    'NATURAL_SHARP': 'accidentalNaturalSharp',
    'NATURAL_FLAT': 'accidentalNaturalFlat',
    'SHARP_SLASH': 'accidentalQuarterToneSharpStein',
    'SHARP_SLASH2': 'accidentalBuyukMucennebSharp',
    'SHARP_SLASH3': 'accidentalKucukMucennebSharp',
    'SHARP_SLASH4': 'accidentalThreeQuarterTonesSharpStein',
    'FLAT_SLASH': 'accidentalBakiyeFlat',
    'FLAT_SLASH2': 'accidentalBuyukMucennebFlat',
    'MIRRORED_FLAT': 'accidentalQuarterToneFlatStein',
    'MIRRORED_FLAT2': 'accidentalThreeQuarterTonesFlatZimmermann'
};

function musescoreNativeSymbolNameFromValue(value) {
    if (value === undefined || value === null)
        return null;

    var labelText = value.toString();
    var numericValue = parseInt(labelText, 10);
    if (!isNaN(numericValue) && String(numericValue) == labelText &&
        typeof SymId != 'undefined' && SymId) {
        for (var symIdLabel in SymId) {
            try {
                if (SymId[symIdLabel] == numericValue)
                    return symIdLabel;
            } catch (e) { }
        }
    }

    var symMatch = labelText.match(/<sym>([^<]+)<\/sym>/i);
    if (symMatch)
        labelText = symMatch[1];

    var labelParts = labelText.split('.');
    labelText = labelParts[labelParts.length - 1];
    labelParts = labelText.split('::');
    labelText = labelParts[labelParts.length - 1];
    return labelText;
}

function musescoreNativeSymbolCode(value) {
    var labelText = musescoreNativeSymbolNameFromValue(value);
    if (labelText === null)
        return null;

    var candidates = [labelText];
    candidates.push(labelText.toUpperCase());

    var alias = MUSESCORE_NATIVE_SYMBOL_ALIASES[labelText];
    if (alias !== undefined)
        candidates.push(alias);

    alias = MUSESCORE_NATIVE_SYMBOL_ALIASES[labelText.toUpperCase()];
    if (alias !== undefined)
        candidates.push(alias);

    for (var i = 0; i < candidates.length; i++) {
        var symCode = Lookup.LABELS_TO_CODE[candidates[i]];
        if (symCode !== undefined && symCode !== null)
            return symCode;
    }

    return null;
}

function nativeAccidentalLabelToSymbolCode(label) {
    if (label === undefined || label === null) {
        return null;
    }

    var symCode = musescoreNativeSymbolCode(label);

    // Code 1 is NONE/noSym and should not count as an explicit accidental.
    if (symCode === null || symCode <= 1) {
        return null;
    }

    return symCode;
}

function nativeAccidentalTypeLabel(accidentalType) {
    if (accidentalType === undefined || accidentalType === null || Accidental === null) {
        return null;
    }

    for (var label in Lookup.LABELS_TO_CODE) {
        if (label != label.toUpperCase()) {
            continue;
        }

        try {
            if (Accidental[label] !== undefined && Accidental[label] == accidentalType) {
                return label;
            }
        } catch (e) {
        }
    }

    return null;
}

/**
 * Convert a MuseScore-native accidental attached to a note into a Xen Tuner
 * SymbolCode. Returns null when the note has no explicit native accidental.
 *
 * @param {PluginAPINote} note
 * @returns {SymbolCode?}
 */
function nativeAccidentalSymbolCode(note) {
    var symCode = null;

    if (note.accidental) {
        symCode = nativeAccidentalLabelToSymbolCode(note.accidental);
        if (symCode != null) {
            return symCode;
        }
    }

    if (note.accidentalType !== undefined && note.accidentalType !== null) {
        symCode = nativeAccidentalLabelToSymbolCode(note.accidentalType);
        if (symCode != null) {
            return symCode;
        }

        var label = nativeAccidentalTypeLabel(note.accidentalType);
        symCode = nativeAccidentalLabelToSymbolCode(label);
        if (symCode != null) {
            return symCode;
        }
    }

    return null;
}

function cursorKeySignatureAccidentalHashAtLine(cursor, line, tick, staffIdx, tuningConfig) {
    if (!cursor || !tuningConfig)
        return null;

    var symbols = null;
    var savedStaff = null;
    try {
        if (typeof cursor.keySignatureSymbolsAtLineForStaff == 'function') {
            symbols = cursor.keySignatureSymbolsAtLineForStaff(line, tick, staffIdx);
        } else if (typeof cursor.keySignatureSymbolsAtLineAtTick == 'function') {
            savedStaff = cursor.staffIdx;
            cursor.staffIdx = staffIdx;
            symbols = cursor.keySignatureSymbolsAtLineAtTick(line, tick);
            cursor.staffIdx = savedStaff;
            savedStaff = null;
        }
    } catch (e) {
        if (savedStaff !== null)
            cursor.staffIdx = savedStaff;
        return null;
    }

    if (!symbols || symbols.length == 0)
        return null;

    var symCodes = [];
    for (var i = 0; i < symbols.length; i++) {
        var symbol = symbols[i];
        var symbolValue = symbol;
        if (symbol && symbol.symbol !== undefined)
            symbolValue = symbol.symbol;
        else if (symbol && symbol.sym !== undefined)
            symbolValue = symbol.sym;

        var symCode = musescoreNativeSymbolCode(symbolValue);
        if (symCode !== null && symCode > 1)
            symCodes.push(symCode);
    }

    if (symCodes.length == 0)
        return null;

    return removeUnusedSymbols(accidentalsHash(symCodes), tuningConfig);
}

/**
 * @param {AccidentalSymbols} accidentals
 * @param {SymbolCode} symCode
 */
function addAccidentalSymbol(accidentals, symCode) {
    if (accidentals[symCode])
        accidentals[symCode] += 1;
    else
        accidentals[symCode] = 1;
}

/**
 * If note is a grace note, return the Chord it belongs to.
 * 
 * @param {PluginAPINote} note `PluginAPI::Note`
 * @returns {PluginAPIChord?} Chord element containing the grace note, or null
 */
function findGraceChord(note) {
    var graceChord = null;
    var noteType = note.noteType;
    if (noteType == NoteType.ACCIACCATURA || noteType == NoteType.APPOGGIATURA ||
        noteType == NoteType.GRACE4 || noteType == NoteType.GRACE16 ||
        noteType == NoteType.GRACE32) {
        graceChord = note.parent;
    }

    return graceChord;
}

/*
  _          __                       _           _                   
 / |_       [  |  _                  (_)         (_)                  
`| |-' .--.  | | / ] .---.  _ .--.   __   ____   __   _ .--.   .--./) 
 | | / .'`\ \| '' < / /__\\[ `.-. | [  | [_   ] [  | [ `.-. | / /'`\; 
 | |,| \__. || |`\ \| \__., | | | |  | |  .' /_  | |  | | | | \ \._// 
 \__/_'.__.'[__|  \_]'.__.'[___||__][___][_____][___][___||__].',__`  
 .' _ '.                                                     ( ( __)) 
 | (_) '___                                                           
 .`___'/ _/                                                           
| (___)  \_                      _                                    
`._____.\__|                    (_)                                   
 _ .--.   ,--.   _ .--.  .--.   __   _ .--.   .--./)                  
[ '/'`\ \`'_\ : [ `/'`\]( (`\] [  | [ `.-. | / /'`\;                  
 | \__/ |// | |, | |     `'.'.  | |  | | | | \ \._//                  
 | ;.__/ \'-;__/[___]   [\__) )[___][___||__].',__`                   
[__|                                        ( ( __))                  
*/


/**
 * Reads the {@link PluginAPINote} and tokenizes it into a {@link MSNote}.
 * 
 * @param {PluginAPINote} note `PluginAPI::Note`
 * @returns {MSNote}
 */
function tokenizeNote(note) {
    // 69 = MIDI A4
    var octavesFromA4 = Math.floor((note.pitch - 69) / 12);
    var nominals = Lookup.TPC_TO_NOMINAL[note.tpc][0];
    octavesFromA4 += Lookup.TPC_TO_NOMINAL[note.tpc][1];

    // log('note bbox: ' + JSON.stringify(note.bbox) +
    //     ', pagePos: ' + JSON.stringify(note.pagePos));

    var hasAcc = false;

    /** @type {AccidentalSymbols} */
    var accidentals = {};

    /** @type {PluginAPIElement[]} */
    var fingerings = [];

    for (var i = 0; i < note.elements.length; i++) {
        // If note has a Full/Half supported accidental,

        var elem = note.elements[i];

        if (elem.name == 'Fingering') {
            // Found fingering.

            if (elem.z >= 1000 && elem.z <= 2000) {
                // This is an ASCII accidental symbol.
                // remember to prepend "'" to signify that it is an
                // ASCII SymbolCode
                var asciiSymCode = "'" + removeFormattingCode(elem.text);
                addAccidentalSymbol(accidentals, asciiSymCode);

                hasAcc = true;
            } else {
                // This is some other fingering annotation
                // or an unprocessed accidental vector/ascii input fingering.
                fingerings.push(elem);
            }
        } else if (elem.symbol) {
            // Check if it is an accidental symbol.
            // Don't worry about registering accidentals not in the tuning config.
            // That will be handled later.

            var acc = nativeAccidentalLabelToSymbolCode(elem.symbol);

            if (acc !== null) {
                addAccidentalSymbol(accidentals, acc);
                hasAcc = true;
            }
        }
    }

    var nativeAccidental = nativeAccidentalSymbolCode(note);
    if (nativeAccidental != null && !accidentals[nativeAccidental]) {
        addAccidentalSymbol(accidentals, nativeAccidental);
        hasAcc = true;
    }

    /** @type {MSNote} */
    var msNote = { // MSNote
        midiNote: note.pitch,
        tpc: note.tpc,
        nominalsFromA4: nominals + (octavesFromA4 * 7),
        accidentals: hasAcc ? accidentals : null,
        tick: getTick(note),
        line: note.line,
        internalNote: note,
        fingerings: fingerings,
    };

    return msNote;
}

/**
 * Normalize accidental symbol collections that came from mixed MuseScore-native
 * and plugin symbol paths.
 *
 * A standalone natural remains meaningful, but in a composite accidental it only
 * cancels the prior sharp/flat state. The remaining symbols carry the Xen
 * accidental value and should be compared against key signatures directly.
 *
 * @param {AccidentalSymbols?} accSymbols
 * @returns {AccidentalSymbols?}
 */
function normalizeAccidentalSymbols(accSymbols) {
    if (!accSymbols)
        return null;

    var normalized = {};

    for (var symCode in accSymbols) {
        var count = parseInt(accSymbols[symCode], 10);
        if (isNaN(count) || count <= 0)
            continue;

        if (String(symCode) == '1')
            continue;

        normalized[symCode] = count;
    }

    normalized = composeArrowAccidentalSymbols(normalized);

    var hasNatural = false;
    var hasOtherSymbol = false;

    for (var symCode in normalized) {
        if (String(symCode) == '2')
            hasNatural = true;
        else
            hasOtherSymbol = true;
    }

    if (hasNatural && hasOtherSymbol)
        delete normalized['2'];

    return Object.keys(normalized).length == 0 ? null : normalized;
}

var ARROW_UP_SYMBOL_CODE = '41';
var ARROW_DOWN_SYMBOL_CODE = '43';
var ARROW_ACCIDENTAL_COMPOSITIONS = {
    '4': {
        up: { 1: 24, 2: 23, 3: 22 },
        down: { 1: 25, 2: 26, 3: 27 }
    },
    '5': {
        up: { 1: 32, 2: 31, 3: 30 },
        down: { 1: 33, 2: 34, 3: 35 }
    },
    '2': {
        up: { 1: 40, 2: 39, 3: 38 },
        down: { 1: 42, 2: 44, 3: 45 }
    },
    '6': {
        up: { 1: 52, 2: 51, 3: 50 },
        down: { 1: 53, 2: 54, 3: 55 }
    },
    '7': {
        up: { 1: 62, 2: 61, 3: 60 },
        down: { 1: 63, 2: 64, 3: 65 }
    }
};

function addNormalizedAccidentalSymbol(accSymbols, symCode, count) {
    if (!count || count <= 0)
        return;

    if (accSymbols[symCode] === undefined)
        accSymbols[symCode] = 0;

    accSymbols[symCode] += count;
}

function composeArrowAccidentalDirection(accSymbols, baseSymCode, arrowSymCode, replacements) {
    var baseCount = accSymbols[baseSymCode] || 0;
    var arrowCount = accSymbols[arrowSymCode] || 0;

    while (baseCount > 0 && arrowCount > 0) {
        var arrowUse = Math.min(3, arrowCount);
        var replacementSymCode = replacements[arrowUse];

        if (replacementSymCode === undefined)
            break;

        baseCount--;
        arrowCount -= arrowUse;
        addNormalizedAccidentalSymbol(accSymbols, replacementSymCode, 1);
    }

    if (baseCount > 0)
        accSymbols[baseSymCode] = baseCount;
    else
        delete accSymbols[baseSymCode];

    if (arrowCount > 0)
        accSymbols[arrowSymCode] = arrowCount;
    else
        delete accSymbols[arrowSymCode];
}

function composeArrowAccidentalSymbols(accSymbols) {
    if (!accSymbols)
        return null;

    for (var baseSymCode in ARROW_ACCIDENTAL_COMPOSITIONS) {
        var replacements = ARROW_ACCIDENTAL_COMPOSITIONS[baseSymCode];
        composeArrowAccidentalDirection(
            accSymbols, baseSymCode, ARROW_UP_SYMBOL_CODE, replacements.up);
        composeArrowAccidentalDirection(
            accSymbols, baseSymCode, ARROW_DOWN_SYMBOL_CODE, replacements.down);
    }

    return accSymbols;
}

/**
 * @param {SymbolCode[]} symbols
 * @returns {SymbolCode[]?}
 */
function normalizeAccidentalSymbolList(symbols) {
    if (!symbols || symbols.length == 0)
        return null;

    return accidentalSymbolListFromSymbols(
        normalizeAccidentalSymbols(accidentalSymbolsFromList(symbols)));
}

/**
 * @param {AccidentalHash?} accHash
 * @returns {AccidentalHash}
 */
function normalizeAccidentalHash(accHash) {
    var normalized = normalizeAccidentalSymbols(accidentalSymbolsFromHash(accHash));
    return normalized ? accidentalsHash(normalized) : '';
}

/**
 * @param {AccidentalSymbols?} accSymbols
 * @returns {SymbolCode[]?}
 */
function accidentalSymbolListFromSymbols(accSymbols) {
    if (!accSymbols)
        return null;

    var list = [];
    var accHash = accidentalsHash(accSymbols);
    if (accHash == '')
        return null;

    var accHashWords = accHash.split(' ');
    for (var i = 0; i < accHashWords.length; i += 2) {
        var symCode = accHashWords[i];
        var count = parseInt(accHashWords[i + 1], 10);
        var numericSymCode = parseInt(symCode, 10);
        var listSymCode = String(numericSymCode) == symCode ? numericSymCode : symCode;

        for (var j = 0; j < count; j++)
            list.push(listSymCode);
    }

    return list.length == 0 ? null : list;
}

/**
 * Filters accidentals to remove symbols that aren't used by the tuning config.
 * 
 * **WARNING:** If the resulting accidental is empty, returns `null`.
 * In some {@link AccidentalHash} use cases, '' is required instead of null. 
 * Make sure to check what is required.
 * 
 * @param {AccidentalHash|SymbolCode[]|AccidentalSymbols} accHashOrSymbols Accidentals to remove unused symbols from.
 * @param {TuningConfig} tuningConfig
 * @returns {(AccidentalHash|SymbolCode[]|AccidentalSymbols)?} 
 *  Returns an {@link AccidentalHash}, {@link SymbolCode}[], or {@link AccidentalSymbols} 
 *  depending on what was passed in.
 * 
 *  Returns `null` if there are no symbols left after filtering.
 */
function removeUnusedSymbols(accHashOrSymbols, tuningConfig) {
    if (!accHashOrSymbols) return null;
    if (typeof (accHashOrSymbols) == 'string') {
        // Accidental Hash 
        var normalizedAccSymbols = normalizeAccidentalSymbols(
            accidentalSymbolsFromHash(accHashOrSymbols));
        if (normalizedAccSymbols == null) return null;

        var newAccSymbols = {};

        for (var symCode in normalizedAccSymbols) {
            if (tuningConfig.usedSymbols[symCode] || tuningConfig.usedSecondarySymbols[symCode]) {
                newAccSymbols[symCode] = normalizedAccSymbols[symCode];
            }
        }

        var filteredAccSymbols = normalizeAccidentalSymbols(newAccSymbols);
        if (filteredAccSymbols == null) return null;

        return accidentalsHash(filteredAccSymbols);
    } else if (Array.isArray(accHashOrSymbols)) {
        // SymbolCode[]
        var normalizedSymbols = normalizeAccidentalSymbols(
            accidentalSymbolsFromList(accHashOrSymbols));
        if (normalizedSymbols == null) return null;

        var newSymbols = {};
        for (var symCode in normalizedSymbols) {
            if (tuningConfig.usedSymbols[symCode] || tuningConfig.usedSecondarySymbols[symCode]) {
                addNormalizedAccidentalSymbol(newSymbols, symCode, normalizedSymbols[symCode]);
            }
        }

        return accidentalSymbolListFromSymbols(normalizeAccidentalSymbols(newSymbols));
    } else {
        // AccidentalSymbols object
        var normalizedAccSymbols = normalizeAccidentalSymbols(accHashOrSymbols);
        if (normalizedAccSymbols == null) return null;

        var newAccSymbols = {};
        for (var symCode in normalizedAccSymbols) {
            if (tuningConfig.usedSymbols[symCode] || tuningConfig.usedSecondarySymbols[symCode]) {
                newAccSymbols[symCode] = normalizedAccSymbols[symCode];
            }
        }

        return normalizeAccidentalSymbols(newAccSymbols);
    }
}

/**
 * Hashes the {@link AccidentalSymbols} attached to a note.
 * 
 * The result is appended to the nominal of a note to construct a {@link XenNote}.
 * 
 * You can also specify a list of unsorted {@link SymbolCode}s that are present.
 * (useful for hashing accidentals from user-input).
 * 
 * Accidentals hash format:
 * 
 * ```txt
 * 3 1 5 2 // this means SymCode 3 appears once, and SymCode 5 appears twice.
 * 'asdf 1 // this means the ASCII accidental 'asdf' appears once.
 * 7 2 '7 2 // this means the SymCode 7 appears 2 times, and the
 *          // ASCII symbol '7' appears 2 times.
 * ```
 * 
 * To differentiate between ASCII and SMuFL internally, ASCII accidental 
 * {@link SymbolCode}s are represented with a prefixed quote (`'`).
 * 
 * @param {AccidentalSymbols|SymbolCode[]|null|undefined} accidentals 
 *      The AccidentalSymbols object, or a list of `SymbolCode` numbers, or nothing.
 * @returns {string}
 * {@link AccidentalSymbols} hash string.
 * If no accidentals are present, returns an empty string.
 */
function accidentalsHash(accidentals) {

    if (accidentals == undefined) {
        return '';
    }

    if (accidentals == null) {
        // no accidentals
        return '';
    }

    var symCodeSortingFn = function (a, b) {
        // Note that object keys are always strings, so we need to
        // differentiate between ASCII and SMuFL by checking for the
        // prefixed quote.
        if (a.length && a[0] == "'" && b.length && b[0] == "'") {
            // strings are sorted in increasing alphabetical order
            return a.localeCompare(b);
        } else if (!(a.length && a[0] == "'") && !(b.length && b[0] == "'")) {
            // numbers are sorted in increasing numerical order
            return parseInt(a) - parseInt(b);
        } else if ((a.length && a[0] == "'") && !(b.length && b[0] == "'")) {
            // strings always after numbers
            return 1;
        } else {
            // numbers always before strings
            return -1;
        }
    };

    if (accidentals.length != undefined) {
        // `accidentals` param is a list of individual symbol codes

        if (accidentals.length == 0) {
            log('WARN: accidentalsHash called with 0 SymbolCodes in array');
            return '';
        }

        // sort and count number of occurences.
        // use a copy of the array so we don't modify the original.
        accidentals = accidentals.slice();
        accidentals.sort(symCodeSortingFn);

        var occurences = 0;
        var prevSymCode = -1;
        var symCodeNums = [];

        accidentals.forEach(function (symCode) {
            if (prevSymCode == -1) {
                prevSymCode = symCode;
                occurences++;
                return;
            }

            if (symCode != prevSymCode) {
                symCodeNums.push(prevSymCode);
                symCodeNums.push(occurences);
                occurences = 0;
            }

            occurences++;
            prevSymCode = symCode;
        });

        symCodeNums.push(prevSymCode);
        symCodeNums.push(occurences);

        return symCodeNums.join(' ');
    }

    // otherwise, `accidentals` param is an `AccidentalSymbols` object.

    var symCodeNums = [];

    Object.keys(accidentals)
        .sort(symCodeSortingFn)
        .forEach(function (symCode) {
            symCodeNums.push(symCode);
            symCodeNums.push(accidentals[symCode]);
        });

    return symCodeNums.join(' ');
}

/**
 * Adds accidentals from two different collections together.
 * 
 * Returns a new {@link AccidentalSymbols} object.
 * 
 * @param {AccidentalSymbols} x 
 * @param {AccidentalSymbols | SymbolCode[]} y
 * @returns {AccidentalSymbols}
 */
function addAccSym(x, y) {
    if (!x)
        return y;
    if (!y)
        return x;

    var ret = {};

    for (var symCode in x) {
        ret[symCode] = x[symCode];
    }

    if (Array.isArray(y)) {
        // y is SymbolCode[]
        y.forEach(function (symCode) {
            if (ret[symCode] == undefined) {
                ret[symCode] = 1;
            } else {
                ret[symCode]++;
            }
        });
    } else {
        // y is AccidentalSymbols
        for (var symCode in y) {
            if (ret[symCode] == undefined) {
                ret[symCode] = y[symCode];
            } else {
                ret[symCode] += y[symCode];
            }
        }
    }

    return ret;
}

/**
 * Subtract x - y.
 * 
 * Removes as many accidental symbols there are in Y from X, and returns
 * a new object.
 * 
 * If X does not have enough symbols & not possible to subtract because the
 * number of symbols will go into the negative, returns `null`.
 * 
 * @param {AccidentalSymbols} x The acc syms to subtract from
 * @param {AccidentalSymbols|SymbolCode[]} y 
 *  The symbols to subtract. Can be specified either as {@link AccidentalSymbols}
 *  or {@link SymbolCode}[] array.
 * @returns {AccidentalSymbols?} The result of x - y, or `null` if not possible.
 */
function subtractAccSym(x, y) {
    // log('subtractAccSym\n' + JSON.stringify(x) + ' - ' + JSON.stringify(y));
    if (!x)
        return null;
    if (!y)
        return x;

    var ret = {};

    for (var sym in x) {
        // shallow copy x into ret.
        ret[sym] = x[sym];
    }

    if (y.length != undefined) {
        // y is SymbolCode[]
        for (var i = 0; i < y.length; i++) {
            var sym = y[i];
            // remove sym from ret.
            if (ret[sym] == undefined) {
                // X does not have any sym to subtract.
                return null;
            }

            ret[sym] -= 1;
            if (ret[sym] < 0) {
                return null;
            } else if (ret[sym] == 0) {
                delete ret[sym];
            }
        }
    } else {
        // y is AccidentalSymbols
        for (var sym in y) {
            if (ret[sym] == undefined) {
                // X does not have any sym to subtract.
                return null;
            }
            ret[sym] -= y[sym];
            if (ret[sym] < 0) {
                return null;
            } else if (ret[sym] == 0) {
                delete ret[sym];
            }
        }
    }

    return ret;
}

/**
 * Convert a {@link SymbolCode}[] array into an {@link AccidentalSymbols} object.
 * 
 * @param {SymbolCode[]} symList Array of {@link SymbolCode}s
 * @returns {AccidentalSymbols?}
 * An {@link AccidentalSymbols} object, or `null` if the array is empty.
 */
function accidentalSymbolsFromList(symList) {
    if (symList.length == 0) return null;

    var accSymbols = {};

    symList.forEach(function (symCode) {
        if (accSymbols[symCode] == undefined) {
            accSymbols[symCode] = 0;
        }
        accSymbols[symCode]++;
    });

    return accSymbols;
}

/**
 * Convert an {@link AccidentalHash} string to an {@link AccidentalSymbols} object.
 * 
 * @param {AccidentalHash?} accHash Accidental Hash string
 * @returns {AccidentalSymbols?}
 * An {@link AccidentalSymbols} object, or `null` if the string is empty, or
 * null value was passed.
 */
function accidentalSymbolsFromHash(accHash) {
    if (!accHash) return null;
    var accHashWords = accHash.split(' ');
    var accSymbols = {};

    for (var i = 0; i < accHashWords.length; i += 2) {
        accSymbols[accHashWords[i]] = parseInt(accHashWords[i + 1]);
    }

    return accSymbols;
}

/**
 * Calculate a {@link XenNote.hash} string from its nominal and accidentals.
 * 
 * @param {number} nominal
 * @param {AccidentalSymbols|SymbolCode[]|null|undefined} accidentals
 */
function createXenHash(nominal, accidentals) {
    return (nominal + ' ' + accidentalsHash(accidentals)).trim();
}
