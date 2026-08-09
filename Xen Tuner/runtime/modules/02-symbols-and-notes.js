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

    if (typeof value == 'object') {
        var symbolFields = [
            'accidentalSymbolName',
            'symbolName',
            'symbol',
            'sym',
            'symId'
        ];
        for (var fieldIdx = 0; fieldIdx < symbolFields.length; fieldIdx++) {
            var field = symbolFields[fieldIdx];
            try {
                if (value[field] !== undefined && value[field] !== null &&
                    value[field] !== value) {
                    var nestedName = musescoreNativeSymbolNameFromValue(value[field]);
                    if (nestedName !== null)
                        return nestedName;
                }
            } catch (e) { }
        }
    }

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
    if (accidentalType === undefined || accidentalType === null ||
        typeof Accidental == 'undefined' || Accidental === null) {
        return null;
    }

    // Prefer the enum object itself. MuseScore exposes AccidentalType values to
    // QML as numbers, which must not be confused with SymId numbers.
    for (var enumLabel in Accidental) {
        try {
            if (Accidental[enumLabel] !== undefined &&
                Accidental[enumLabel] == accidentalType) {
                return enumLabel;
            }
        } catch (e) { }
    }

    // Some QML enum wrappers do not enumerate their members. Fall back to the
    // labels known by Xen Tuner and probe the wrapper explicitly.
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

function nativeAccidentalTypeSymbolCode(accidentalType) {
    var label = nativeAccidentalTypeLabel(accidentalType);
    var enumCode = nativeAccidentalLabelToSymbolCode(label);
    if (enumCode !== null)
        return enumCode;

    if (typeof accidentalType == 'string' &&
        !accidentalType.trim().match(/^-?\d+$/)) {
        return nativeAccidentalLabelToSymbolCode(accidentalType);
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

    var directSymbolFields = [
        'accidentalSymbolName',
        'accidentalSymbolId',
        'accidentalSymbol'
    ];
    for (var directIdx = 0; directIdx < directSymbolFields.length; directIdx++) {
        try {
            var directValue = note[directSymbolFields[directIdx]];
            if (directValue !== undefined && directValue !== null && directValue !== '') {
                symCode = nativeAccidentalLabelToSymbolCode(directValue);
                if (symCode != null)
                    return symCode;
            }
        } catch (e) { }
    }

    if (note.accidental) {
        var accidentalSymbolFields = [
            'accidentalSymbolName',
            'symbolName',
            'symbol',
            'sym',
            'symId'
        ];
        for (var fieldIdx = 0; fieldIdx < accidentalSymbolFields.length; fieldIdx++) {
            try {
                var accidentalValue = note.accidental[accidentalSymbolFields[fieldIdx]];
                if (accidentalValue !== undefined && accidentalValue !== null) {
                    symCode = nativeAccidentalLabelToSymbolCode(accidentalValue);
                    if (symCode != null)
                        return symCode;
                }
            } catch (e2) { }
        }

        try {
            if (note.accidental.accidentalType !== undefined &&
                note.accidental.accidentalType !== null) {
                symCode = nativeAccidentalTypeSymbolCode(
                    note.accidental.accidentalType);
                if (symCode != null)
                    return symCode;
            }
        } catch (e3) { }

    }

    if (note.accidentalType !== undefined && note.accidentalType !== null) {
        // accidentalType is an enum value, not a SymId. Resolve its enum label
        // before consulting the Xen Tuner symbol table.
        symCode = nativeAccidentalTypeSymbolCode(note.accidentalType);
        if (symCode != null) {
            return symCode;
        }
    }

    if (note.accidental) {
        // Compatibility with older/custom wrappers whose toString() returns
        // an AccidentalType label or SMuFL name. This deliberately runs after
        // note.accidentalType so an ambiguous numeric string is never treated
        // as a SymId when enum context is available.
        symCode = nativeAccidentalTypeSymbolCode(note.accidental.toString());
        if (symCode == null)
            symCode = nativeAccidentalLabelToSymbolCode(note.accidental);
        if (symCode != null)
            return symCode;
    }

    return null;
}

function nativeAccidentalTypeForSymbolCode(symCode) {
    if (typeof symCode == 'string' && symCode.charAt(0) == "'")
        return null;
    if (typeof Accidental == 'undefined' || Accidental === null)
        return null;

    var labels = Lookup.CODE_TO_LABELS[symCode];
    if (!labels)
        return null;

    for (var i = 0; i < labels.length; i++) {
        try {
            if (Accidental[labels[i]] !== undefined)
                return Accidental[labels[i]];
        } catch (e) { }
    }

    return null;
}

function setMuseScoreNativeAccidentalSymbol(note, symCode) {
    if (!note || (typeof symCode == 'string' && symCode.charAt(0) == "'"))
        return false;

    var labels = Lookup.CODE_TO_LABELS[symCode];
    if (labels && typeof note.setAccidentalSymbol == 'function') {
        for (var i = 0; i < labels.length; i++) {
            try {
                if (note.setAccidentalSymbol(labels[i]))
                    return true;
            } catch (e) { }
        }
    }

    var accidentalType = nativeAccidentalTypeForSymbolCode(symCode);
    if (accidentalType === null)
        return false;

    try {
        note.accidentalType = accidentalType;
        return true;
    } catch (e2) {
        return false;
    }
}

function clearMuseScoreNativeAccidental(note) {
    if (!note)
        return false;

    var noneType = 0;
    try {
        if (typeof Accidental != 'undefined' && Accidental !== null &&
            Accidental.NONE !== undefined) {
            noneType = Accidental.NONE;
        }
        note.accidentalType = noneType;
        return true;
    } catch (e) {
        return false;
    }
}

function tuningConfigUsesAccidentalSymbol(tuningConfig, symCode) {
    if (!tuningConfig || symCode === null || symCode === undefined)
        return false;

    return !!(tuningConfig.usedSymbols[symCode] ||
        tuningConfig.usedSecondarySymbols[symCode]);
}

var MUSESCORE_STANDARD_ACCIDENTAL_DEGREES = {
    '2': 0,
    '3': 3,
    '4': 2,
    '5': 1,
    '6': -1,
    '7': -2,
    '8': -3
};

function symbolCodeValue(symCode) {
    var numericCode = parseInt(symCode, 10);
    return String(numericCode) == String(symCode) ? numericCode : symCode;
}

function nativeAccidentalMappingChain(tuningConfig) {
    if (!tuningConfig || !tuningConfig.accChains ||
        tuningConfig.accChains.length == 0) {
        return null;
    }

    var standardCodes = ['3', '4', '5', '6', '7', '8'];
    for (var chainIdx = 0; chainIdx < tuningConfig.accChains.length; chainIdx++) {
        var symbolsUsed = tuningConfig.accChains[chainIdx].symbolsUsed || [];
        for (var codeIdx = 0; codeIdx < standardCodes.length; codeIdx++) {
            if (symbolsUsed.indexOf(standardCodes[codeIdx]) != -1 ||
                symbolsUsed.indexOf(parseInt(standardCodes[codeIdx], 10)) != -1) {
                return tuningConfig.accChains[chainIdx];
            }
        }
    }

    if (tuningConfig.accChains.length == 1)
        return tuningConfig.accChains[0];

    // With multiple custom-glyph chains, choose the chain whose adjacent
    // degree is closest to MuseScore's standard semitone. This avoids mapping
    // native sharps onto a comma/arrow chain merely because it was declared
    // first. An exact tie is ambiguous and must not be guessed silently.
    var bestChain = null;
    var bestDeviation = Infinity;
    var ambiguous = false;
    var TIE_EPSILON = 0.000001;

    for (var candidateIdx = 0;
        candidateIdx < tuningConfig.accChains.length;
        candidateIdx++) {
        var candidate = tuningConfig.accChains[candidateIdx];
        var deviations = [];
        var lowerIdx = candidate.centralIdx - 1;
        var upperIdx = candidate.centralIdx + 1;

        if (lowerIdx >= 0 && candidate.degreesSymbols[lowerIdx] != null)
            deviations.push(Math.abs(Math.abs(candidate.tunings[lowerIdx]) - 100));
        if (upperIdx < candidate.degreesSymbols.length &&
            candidate.degreesSymbols[upperIdx] != null) {
            deviations.push(Math.abs(Math.abs(candidate.tunings[upperIdx]) - 100));
        }
        if (deviations.length == 0)
            continue;

        var deviation = 0;
        for (var deviationIdx = 0;
            deviationIdx < deviations.length;
            deviationIdx++) {
            deviation += deviations[deviationIdx];
        }
        deviation /= deviations.length;

        if (deviation < bestDeviation - TIE_EPSILON) {
            bestDeviation = deviation;
            bestChain = candidate;
            ambiguous = false;
        } else if (Math.abs(deviation - bestDeviation) <= TIE_EPSILON) {
            ambiguous = true;
        }
    }

    return ambiguous ? null : bestChain;
}

function buildNativeAccidentalMap(tuningConfig) {
    var mapping = {};
    var mappingChain = nativeAccidentalMappingChain(tuningConfig);

    for (var nativeCode in MUSESCORE_STANDARD_ACCIDENTAL_DEGREES) {
        if (String(nativeCode) == '2') {
            mapping[nativeCode] = [2];
            continue;
        }

        if (tuningConfig.usedSymbols[nativeCode]) {
            mapping[nativeCode] = [symbolCodeValue(nativeCode)];
            continue;
        }

        var degree = MUSESCORE_STANDARD_ACCIDENTAL_DEGREES[nativeCode];
        var degreeSymbols = null;
        if (mappingChain) {
            var degreeIdx = mappingChain.centralIdx + degree;
            if (degreeIdx >= 0 && degreeIdx < mappingChain.degreesSymbols.length)
                degreeSymbols = mappingChain.degreesSymbols[degreeIdx];
        }

        mapping[nativeCode] = degreeSymbols == null ? null : degreeSymbols.slice();
    }

    tuningConfig.nativeAccidentalMap = mapping;
    return mapping;
}

function nativeAccidentalSymbolsForTuning(symCode, tuningConfig) {
    if (!tuningConfig)
        return [symbolCodeValue(symCode)];

    var codeKey = String(symCode);
    if (MUSESCORE_STANDARD_ACCIDENTAL_DEGREES[codeKey] === undefined) {
        return tuningConfigUsesAccidentalSymbol(tuningConfig, symCode) ?
            [symbolCodeValue(symCode)] : null;
    }

    if (tuningConfig.usedSymbols[codeKey])
        return [symbolCodeValue(symCode)];

    var mapping = tuningConfig.nativeAccidentalMap ||
        buildNativeAccidentalMap(tuningConfig);
    var symbols = mapping[codeKey];
    return symbols == null ? null : symbols.slice();
}

function warnUnmappedNativeAccidental(symCode, tuningConfig) {
    if (!tuningConfig)
        return;

    if (!tuningConfig.unmappedNativeAccidentals)
        tuningConfig.unmappedNativeAccidentals = {};
    if (tuningConfig.unmappedNativeAccidentals[symCode])
        return;

    tuningConfig.unmappedNativeAccidentals[symCode] = true;
    console.warn('Xen Tuner: MuseScore native accidental SymbolCode ' +
        symCode + ' is not defined and cannot be mapped to the active tuning' +
        (tuningConfig.sourceName ? ' (' + tuningConfig.sourceName + ')' : '') + '.');
}

function mapNativeAccidentalSymbols(nativeAccidentals, tuningConfig) {
    if (!nativeAccidentals)
        return null;

    var mappedSymbols = [];
    for (var symCode in nativeAccidentals) {
        var symbols = nativeAccidentalSymbolsForTuning(symCode, tuningConfig);
        if (symbols == null) {
            warnUnmappedNativeAccidental(symCode, tuningConfig);
            continue;
        }

        var count = parseInt(nativeAccidentals[symCode], 10);
        for (var occurrence = 0; occurrence < count; occurrence++)
            mappedSymbols = mappedSymbols.concat(symbols);
    }

    return mappedSymbols.length == 0 ? null :
        accidentalSymbolsFromList(mappedSymbols);
}

function accidentalSymbolChainIndices(accSymbols, tuningConfig) {
    var indices = [];
    if (!accSymbols || !tuningConfig || !tuningConfig.accChains)
        return indices;

    function addIndex(chainIdx) {
        if (indices.indexOf(chainIdx) == -1)
            indices.push(chainIdx);
    }

    for (var chainIdx = 0; chainIdx < tuningConfig.accChains.length; chainIdx++) {
        var symbolsUsed = tuningConfig.accChains[chainIdx].symbolsUsed || [];
        for (var symCode in accSymbols) {
            if (symbolsUsed.indexOf(String(symCode)) != -1 ||
                symbolsUsed.indexOf(parseInt(symCode, 10)) != -1) {
                addIndex(chainIdx);
                break;
            }
        }
    }

    // A ligature glyph represents the accidental chains listed by `regarding`,
    // even though the replacement glyph does not occur in symbolsUsed.
    for (var ligIdx = 0; ligIdx < tuningConfig.ligatures.length; ligIdx++) {
        var ligature = tuningConfig.ligatures[ligIdx];
        for (var ligAv in ligature.ligAvToSymbols) {
            var ligatureSymbols = ligature.ligAvToSymbols[ligAv];
            if (subtractAccSym(accSymbols, ligatureSymbols) == null)
                continue;

            for (var regardingIdx = 0;
                regardingIdx < ligature.regarding.length;
                regardingIdx++) {
                addIndex(ligature.regarding[regardingIdx]);
            }
        }
    }

    return indices;
}

function accidentalChainIndicesOverlap(a, b) {
    for (var i = 0; i < a.length; i++) {
        if (b.indexOf(a[i]) != -1)
            return true;
    }
    return false;
}

function hasUnchainedPrimaryAccidentalSymbol(accSymbols, tuningConfig,
    chainIndices) {
    if (!accSymbols || chainIndices.length != 0)
        return false;

    for (var symCode in accSymbols) {
        if (tuningConfig.usedSymbols[symCode])
            return true;
    }
    return false;
}

function effectiveAccidentalSymbols(msNote, tuningConfig) {
    if (!msNote)
        return null;

    if (!tuningConfig)
        return normalizeAccidentalSymbols(msNote.accidentals);

    var rawAttached = normalizeAccidentalSymbols(msNote.attachedAccidentals);
    var rawNativeSymbols = normalizeAccidentalSymbols(
        mapNativeAccidentalSymbols(msNote.nativeAccidentals, tuningConfig));
    var rawCombined = normalizeAccidentalSymbols(
        addAccSym(rawNativeSymbols, rawAttached));

    // Compose cross-source glyph parts before filtering. A score may encode a
    // native sharp plus an attached arrow, while the tuning declares only the
    // single combined sharp-arrow SymbolCode.
    var combined = removeUnusedSymbols(rawCombined, tuningConfig);
    var attached = removeUnusedSymbols(rawAttached, tuningConfig);
    var nativeSymbols = removeUnusedSymbols(rawNativeSymbols, tuningConfig);
    attached = normalizeAccidentalSymbols(attached);
    nativeSymbols = normalizeAccidentalSymbols(nativeSymbols);
    combined = normalizeAccidentalSymbols(combined);

    if (attached == null)
        return combined || nativeSymbols;
    if (nativeSymbols == null)
        return combined || attached;

    var attachedChains = accidentalSymbolChainIndices(attached, tuningConfig);
    var nativeChains = accidentalSymbolChainIndices(nativeSymbols, tuningConfig);

    // Plugin symbols on the same accidental chain replace a stale/conflicting
    // native accidental. Symbols on other chains (or secondary-only symbols)
    // augment the native accidental, supporting combinations such as a native
    // sharp plus a plugin arrow/comma modifier.
    if (hasUnchainedPrimaryAccidentalSymbol(
        attached, tuningConfig, attachedChains) ||
        accidentalChainIndicesOverlap(attachedChains, nativeChains)) {
        return attached;
    }

    return combined || normalizeAccidentalSymbols(
        addAccSym(nativeSymbols, attached));
}

function effectiveAccidentalHash(msNote, tuningConfig) {
    var symbols = effectiveAccidentalSymbols(msNote, tuningConfig);
    return symbols == null ? null : normalizeAccidentalHash(accidentalsHash(symbols));
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

    var mappedSymbols = mapNativeAccidentalSymbols(
        accidentalSymbolsFromList(symCodes),
        tuningConfig
    );
    if (mappedSymbols == null)
        return null;

    return removeUnusedSymbols(accidentalsHash(mappedSymbols), tuningConfig);
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

    var hasAttachedAccidental = false;

    /** @type {AccidentalSymbols} */
    var attachedAccidentals = {};

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
                addAccidentalSymbol(attachedAccidentals, asciiSymCode);

                hasAttachedAccidental = true;
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
                addAccidentalSymbol(attachedAccidentals, acc);
                hasAttachedAccidental = true;
            }
        }
    }

    var nativeAccidental = nativeAccidentalSymbolCode(note);
    var nativeAccidentals = null;
    if (nativeAccidental != null)
        nativeAccidentals = accidentalSymbolsFromList([nativeAccidental]);

    var attachedAccidentalState = hasAttachedAccidental ? attachedAccidentals : null;

    /** @type {MSNote} */
    var msNote = { // MSNote
        midiNote: note.pitch,
        tpc: note.tpc,
        nominalsFromA4: nominals + (octavesFromA4 * 7),
        // Compatibility view: plugin-attached symbols take precedence over a
        // native accidental. The unmerged sources are retained so callers
        // with a TuningConfig can fall back to the native symbol when the
        // attached symbols are unrelated to the active tuning.
        accidentals: attachedAccidentalState || nativeAccidentals,
        attachedAccidentals: attachedAccidentalState,
        nativeAccidentals: nativeAccidentals,
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
 * Extract the primary accidental spelling from an effective accidental hash.
 * Secondary accidentals are intentionally ignored so contextual enharmonic
 * choice can compare the primary AccidentalVector only.
 *
 * Matching order mirrors readNoteData(): ligatures first, then each declared
 * accidental chain in order.
 *
 * @param {AccidentalHash?} accHash
 * @param {TuningConfig} tuningConfig
 * @returns {AccidentalHash?}
 */
function primaryAccidentalHash(accHash, tuningConfig) {
    var filteredHash = removeUnusedSymbols(accHash, tuningConfig);
    var remaining = accidentalSymbolsFromHash(filteredHash);
    if (remaining == null)
        return null;

    var primarySymbols = [];

    for (var ligIdx = 0; ligIdx < tuningConfig.ligatures.length; ligIdx++) {
        var ligature = tuningConfig.ligatures[ligIdx];
        var mostLigatureSymbols = 0;
        var bestLigatureSymbols = null;
        var bestLigatureRemaining = remaining;

        for (var ligHash in ligature.ligAvToSymbols) {
            var ligatureSymbols = ligature.ligAvToSymbols[ligHash];
            var ligatureRemainder = subtractAccSym(remaining, ligatureSymbols);
            if (ligatureRemainder != null &&
                ligatureSymbols.length > mostLigatureSymbols) {
                mostLigatureSymbols = ligatureSymbols.length;
                bestLigatureSymbols = ligatureSymbols;
                bestLigatureRemaining = ligatureRemainder;
            }
        }

        if (bestLigatureSymbols != null) {
            primarySymbols = bestLigatureSymbols.concat(primarySymbols);
            remaining = bestLigatureRemaining;
        }
    }

    for (var chainIdx = 0; chainIdx < tuningConfig.accChains.length; chainIdx++) {
        var degreesSymbols = tuningConfig.accChains[chainIdx].degreesSymbols;
        var mostChainSymbols = 0;
        var bestChainSymbols = null;
        var bestChainRemaining = remaining;

        for (var degreeIdx = 0; degreeIdx < degreesSymbols.length; degreeIdx++) {
            var degreeSymbols = degreesSymbols[degreeIdx];
            if (degreeSymbols == null)
                continue;

            var chainRemainder = subtractAccSym(remaining, degreeSymbols);
            if (chainRemainder != null &&
                degreeSymbols.length > mostChainSymbols) {
                mostChainSymbols = degreeSymbols.length;
                bestChainSymbols = degreeSymbols;
                bestChainRemaining = chainRemainder;
            }
        }

        if (bestChainSymbols != null) {
            primarySymbols = bestChainSymbols.concat(primarySymbols);
            remaining = bestChainRemaining;
        }
    }

    return primarySymbols.length == 0 ? null : accidentalsHash(primarySymbols);
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
