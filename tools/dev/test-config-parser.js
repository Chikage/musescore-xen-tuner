// Copyright (C) 2023 euwbah
// This file is part of Xen Tuner. See ../../Xen Tuner/runtime/fns.js for license.

var assert = require("assert");
var childProcess = require("child_process");
var fs = require("fs");
var os = require("os");
var path = require("path");
var vm = require("vm");

var root = path.resolve(__dirname, "../..");
var context = {
    console: console,
    Math: Math,
    JSON: JSON,
    Object: Object,
    Number: Number,
    String: String,
    Array: Array,
    parseFloat: parseFloat,
    parseInt: parseInt,
    isNaN: isNaN,
    eval: eval,
    window: {}
};

context.global = context;
vm.createContext(context);

[
    "Xen Tuner/runtime/tables/generated-tables.js",
    "Xen Tuner/runtime/tables/lookup-tables.js",
    "Xen Tuner/runtime/modules/00-runtime.js",
    "Xen Tuner/runtime/modules/01-lifecycle-cache.js",
    "Xen Tuner/runtime/modules/02-symbols-and-notes.js",
    "Xen Tuner/runtime/modules/03-config-parser.js",
    "Xen Tuner/runtime/modules/04-note-tuning.js",
    "Xen Tuner/runtime/modules/05-score-navigation.js",
    "Xen Tuner/runtime/modules/06-note-editing.js",
    "Xen Tuner/runtime/modules/07-layout-display.js",
    "Xen Tuner/runtime/modules/08-operations.js"
].forEach(function (file) {
    vm.runInContext(fs.readFileSync(path.join(root, file), "utf8"), context, { filename: file });
});

context.Lookup = context.ImportLookup();
// MuseScore 3.6.2 libmscore/types.h AccidentalType numeric order.
context.Accidental = {
    NONE: 0,
    FLAT: 1,
    NATURAL: 2,
    SHARP: 3,
    SHARP2: 4,
    FLAT2: 5
};
context.fileIO = null;
context._curScore = {
    metaTag: function () { return ""; },
    setMetaTag: function () { }
};

context.pluginHomePath = "PROJECT/";
assert.strictEqual(
    context.tuningConfigFilePath("heji/5 limit", ".txt"),
    "PROJECT/tunings/heji/5 limit.txt",
    "tuning config paths default to the tunings folder"
);
assert.strictEqual(
    context.tuningConfigFilePath("/test/26edo", ".txt"),
    "PROJECT/tunings/test/26edo.txt",
    "leading slash stays relative to the tunings folder"
);
assert.strictEqual(
    context.tuningConfigSourceName("/test/26edo", ".txt"),
    "tunings/test/26edo.txt",
    "source labels normalize leading slashes under the tunings folder"
);
context.pluginHomePath = "";

function approx(actual, expected, label) {
    assert.ok(
        Math.abs(actual - expected) < 1e-9,
        label + ": expected " + expected + ", got " + actual
    );
}

var edo26Step = 1200 / 26;

approx(context.parseCentsOrRatio("-400c"), -400, "negative cents");
approx(context.parseCentsOrRatio("-1\\26"), -edo26Step, "negative equal division with backslash");
approx(context.parseCentsOrRatio("-1ed26"), -edo26Step, "negative equal division with ed");
approx(context.parseCentsOrRatio("-1ed3"), -400, "negative edo shorthand");
approx(context.parseCentsOrRatio("1\\26ed3"), 1200 * Math.log(3) / Math.log(2) / 26, "equal division of non-octave");
assert.strictEqual(context.parseCentsOrRatio("1\\0", true), null, "reject zero equal-division denominator");
assert.strictEqual(context.parseCentsOrRatio("1\\26ed-3", true), null, "reject negative equal-division base");

function fakeNote(nativeAccidentalLabel, elements, nativeAccidentalType) {
    return {
        pitch: 60,
        tpc: 14,
        accidental: nativeAccidentalLabel == null ? null : {
            toString: function () { return nativeAccidentalLabel; }
        },
        accidentalType: nativeAccidentalType,
        elements: elements || [],
        parent: { parent: { tick: 0 } },
        line: 0
    };
}

function assertAccidentals(actual, expected, label) {
    assert.strictEqual(JSON.stringify(actual), JSON.stringify(expected), label);
}

assertAccidentals(
    context.tokenizeNote(fakeNote("SHARP")).accidentals,
    { "5": 1 },
    "native sharp accidental should tokenize as sharp SymbolCode"
);

var sevenNominalTuning = context.parseTuningConfig(
    fs.readFileSync(path.join(root, "tunings/default.txt"), "utf8"),
    true,
    true
);
var loadedSharpKeySignature = context.parseKeySignatureJSON(JSON.stringify({
    ver: "ks",
    ksn: "Test sharp order",
    seq: "4152637",
    sgn: ["5", "5", "5", "0", "0", "0", "0"]
}), sevenNominalTuning);
assert.strictEqual(loadedSharpKeySignature.ok, true, "key signature JSON parses");
assert.strictEqual(loadedSharpKeySignature.name, "Test sharp order", "key signature name is retained");
assert.strictEqual(
    loadedSharpKeySignature.entries.map(function (entry) { return entry.nativeNominal; }).join(","),
    "5,2,6,3,0,4,1",
    "numeric seq uses C-based scale degrees"
);
assert.strictEqual(
    context.loadedKeySignatureSequenceKind(loadedSharpKeySignature.entries),
    "sharp",
    "4152637 uses sharp-order key-signature placement"
);
assert.strictEqual(
    loadedSharpKeySignature.entries.map(function (entry, index) {
        return context.loadedKeySignatureStaffY(
            entry.nativeNominal,
            "sharp",
            "treble",
            index
        );
    }).join(","),
    "0,1.5,-0.5,1,2.5,0.5,2",
    "sharp-order treble placement matches standard key signature shape"
);
assert.strictEqual(
    loadedSharpKeySignature.declarationText,
    "keysig! 5 0 0 5 5 0 0",
    "loaded key signature is converted to tuning nominal order"
);
assert.strictEqual(
    context.parsePossibleConfigs(loadedSharpKeySignature.declarationText, 120).priority,
    40,
    "loaded key signature declaration overrides other signatures at the same tick"
);
var loadedLetterKeySignature = context.parseKeySignatureJSON(JSON.stringify({
    ver: "ks",
    ksn: "Letter order",
    seq: "FCGDAEB",
    sgn: ["5", "5", "5", "0", "0", "0", "0"]
}), sevenNominalTuning);
assert.strictEqual(loadedLetterKeySignature.ok, true, "letter seq parses");
assert.strictEqual(
    loadedLetterKeySignature.declarationText,
    loadedSharpKeySignature.declarationText,
    "letter and numeric sharp orders are equivalent"
);
assert.strictEqual(
    context.parseKeySignatureJSON('{"ver":"tuning","seq":"4152637","sgn":[]}', sevenNominalTuning).ok,
    false,
    "non-key-signature JSON is rejected"
);
assert.strictEqual(
    context.parseKeySignatureJSON(JSON.stringify({
        ver: "ks",
        seq: "4",
        sgn: ["'undefined-ascii-symbol"]
    }), sevenNominalTuning).ok,
    false,
    "symbols not defined by the current tuning are rejected"
);

var loadedFlatLikeKeySignature = context.parseKeySignatureJSON(JSON.stringify({
    ver: "ks",
    ksn: "Flat order",
    seq: "7362514",
    sgn: ["6", "6", "6", "0", "0", "0", "0"]
}), sevenNominalTuning);
assert.strictEqual(loadedFlatLikeKeySignature.ok, true, "flat-order key signature parses");
assert.strictEqual(
    context.loadedKeySignatureSequenceKind(loadedFlatLikeKeySignature.entries),
    "flat",
    "7362514 uses flat-order key-signature placement"
);
assert.strictEqual(
    loadedFlatLikeKeySignature.entries.map(function (entry, index) {
        return context.loadedKeySignatureStaffY(
            entry.nativeNominal,
            "flat",
            "treble",
            index
        );
    }).join(","),
    "2,0.5,2.5,1,3,1.5,3.5",
    "flat-order treble placement matches standard key signature shape"
);
assert.strictEqual(
    loadedFlatLikeKeySignature.entries.map(function (entry, index) {
        return context.loadedKeySignatureStaffY(
            entry.nativeNominal,
            "flat",
            "bass",
            index
        );
    }).join(","),
    "3,1.5,3.5,2,4,2.5,4.5",
    "flat-order bass placement keeps the same shape one line lower"
);

context.LOADED_KEY_SIGNATURE_VISUAL_Z = 9200;
context.LOADED_KEY_SIGNATURE_VISUAL_GROUP_SIZE = 50;
context.LOADED_KEY_SIGNATURE_VISUAL_Z_LIMIT =
    context.LOADED_KEY_SIGNATURE_VISUAL_Z +
    7 * context.LOADED_KEY_SIGNATURE_VISUAL_GROUP_SIZE - 1;
context.OLD_LOADED_KEY_SIGNATURE_VISUAL_Z = 8500;
context.OLD_LOADED_KEY_SIGNATURE_VISUAL_Z_LIMIT = 8999;
var drawnKeySigEntries = context.loadedKeySignatureVisualEntriesAtCursor({
    segment: {
        annotations: [
            { track: 0, z: context.loadedKeySignatureVisualZ(5, 0), text: "<sym>accidentalSharp</sym>", offsetX: 1, offsetY: 1 },
            { track: 0, z: context.loadedKeySignatureVisualZ(2, 0), text: "<sym>accidentalSharp</sym>", offsetX: 2, offsetY: 2.5 },
            { track: 0, z: context.loadedKeySignatureVisualZ(6, 0), text: "<sym>accidentalSharp</sym>", offsetX: 3, offsetY: 0.5 }
        ]
    }
}, 0);
var drawnKeySig = context.loadedKeySignatureKeySigFromVisualEntries(
    drawnKeySigEntries,
    sevenNominalTuning
);
assert.strictEqual(
    drawnKeySig.join("|"),
    loadedSharpKeySignature.keySig.join("|"),
    "drawn key signature symbols restore the same KeySig without hidden text"
);
assertAccidentals(
    context.tokenizeNote(fakeNote("FLAT")).accidentals,
    { "6": 1 },
    "native flat accidental should tokenize as flat SymbolCode"
);
assertAccidentals(
    context.tokenizeNote(fakeNote("NATURAL")).accidentals,
    { "2": 1 },
    "native natural accidental should tokenize as natural SymbolCode"
);
assert.strictEqual(
    context.tokenizeNote(fakeNote("NONE")).accidentals,
    null,
    "native NONE accidental should not count as an accidental"
);
assertAccidentals(
    context.tokenizeNote(fakeNote(null, [], context.Accidental.SHARP)).accidentals,
    { "5": 1 },
    "native sharp accidentalType should tokenize as sharp SymbolCode"
);
assertAccidentals(
    context.tokenizeNote(fakeNote(null, [], context.Accidental.FLAT)).accidentals,
    { "6": 1 },
    "native flat accidentalType should tokenize as flat SymbolCode"
);
assertAccidentals(
    context.tokenizeNote(fakeNote(null, [], context.Accidental.NATURAL)).accidentals,
    { "2": 1 },
    "native natural accidentalType should tokenize as natural SymbolCode"
);
assert.strictEqual(
    context.tokenizeNote(fakeNote(null, [], context.Accidental.NONE)).accidentals,
    null,
    "native NONE accidentalType should not count as an accidental"
);

var originalSymId = context.SymId;
context.SymId = {
    accidentalSharp: context.Accidental.FLAT,
    accidentalFlat: context.Accidental.NATURAL,
    accidentalNatural: context.Accidental.SHARP
};
assertAccidentals(
    context.tokenizeNote(fakeNote(null, [], context.Accidental.FLAT)).accidentals,
    { "6": 1 },
    "MuseScore 3 FLAT enum value should not be mistaken for a SymId"
);
assertAccidentals(
    context.tokenizeNote(fakeNote(null, [], context.Accidental.NATURAL)).accidentals,
    { "2": 1 },
    "MuseScore 3 NATURAL enum value should not be mistaken for a SymId"
);
assertAccidentals(
    context.tokenizeNote(fakeNote(null, [], context.Accidental.SHARP)).accidentals,
    { "5": 1 },
    "MuseScore 3 SHARP enum value should not be mistaken for a SymId"
);
assert.strictEqual(
    context.nativeAccidentalTypeSymbolCode(String(context.Accidental.SHARP)),
    5,
    "numeric accidentalType strings should resolve through the Accidental enum"
);
assertAccidentals(
    context.tokenizeNote(fakeNote(
        String(context.Accidental.SHARP),
        [],
        context.Accidental.SHARP
    )).accidentals,
    { "5": 1 },
    "an ambiguous wrapper string should defer to note.accidentalType"
);
if (originalSymId === undefined) {
    delete context.SymId;
} else {
    context.SymId = originalSymId;
}

var pluginSharpOverNativeFlat = context.tokenizeNote(fakeNote("FLAT", [{
    symbol: { toString: function () { return "accidentalSharp"; } }
}]));
assertAccidentals(
    pluginSharpOverNativeFlat.accidentals,
    { "5": 1 },
    "attached Xen Tuner symbols should take precedence over native accidentals"
);
assertAccidentals(
    pluginSharpOverNativeFlat.attachedAccidentals,
    { "5": 1 },
    "tokenized notes should retain plugin-attached accidentals separately"
);
assertAccidentals(
    pluginSharpOverNativeFlat.nativeAccidentals,
    { "6": 1 },
    "tokenized notes should retain native accidentals for tuning-aware fallback"
);

function assertKeySig(actual, expected, label) {
    assert.strictEqual(JSON.stringify(actual), JSON.stringify(expected), label);
}

function assertApproxLookup(actual, expected, label) {
    assert.strictEqual(
        JSON.stringify(Object.keys(actual).sort()),
        JSON.stringify(Object.keys(expected).sort()),
        label + " keys"
    );

    Object.keys(expected).forEach(function (key) {
        approx(actual[key], expected[key], label + " " + key);
    });
}

function assertJSONLookup(actual, expected, label) {
    assert.strictEqual(
        JSON.stringify(Object.keys(actual).sort()),
        JSON.stringify(Object.keys(expected).sort()),
        label + " keys"
    );

    Object.keys(expected).forEach(function (key) {
        assert.strictEqual(JSON.stringify(actual[key]), JSON.stringify(expected[key]), label + " " + key);
    });
}

var aReferenceTuningConfig = context.parseTuningConfig([
    "A4: 440",
    "0c 200c 300c 500c 700c 800c 1000c 1200c",
    "b (100c) #"
].join("\n"), true, true);

assertKeySig(
    context.nativeKeySignatureToKeySig(2, aReferenceTuningConfig),
    [null, null, "5 1", null, null, "5 1", null],
    "native two-sharp key signature should map C and F for A-reference tunings"
);
assertKeySig(
    context.nativeKeySignatureToKeySig(-3, aReferenceTuningConfig),
    ["6 1", "6 1", null, null, "6 1", null, null],
    "native three-flat key signature should map B, E, and A for A-reference tunings"
);

var cReferenceTuningConfig = context.parseTuningConfig([
    "C4: 261.6255653005986",
    "0c 200c 400c 500c 700c 900c 1100c 1200c",
    "b (100c) #"
].join("\n"), true, true);
assertKeySig(
    context.nativeKeySignatureToKeySig(2, cReferenceTuningConfig),
    ["5 1", null, null, "5 1", null, null, null],
    "native two-sharp key signature should map C and F for C-reference tunings"
);

var customGlyphNativeMappingTuning = context.parseTuningConfig([
    "C4: 261.6255653005986",
    "0c 200c 400c 500c 700c 900c 1100c 1200c",
    "20 (100c) 21"
].join("\n"), true, true);
assert.ok(customGlyphNativeMappingTuning, "custom-glyph native mapping tuning should parse");
assertAccidentals(
    context.effectiveAccidentalSymbols(
        context.tokenizeNote(fakeNote("SHARP")),
        customGlyphNativeMappingTuning
    ),
    { "21": 1 },
    "native sharp should map to degree +1 of the tuning's primary accidental chain"
);
assertAccidentals(
    context.effectiveAccidentalSymbols(
        context.tokenizeNote(fakeNote("FLAT")),
        customGlyphNativeMappingTuning
    ),
    { "20": 1 },
    "native flat should map to degree -1 of the tuning's primary accidental chain"
);
assertKeySig(
    context.nativeKeySignatureToKeySig(1, customGlyphNativeMappingTuning),
    [null, null, null, "21 1", null, null, null],
    "native G-major key signature should use the tuning's mapped sharp glyph"
);
assert.strictEqual(
    context.cursorKeySignatureAccidentalHashAtLine({
        keySignatureSymbolsAtLineForStaff: function () {
            return [{ symbol: "accidentalSharp" }];
        }
    }, 0, 0, 0, customGlyphNativeMappingTuning),
    "21 1",
    "native per-line key-signature symbols should use the same tuning mapping"
);

var multiChainCustomGlyphMappingTuning = context.parseTuningConfig([
    "C4: 261.6255653005986",
    "0c 200c 400c 500c 700c 900c 1100c 1200c",
    "100 (20c) 101",
    "20 (100c) 21"
].join("\n"), true, true);
assert.ok(
    multiChainCustomGlyphMappingTuning,
    "multi-chain custom-glyph native mapping tuning should parse"
);
assertAccidentals(
    context.effectiveAccidentalSymbols(
        context.tokenizeNote(fakeNote("SHARP")),
        multiChainCustomGlyphMappingTuning
    ),
    { "21": 1 },
    "native sharp should map to the custom chain closest to a semitone, not the first comma chain"
);

assertAccidentals(
    context.effectiveAccidentalSymbols(pluginSharpOverNativeFlat, cReferenceTuningConfig),
    { "5": 1 },
    "attached accidentals used by the current tuning should remain preferred"
);
assert.strictEqual(
    context.effectiveAccidentalHash(pluginSharpOverNativeFlat, cReferenceTuningConfig),
    "5 1",
    "effective accidental hash should use a supported attached accidental"
);

var unsupportedPluginAccidentalOverNativeFlat = context.tokenizeNote(fakeNote("FLAT", [{
    symbol: { toString: function () { return "accidentalDoubleSharp"; } }
}]));
assertAccidentals(
    unsupportedPluginAccidentalOverNativeFlat.accidentals,
    { "4": 1 },
    "compatibility accidental view should still prefer an attached plugin symbol"
);
assertAccidentals(
    unsupportedPluginAccidentalOverNativeFlat.nativeAccidentals,
    { "6": 1 },
    "native accidental should remain available behind an unsupported plugin symbol"
);
assertAccidentals(
    context.effectiveAccidentalSymbols(
        unsupportedPluginAccidentalOverNativeFlat, cReferenceTuningConfig),
    { "6": 1 },
    "unsupported attached symbols should fall back to the native accidental"
);
assert.strictEqual(
    context.effectiveAccidentalHash(
        unsupportedPluginAccidentalOverNativeFlat, cReferenceTuningConfig),
    "6 1",
    "effective accidental hash should use the native fallback"
);

var twoChainNativePluginTuning = context.parseTuningConfig([
    "C4: 261.6255653005986",
    "0c 200c 400c 500c 700c 900c 1100c 1200c",
    "b (100c) #",
    "v (25c) ^",
    "lig(1,2)!",
    "1 1 #^"
].join("\n"), true, true);
assert.ok(twoChainNativePluginTuning, "two-chain native/plugin accidental tuning should parse");
assert.strictEqual(
    !!twoChainNativePluginTuning.usedSymbols["32"],
    true,
    "two-chain tuning should declare the composed sharp-up symbol"
);
assert.strictEqual(
    !!twoChainNativePluginTuning.usedSymbols["41"],
    false,
    "two-chain tuning should not directly declare the raw arrow-up symbol"
);

var nativeSharpWithAttachedArrow = context.tokenizeNote(fakeNote("SHARP", [{
    symbol: { toString: function () { return "accidentalArrowUp"; } }
}]));
assertAccidentals(
    nativeSharpWithAttachedArrow.attachedAccidentals,
    { "41": 1 },
    "raw attached arrow should remain distinct before tuning-aware composition"
);
assertAccidentals(
    nativeSharpWithAttachedArrow.nativeAccidentals,
    { "5": 1 },
    "native sharp should remain available alongside an attached second-chain arrow"
);
assertAccidentals(
    context.effectiveAccidentalSymbols(
        nativeSharpWithAttachedArrow, twoChainNativePluginTuning),
    { "32": 1 },
    "different-chain native and attached accidentals should compose before tuning filtering"
);
assert.strictEqual(
    context.effectiveAccidentalHash(
        nativeSharpWithAttachedArrow, twoChainNativePluginTuning),
    "32 1",
    "native sharp plus attached arrow should use the canonical composed hash"
);

var attachedSharpOverNativeFlatInTwoChains = context.tokenizeNote(fakeNote("FLAT", [{
    symbol: { toString: function () { return "accidentalSharp"; } }
}]));
assert.strictEqual(
    context.effectiveAccidentalHash(
        attachedSharpOverNativeFlatInTwoChains, twoChainNativePluginTuning),
    "5 1",
    "attached accidental should still win over a native accidental in the same chain"
);

var stalePluginSymbol = {
    symbol: { toString: function () { return "accidentalDoubleSharp"; } },
    z: 1000
};
var userOwnedUnknownToTuningSymbol = {
    symbol: { toString: function () { return "accidentalDoubleSharp"; } },
    z: 20
};
var noteDuringTuningSwitch = fakeNote(null, [
    stalePluginSymbol,
    userOwnedUnknownToTuningSymbol
], context.Accidental.NONE);
noteDuringTuningSwitch.remove = function (element) {
    var index = this.elements.indexOf(element);
    if (index != -1)
        this.elements.splice(index, 1);
};
noteDuringTuningSwitch.add = function (element) {
    this.elements.push(element);
};
context.setAccidental(
    noteDuringTuningSwitch,
    [5],
    function () {
        throw new Error("single native sharp should not require a plugin element");
    },
    cReferenceTuningConfig
);
assert.strictEqual(
    noteDuringTuningSwitch.elements.indexOf(stalePluginSymbol),
    -1,
    "tuning switch should remove stale plugin-owned symbols even when unused by the new tuning"
);
assert.notStrictEqual(
    noteDuringTuningSwitch.elements.indexOf(userOwnedUnknownToTuningSymbol),
    -1,
    "tuning switch should preserve user-owned symbols unknown to the new tuning"
);
assert.strictEqual(
    noteDuringTuningSwitch.accidentalType,
    context.Accidental.SHARP,
    "tuning switch should replace the stale plugin glyph with a native sharp"
);

function fakeNavigationNote(nativeAccidentalType, tick, line) {
    var note = fakeNote(null, [], nativeAccidentalType);
    note.pitch = 62;
    note.tpc = 16;
    note.parent = { parent: { tick: tick } };
    note.line = line;
    note.track = 0;
    note.voice = 0;
    return note;
}

function dNaturalNavigationData(note, tuningConfig) {
    tuningConfig = tuningConfig || cReferenceTuningConfig;
    return {
        ms: {
            internalNote: note,
            tick: context.getTick(note)
        },
        xen: tuningConfig.notesTable["1"],
        equaves: 0
    };
}

function assertNextDSharp(nextNote, label, tuningConfig) {
    tuningConfig = tuningConfig || cReferenceTuningConfig;
    assert.ok(nextNote, label + " should find a next note");
    assert.strictEqual(nextNote.matchPriorAcc, true, label + " should match prior accidental state");
    assert.strictEqual(nextNote.nominal, 1, label + " should retain the D target nominal");
    assert.strictEqual(nextNote.xen.nominal, 1, label + " XenNote should retain the D target nominal");
    assert.strictEqual(nextNote.xen.hash, "1 5 1", label + " should choose D-sharp over E-flat");
    assert.strictEqual(
        nextNote.xen,
        tuningConfig.notesTable["1 5 1"],
        label + " should return the target nominal's XenNote"
    );
}

var dNaturalUnderNativeKeySignature = fakeNavigationNote(context.Accidental.NONE, 10, 0);
var nativeFourSharpKeySig = context.nativeKeySignatureToKeySig(4, cReferenceTuningConfig);
assert.strictEqual(
    nativeFourSharpKeySig[1],
    "5 1",
    "native four-sharp key signature should sharpen D"
);
var originalGetAccidental = context.getAccidental;
var nextFromNativeKeySignature;
context.getAccidental = function () { return null; };
try {
    nextFromNativeKeySignature = context.chooseNextNote(
        1,
        null,
        dNaturalNavigationData(dNaturalUnderNativeKeySignature),
        nativeFourSharpKeySig,
        cReferenceTuningConfig,
        0,
        100,
        {}
    );
} finally {
    context.getAccidental = originalGetAccidental;
}
assertNextDSharp(
    nextFromNativeKeySignature,
    "chooseNextNote with a native key signature"
);

var nextFromNativeKeySignatureSymbols;
context.getAccidental = function () { return null; };
try {
    nextFromNativeKeySignatureSymbols = context.chooseNextNote(
        1,
        null,
        dNaturalNavigationData(dNaturalUnderNativeKeySignature),
        null,
        cReferenceTuningConfig,
        0,
        100,
        {
            keySignatureSymbolsAtLineForStaff: function (line, tick, staffIdx) {
                if (line == 0 && tick == 10 && staffIdx == 0)
                    return [{ symbol: "accidentalSharp" }];
                return [];
            }
        }
    );
} finally {
    context.getAccidental = originalGetAccidental;
}
assertNextDSharp(
    nextFromNativeKeySignatureSymbols,
    "chooseNextNote with MuseScore-native key-signature symbols"
);

var priorNativeDSharp = fakeNavigationNote(context.Accidental.SHARP, 0, 0);
var dNaturalAfterNativeDSharp = fakeNavigationNote(context.Accidental.NONE, 10, 0);
var originalReadBarState = context.readBarState;
var nextFromNativeTemporaryAccidental;
context.readBarState = function () {
    return {
        "0": {
            "0": [
                [[priorNativeDSharp]],
                [],
                [],
                []
            ]
        }
    };
};
try {
    nextFromNativeTemporaryAccidental = context.chooseNextNote(
        1,
        null,
        dNaturalNavigationData(dNaturalAfterNativeDSharp),
        null,
        cReferenceTuningConfig,
        0,
        100,
        {}
    );
} finally {
    context.readBarState = originalReadBarState;
}
assertNextDSharp(
    nextFromNativeTemporaryAccidental,
    "chooseNextNote with a native temporary accidental"
);

var primarySharpSecondaryCommaTuning = context.parseTuningConfig([
    "C4: 261.6255653005986",
    "0c 200c 400c 500c 700c 900c 1100c 1200c",
    "b (100c) #",
    "sec()",
    "104 20c"
].join("\n"), true, true);
assert.ok(
    primarySharpSecondaryCommaTuning,
    "primary sharp plus secondary comma tuning should parse"
);
var priorNativeDSharpWithSecondaryComma = fakeNavigationNote(
    context.Accidental.SHARP, 0, 0);
priorNativeDSharpWithSecondaryComma.elements = [{
    symbol: { toString: function () { return "accidentalJohnstonPlus"; } }
}];
var tokenizedPrimarySharpSecondaryComma = context.tokenizeNote(
    priorNativeDSharpWithSecondaryComma);
assert.strictEqual(
    context.effectiveAccidentalHash(
        tokenizedPrimarySharpSecondaryComma,
        primarySharpSecondaryCommaTuning
    ),
    "5 1 104 1",
    "effective accidental should retain native primary and plugin secondary symbols"
);
assert.strictEqual(
    context.primaryAccidentalHash("5 1 104 1", primarySharpSecondaryCommaTuning),
    "5 1",
    "primary accidental hash should ignore a secondary comma"
);

var dNaturalAfterPrimarySharpSecondaryComma = fakeNavigationNote(
    context.Accidental.NONE, 10, 0);
var originalReadBarStateWithSecondary = context.readBarState;
var nextFromPrimarySharpSecondaryComma;
context.readBarState = function () {
    return {
        "0": {
            "0": [
                [[priorNativeDSharpWithSecondaryComma]],
                [],
                [],
                []
            ]
        }
    };
};
try {
    nextFromPrimarySharpSecondaryComma = context.chooseNextNote(
        1,
        null,
        dNaturalNavigationData(
            dNaturalAfterPrimarySharpSecondaryComma,
            primarySharpSecondaryCommaTuning
        ),
        null,
        primarySharpSecondaryCommaTuning,
        0,
        100,
        {}
    );
} finally {
    context.readBarState = originalReadBarStateWithSecondary;
}
assertNextDSharp(
    nextFromPrimarySharpSecondaryComma,
    "chooseNextNote with primary sharp plus secondary comma context",
    primarySharpSecondaryCommaTuning
);

var nominalOnlyTuning = context.parseTuningConfig([
    "C4: 261.6255653005986",
    "0c 200c 400c 500c 700c 900c 1100c 1200c"
].join("\n"), true, true);
assert.ok(nominalOnlyTuning, "nominal-only tuning should parse");
assert.strictEqual(
    nominalOnlyTuning.accChains.length,
    0,
    "nominal-only tuning should have zero accidental chains"
);
var nominalOnlyD = fakeNavigationNote(context.Accidental.NONE, 10, 0);
var nominalOnlyNoteData = dNaturalNavigationData(nominalOnlyD, nominalOnlyTuning);
var nominalOnlyUp;
var nominalOnlyDown;
context.getAccidental = function () { return null; };
try {
    assert.doesNotThrow(function () {
        nominalOnlyUp = context.chooseNextNote(
            1, null, nominalOnlyNoteData, null, nominalOnlyTuning, 0, 100, {});
    }, "nominal-only chooseNextNote up should not reduce an empty accidental vector without an initial value");
    assert.doesNotThrow(function () {
        nominalOnlyDown = context.chooseNextNote(
            -1, null, nominalOnlyNoteData, null, nominalOnlyTuning, 0, 100, {});
    }, "nominal-only chooseNextNote down should not reduce an empty accidental vector without an initial value");
} finally {
    context.getAccidental = originalGetAccidental;
}
assert.strictEqual(nominalOnlyUp.xen.hash, "2", "nominal-only up should choose E from D");
assert.strictEqual(nominalOnlyDown.xen.hash, "0", "nominal-only down should choose C from D");

var importantLigatureNativeEnharmonicTuning = context.parseTuningConfig([
    "C4: 261.6255653005986",
    "0c 200c 400c 500c 700c 900c 1100c 1200c",
    "b (100c) #",
    "lig(1)!",
    "1 20"
].join("\n"), true, true);
assert.ok(
    importantLigatureNativeEnharmonicTuning,
    "important-ligature native enharmonic tuning should parse"
);
assert.strictEqual(
    importantLigatureNativeEnharmonicTuning.enharmonics["0 5 1"],
    "0 20 1",
    "a native sharp spelling excluded from the preferred cycle should enter the important ligature"
);
assert.strictEqual(
    context.chooseNextNote(
        0,
        null,
        {
            ms: {
                internalNote: fakeNavigationNote(context.Accidental.SHARP, 10, 0),
                tick: 10
            },
            xen: importantLigatureNativeEnharmonicTuning.notesTable["0 5 1"],
            equaves: 0
        },
        null,
        importantLigatureNativeEnharmonicTuning,
        0,
        100,
        {}
    ).xen.hash,
    "0 20 1",
    "enharmonic cycling should convert a native sharp into the preferred important ligature"
);

var edo26JsonConfig = context.parseTuningConfig(
    fs.readFileSync(path.join(root, "tunings/26edo.json"), "utf8"),
    true,
    true
);
var edo26TxtConfig = context.parseTuningConfig(
    fs.readFileSync(path.join(root, "tunings/26edo.txt"), "utf8"),
    true,
    true
);
assert.ok(edo26JsonConfig, "26edo compact JSON tuning config should parse");
assert.ok(edo26TxtConfig, "26edo text tuning config should parse");
assert.strictEqual(
    JSON.stringify(edo26JsonConfig.nominals),
    JSON.stringify(edo26TxtConfig.nominals),
    "26edo JSON and text nominals should match"
);
assert.strictEqual(
    edo26JsonConfig.equaveSize,
    edo26TxtConfig.equaveSize,
    "26edo JSON and text equave should match"
);
assert.strictEqual(
    JSON.stringify(edo26JsonConfig.accChains),
    JSON.stringify(edo26TxtConfig.accChains),
    "26edo JSON and text accidental chains should match"
);
assert.strictEqual(
    JSON.stringify(edo26JsonConfig.auxList),
    JSON.stringify(edo26TxtConfig.auxList),
    "26edo JSON and text aux behavior should match"
);
assertApproxLookup(
    edo26JsonConfig.secondaryTunings,
    edo26TxtConfig.secondaryTunings,
    "26edo JSON and text secondary tunings should match"
);
assertJSONLookup(
    edo26JsonConfig.asciiToSmuflConv,
    edo26TxtConfig.asciiToSmuflConv,
    "26edo JSON and text ascii conversions should match"
);
assertAccidentals(
    context.accidentalSymbolsFromList(context.parseAsciiAccInput("#x", edo26JsonConfig)),
    { "5": 1, "148": 1 },
    "26edo JSON parses #x as a compound accidental"
);
assertAccidentals(
    context.accidentalSymbolsFromList(context.parseAsciiAccInput("##", edo26JsonConfig)),
    { "148": 1 },
    "26edo JSON parses ## before its # prefix"
);
assertAccidentals(
    context.accidentalSymbolsFromList(context.parseAsciiAccInput("bbb", edo26JsonConfig)),
    { "8": 1 },
    "26edo JSON parses bbb before its b prefix"
);
assert.strictEqual(
    edo26JsonConfig.tuningTable["0"][0],
    0,
    "numeric JSON 0 nominal should represent the 1/1 origin"
);

var nativeKeySigEvent = context.createNativeKeySigConfigEvent(2, 10);
var nativeKeySigParms = {
    currTuning: cReferenceTuningConfig,
    currKeySig: null,
    currKeySigSource: null
};
nativeKeySigEvent.config(nativeKeySigParms);
assertKeySig(
    nativeKeySigParms.currKeySig,
    ["5 1", null, null, "5 1", null, null, null],
    "native key signature config event should defer mapping to the active tuning config"
);
assert.strictEqual(
    nativeKeySigParms.currKeySigSource.kind,
    "native-count",
    "native key signature event should preserve its raw source kind"
);
assert.strictEqual(
    nativeKeySigParms.currKeySigSource.value,
    2,
    "native key signature event should preserve its raw accidental count"
);
var cReferenceNativeKeySigArray = nativeKeySigParms.currKeySig;
nativeKeySigParms.currTuning = aReferenceTuningConfig;
context.refreshCurrentKeySignature(nativeKeySigParms);
assertKeySig(
    nativeKeySigParms.currKeySig,
    [null, null, "5 1", null, null, "5 1", null],
    "native key signature source should remap after changing tuning nominal"
);
assert.notStrictEqual(
    nativeKeySigParms.currKeySig,
    cReferenceNativeKeySigArray,
    "native key signature remap should replace the old tuning-relative array"
);

var tuningConfig = context.parseTuningConfig([
    "A4: 440",
    "0c -1\\26 -400c 1200c",
    "b (-1\\26) #",
    "sec()",
    "'b' b -400c"
].join("\n"), true, true);

assert.ok(tuningConfig, "negative interval tuning config should parse");
approx(tuningConfig.nominals[1], -edo26Step, "negative nominal equal-division interval");
approx(tuningConfig.nominals[2], -400, "negative nominal cent interval");
approx(tuningConfig.accChains[0].tunings[0], edo26Step, "negative chain increment lower degree");
approx(tuningConfig.accChains[0].tunings[2], -edo26Step, "negative chain increment upper degree");
approx(tuningConfig.secondaryTunings["6 1"], -400, "negative secondary accidental tuning");
approx(tuningConfig.tuningTable["1"][0], 1200 - edo26Step, "negative nominal wraps into equave");
assert.strictEqual(tuningConfig.tuningTable["1"][1], 1, "negative nominal records equave adjustment");
approx(
    context.calcCentsOffset({
        ms: { midiNote: 69, fingerings: [] },
        xen: tuningConfig.notesTable["1"],
        equaves: 0,
        secondaryAccMatches: {}
    }, tuningConfig, true),
    -edo26Step,
    "wrapped negative nominal sounds below reference"
);

var negativeEquaveConfig = context.parseTuningConfig([
    "A4: 440",
    "0c -400c -1200c"
].join("\r"), true, true);

assert.ok(negativeEquaveConfig, "CR-only negative equave tuning config should parse");
assert.strictEqual(negativeEquaveConfig.equaveSize, -1200, "negative equave should be preserved");
assert.strictEqual(negativeEquaveConfig.stepsList.length, 2, "negative equave notes should not all collapse enharmonically");
approx(negativeEquaveConfig.tuningTable["1"][0], 800, "negative equave wraps negative cents into positive period");
assert.strictEqual(negativeEquaveConfig.tuningTable["1"][1], -1, "negative equave records signed equave adjustment");
approx(
    context.calcCentsOffset({
        ms: { midiNote: 69, fingerings: [] },
        xen: negativeEquaveConfig.notesTable["1"],
        equaves: 0,
        secondaryAccMatches: {}
    }, negativeEquaveConfig, true),
    -400,
    "negative equave wrapped note sounds below reference"
);
assert.strictEqual(
    context.isEnharmonicallyEquivalent(0, 800, -1200),
    false,
    "negative equave enharmonic comparison uses equave magnitude"
);

function assertRuntimeEntryPoint() {
    var bundleContext = {
        console: console,
        Math: Math,
        JSON: JSON,
        Object: Object,
        Number: Number,
        String: String,
        Array: Array,
        parseFloat: parseFloat,
        parseInt: parseInt,
        isNaN: isNaN,
        eval: eval,
        window: {}
    };
    var runtimeRoot = path.join(root, "Xen Tuner/runtime");
    bundleContext.Qt = {
        include: function (sourceFile) {
            var normalizedSource = sourceFile.replace(/^\.\//, "");
            var filename = path.join(runtimeRoot, normalizedSource);
            vm.runInContext(
                fs.readFileSync(filename, "utf8"),
                bundleContext,
                { filename: "Xen Tuner/runtime/" + normalizedSource.replace(/\\/g, "/") }
            );
            return {
                status: 0,
                toString: function () { return "0"; }
            };
        }
    };
    vm.createContext(bundleContext);
    var entryFile = "Xen Tuner/runtime/fns.ms.js";
    vm.runInContext(fs.readFileSync(path.join(root, entryFile), "utf8"), bundleContext, { filename: entryFile });
    bundleContext.Lookup = bundleContext.ImportLookup();
    bundleContext.logn = function () { };
    bundleContext.log = function () { };
    bundleContext._curScore = {
        metaTag: function () { return ""; },
        setMetaTag: function () { }
    };

    approx(bundleContext.parseCentsOrRatio("-400c"), -400, entryFile + " negative cents");
    approx(bundleContext.parseCentsOrRatio("-1\\26"), -edo26Step, entryFile + " negative equal division");
    assert.strictEqual(bundleContext.parseCentsOrRatio("1\\0", true), null, entryFile + " rejects zero denominator");

    var runtimeNegativeEquave = bundleContext.parseTuningConfig([
        "A4: 440",
        "0c -400c -1200c"
    ].join("\r"), true, true);
    assert.ok(runtimeNegativeEquave, entryFile + " parses CR-only negative equave config");
    assert.strictEqual(runtimeNegativeEquave.stepsList.length, 2, entryFile + " negative equave notes do not collapse");
    approx(runtimeNegativeEquave.tuningTable["1"][0], 800, entryFile + " negative equave wraps cents");
    assert.strictEqual(runtimeNegativeEquave.tuningTable["1"][1], -1, entryFile + " negative equave adjustment");

    var runtimeFiles = {
        "tunings/runtime-cache-test.json": "",
        "tunings/runtime-cache-test.txt": [
            "A4: 440",
            "0c 100c 1200c"
        ].join("\n")
    };
    bundleContext.pluginHomePath = "";
    bundleContext.tuningConfigCache = {};
    bundleContext._curScore = {
        cacheText: "",
        metaTag: function () { return this.cacheText; },
        setMetaTag: function (name, value) { this.cacheText = value; }
    };
    bundleContext.fileIO = {
        source: "",
        read: function () {
            return runtimeFiles[this.source] || "";
        }
    };
    approx(
        bundleContext.parseTuningConfig("runtime-cache-test", false, true).nominals[1],
        100,
        entryFile + " cache test starts positive"
    );
    approx(
        bundleContext.parseTuningConfig("/runtime-cache-test", false, true).nominals[1],
        100,
        entryFile + " leading slash still reads from the tunings folder"
    );
    runtimeFiles["tunings/runtime-cache-test.txt"] = [
        "A4: 440",
        "0c -400c 1200c"
    ].join("\n");
    approx(
        bundleContext.parseTuningConfig("runtime-cache-test", false, true).nominals[1],
        -400,
        entryFile + " file content change invalidates cache"
    );

    var compactJsonFiles = {
        "tunings/runtime-json-test.json": fs.readFileSync(path.join(root, "tunings/26edo.json"), "utf8"),
        "tunings/runtime-json-test.txt": ""
    };
    bundleContext.tuningConfigCache = {};
    bundleContext.fileIO = {
        source: "",
        read: function () {
            return compactJsonFiles[this.source] || "";
        }
    };
    var runtimeJsonTuning = bundleContext.parseTuningConfig("runtime-json-test", false, true);
    assert.ok(runtimeJsonTuning, entryFile + " parses compact JSON tuning files");
    assert.strictEqual(runtimeJsonTuning.stepsList.length, 26, entryFile + " compact JSON generates full tuning config");
    approx(runtimeJsonTuning.tuningTable["0"][0], 0, entryFile + " numeric JSON 0 is the 1/1 origin");

    var generatedDir = fs.mkdtempSync(path.join(os.tmpdir(), "xen-tuner-convert-test-"));
    childProcess.execFileSync(
        "python",
        [
            path.join(root, "tools/dev/convert-tuning-configs.py"),
            "txt-to-json",
            path.join(root, "tunings/26edo.txt"),
            "--out-dir",
            generatedDir,
            "--force"
        ],
        { cwd: root, stdio: "pipe" }
    );
    var generatedJSON = fs.readFileSync(path.join(generatedDir, "tunings/26edo.json"), "utf8");
    var generatedJSONTuning = bundleContext.parseTuningConfig(generatedJSON, true, true);
    assert.ok(generatedJSONTuning, entryFile + " parses Python-generated compact JSON");
    assert.strictEqual(generatedJSONTuning.stepsList.length, 26, entryFile + " Python-generated compact JSON has 26 steps");
    try {
        fs.rmSync(generatedDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch (e) {
    }
}

assertRuntimeEntryPoint();

var fakeFiles = {
    "tunings/cache-test.json": "",
    "tunings/cache-test.txt": [
        "A4: 440",
        "0c 100c 1200c"
    ].join("\n")
};
context.pluginHomePath = "";
context.tuningConfigCache = {};
context._curScore = {
    cacheText: "",
    metaTag: function () { return this.cacheText; },
    setMetaTag: function (name, value) { this.cacheText = value; }
};
context.fileIO = {
    source: "",
    read: function () {
        return fakeFiles[this.source] || "";
    }
};

var cachedPositive = context.parseTuningConfig("cache-test", false, true);
approx(cachedPositive.nominals[1], 100, "cache test starts with positive file content");

var leadingSlashPositive = context.parseTuningConfig("/cache-test", false, true);
approx(leadingSlashPositive.nominals[1], 100, "leading slash reads from the tunings folder");

fakeFiles["tunings/cache-test.txt"] = [
    "A4: 440",
    "0c -400c 1200c"
].join("\n");

var cachedNegative = context.parseTuningConfig("cache-test", false, true);
approx(cachedNegative.nominals[1], -400, "file content change invalidates tuning cache");

console.log("config parser tests passed");
