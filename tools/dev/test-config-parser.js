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

assert.strictEqual(
    context.museScoreNominalsFromA4(60, 14),
    -5,
    "MuseScore C4 TPC should resolve to C4 relative to A4"
);
assert.strictEqual(
    context.museScoreCarrierTpc(-6, 60, 14),
    26,
    "B-sharp should carry a C4 MIDI pitch for a B3 Xen spelling"
);
assert.strictEqual(
    context.museScoreNativeAccidentalSymbolCodeForTpc(26),
    5,
    "B-sharp carrier TPC should use MuseScore's native sharp"
);
assert.strictEqual(
    context.museScoreCarrierTpc(-2, 60, 14),
    null,
    "spellings beyond MuseScore's triple-accidental TPC range should be rejected"
);

var previewFingeringRemovals = 0;
var previewFingering = {
    text: "#x",
    z: context.DEFAULT_FINGERING_Z_INDEX
};
var previewFingeringNote = {
    fingerings: [previewFingering],
    internalNote: {
        remove: function () { previewFingeringRemovals++; }
    }
};
assert.strictEqual(
    context.readFingeringAccidentalInput(
        previewFingeringNote, edo26TxtConfig, false).symCodes.join(","),
    "5,148",
    "enharmonic preview should interpret fingering accidental input"
);
assert.strictEqual(previewFingeringRemovals, 0,
    "enharmonic preview must not consume fingering accidental input");
context.readFingeringAccidentalInput(
    previewFingeringNote, edo26TxtConfig, true);
assert.strictEqual(previewFingeringRemovals, 1,
    "committed parsing should consume fingering accidental input exactly once");

function fakeCarrierNote(pitch, tpc, line, tuning, tick) {
    var accidentalWrites = [];
    var note = {
        pitch: pitch,
        tpc: tpc,
        tpc1: tpc,
        tpc2: tpc,
        line: line,
        tuning: tuning,
        playEvents: [{ pitch: -2, ontime: 0, len: 1000 }],
        elements: [],
        accidental: null,
        tieBack: null,
        tieForward: null,
        track: 0,
        voice: 0,
        parent: { parent: { tick: tick } },
        add: function (element) {
            this.elements.push(element);
        },
        remove: function (element) {
            var index = this.elements.indexOf(element);
            if (index != -1)
                this.elements.splice(index, 1);
        },
        is: function (other) {
            return this === other;
        },
        setAccidentalSymbol: function (label) {
            if (context.nativeAccidentalLabelToSymbolCode(label) != 5)
                return false;
            this.accidentalType = context.Accidental.SHARP;
            return true;
        },
        accidentalWrites: accidentalWrites
    };

    Object.defineProperty(note, "accidentalType", {
        configurable: true,
        enumerable: true,
        get: function () {
            return this._accidentalType === undefined ?
                context.Accidental.NONE : this._accidentalType;
        },
        set: function (value) {
            accidentalWrites.push(value);

            // These writes reproduce the old destructive enharmonic path.
            // The carrier implementation must never reach them.
            if (value == context.Accidental.NATURAL ||
                value == context.Accidental.NONE) {
                throw new Error(
                    "enharmonic spelling must not write NATURAL/NONE");
            }

            assert.strictEqual(value, context.Accidental.SHARP,
                "C4 to B-triple-sharp should use a B-sharp carrier");
            assert.strictEqual(this.line, 1,
                "carrier accidental should be applied on the target B line");

            this._accidentalType = value;
            this.accidental = {
                accidentalType: value,
                visible: true,
                z: 0,
                toString: function () { return "SHARP"; }
            };

            var tiedNote = this;
            while (tiedNote) {
                tiedNote.pitch = 60;
                tiedNote.tpc = 26;
                tiedNote.tpc1 = 26;
                tiedNote.tpc2 = 26;
                tiedNote = tiedNote.tieForward ?
                    tiedNote.tieForward.endNote : null;
            }
        }
    });

    return note;
}

var carrierHead = fakeCarrierNote(60, 14, 0, -30.769230769230944, 10);
var carrierTail = {
    pitch: 60,
    tpc: 14,
    tpc1: 14,
    tpc2: 14,
    line: 0,
    tuning: -30.769230769230944,
    playEvents: [{ pitch: 3, ontime: 0, len: 1000 }],
    elements: [],
    accidental: {
        accidentalType: context.Accidental.NATURAL,
        visible: true,
        z: 1700,
        toString: function () { return "NATURAL"; }
    },
    tieBack: null,
    tieForward: null,
    track: 0,
    voice: 0,
    parent: { parent: { tick: 110 } },
    add: function (element) {
        this.elements.push(element);
    },
    remove: function (element) {
        var index = this.elements.indexOf(element);
        if (index != -1)
            this.elements.splice(index, 1);
    },
    is: function (other) {
        return this === other;
    }
};
var carrierTailAccidentalWrites = [];
Object.defineProperty(carrierTail, "accidentalType", {
    configurable: true,
    enumerable: true,
    get: function () { return context.Accidental.NONE; },
    set: function (value) {
        carrierTailAccidentalWrites.push(value);
        throw new Error(
            "tied continuation must not write accidentalType without a native accidental");
    }
});
var carrierTie = {
    startNote: carrierHead,
    endNote: carrierTail
};
carrierHead.tieForward = carrierTie;
carrierTail.tieBack = carrierTie;
carrierHead.firstTiedNote = carrierHead;
carrierHead.lastTiedNote = carrierTail;
carrierTail.firstTiedNote = carrierHead;
carrierTail.lastTiedNote = carrierTail;

var carrierNoteData = {
    ms: {
        internalNote: carrierHead,
        tick: 10,
        nominalsFromA4: -5
    },
    xen: edo26TxtConfig.notesTable["0"],
    equaves: 0,
    secondaryAccSyms: []
};
var carrierNextNote = context.chooseNextNote(
    0, null, carrierNoteData, null, edo26TxtConfig, 0, 100, {}
);
assert.strictEqual(
    carrierNextNote.xen.hash,
    "6 5 1 148 1",
    "26edo enharmonic cycle should spell C4 as B triple-sharp"
);
assert.strictEqual(
    carrierNextNote.lineOffset,
    1,
    "26edo C4 to B triple-sharp should move down one staff nominal"
);
assert.strictEqual(
    context.enharmonicTpcCarrier(carrierNoteData, carrierNextNote).tpc,
    26,
    "26edo C4 enharmonic should resolve to a B-sharp carrier"
);

var originalParseNoteForCarrier = context.parseNote;
var originalGetBarBoundariesForCarrier = context.getBarBoundaries;
var originalForceExplicitForCarrier = context.forceExplicitAccidentalsAfterNote;
var originalTuneNoteForCarrier = context.tuneNote;
var originalChooseNextNoteForCarrier = context.chooseNextNote;
var originalElementForCarrier = context.Element;
var originalSymIdForCarrier = context.SymId;
var originalAlwaysExplicitForCarrier = edo26TxtConfig.alwaysExplicitAccidental;
var forceExplicitCarrierCalls = 0;
var tuneCarrierCalls = 0;
var carrierHeadPlayEvents = JSON.stringify(carrierHead.playEvents);
var carrierTailPlayEvents = JSON.stringify(carrierTail.playEvents);

try {
    edo26TxtConfig.alwaysExplicitAccidental = true;
    context.Element = { SYMBOL: "SYMBOL", FINGERING: "FINGERING" };
    context.SymId = {};
    [5, 148].forEach(function (symbolCode) {
        var label = context.Lookup.CODE_TO_LABELS[symbolCode][0];
        context.SymId[label] = label;
    });
    context.parseNote = function () { return carrierNoteData; };
    context.getBarBoundaries = function () { return [0, -1]; };
    context.forceExplicitAccidentalsAfterNote = function () {
        forceExplicitCarrierCalls++;
    };
    context.tuneNote = function () { tuneCarrierCalls++; };

    context.executeTranspose(
        carrierHead,
        0,
        0,
        {
            currTuning: edo26TxtConfig,
            currKeySig: null,
            bars: [0]
        },
        function (type) {
            return { name: type == "FINGERING" ? "Fingering" : "Symbol" };
        },
        {}
    );

    assert.strictEqual(carrierHead.line, 1,
        "enharmonic spelling should move the note to the target line");
    assert.strictEqual(carrierHead.pitch, 60,
        "enharmonic spelling should preserve the head MIDI pitch");
    assert.strictEqual(carrierTail.pitch, 60,
        "enharmonic spelling should preserve the tied tail MIDI pitch");
    assert.strictEqual(carrierHead.tpc, 26,
        "enharmonic head should retain the pitch-compatible B-sharp TPC");
    assert.strictEqual(carrierTail.tpc, 26,
        "enharmonic carrier TPC should propagate through the tie");
    assert.strictEqual(carrierTail.line, 1,
        "enharmonic carrier should synchronize the tied tail line immediately");
    assert.strictEqual(carrierHead.tuning, -30.769230769230944,
        "enharmonic spelling should preserve nonzero head tuning exactly");
    assert.strictEqual(carrierTail.tuning, -30.769230769230944,
        "enharmonic spelling should preserve nonzero tied-tail tuning exactly");
    assert.strictEqual(JSON.stringify(carrierHead.playEvents), carrierHeadPlayEvents,
        "enharmonic spelling should preserve head PlayEvents");
    assert.strictEqual(JSON.stringify(carrierTail.playEvents), carrierTailPlayEvents,
        "enharmonic spelling should preserve tied-tail PlayEvents");
    assert.strictEqual(carrierHead.tieForward, carrierTie,
        "enharmonic spelling should preserve the forward tie");
    assert.strictEqual(carrierTail.tieBack, carrierTie,
        "enharmonic spelling should preserve the backward tie");
    assert.strictEqual(carrierTie.startNote, carrierHead,
        "enharmonic spelling should preserve the tie start note");
    assert.strictEqual(carrierTie.endNote, carrierTail,
        "enharmonic spelling should preserve the tie end note");
    assert.strictEqual(carrierHead.accidental.visible, false,
        "MuseScore carrier accidental should be hidden");
    assert.strictEqual(
        carrierHead.accidental.z,
        context.XEN_TPC_CARRIER_ACCIDENTAL_Z,
        "hidden native accidental should retain the TPC carrier marker"
    );
    assert.strictEqual(
        carrierHead.elements.slice().sort(function (a, b) {
            return b.z - a.z;
        }).map(function (element) {
            return context.nativeAccidentalLabelToSymbolCode(element.symbol);
        }).join(","),
        "5,148",
        "visible attached symbols should spell B triple-sharp"
    );
    assert.strictEqual(
        carrierTail.elements.slice().sort(function (a, b) {
            return b.z - a.z;
        }).map(function (element) {
            return context.nativeAccidentalLabelToSymbolCode(element.symbol);
        }).join(","),
        "5,148",
        "always-explicit tied tail should use attached Xen symbols"
    );
    assert.strictEqual(carrierTailAccidentalWrites.length, 0,
        "always-explicit tied tail should not invoke the destructive NONE setter");
    assert.strictEqual(carrierTail.accidental.visible, false,
        "an existing tied-tail accidental should become a hidden carrier");
    assert.strictEqual(
        carrierTail.accidental.z,
        context.XEN_TPC_CARRIER_ACCIDENTAL_Z,
        "an existing tied-tail accidental should retain the carrier marker"
    );
    assert.strictEqual(
        context.tokenizeNote(carrierHead).nativeAccidentals,
        null,
        "hidden carrier accidental should not enter Xen tokenization"
    );
    assert.strictEqual(
        context.effectiveAccidentalHash(
            context.tokenizeNote(carrierHead), edo26TxtConfig),
        "5 1 148 1",
        "attached Xen symbols should remain the effective accidental"
    );
    assert.strictEqual(tuneCarrierCalls, 0,
        "enharmonic spelling should not retune the note or its PlayEvents");
    assert.strictEqual(forceExplicitCarrierCalls, 1,
        "supported enharmonic spelling should prepare surrounding accidentals");
    assert.strictEqual(
        carrierHead.accidentalWrites.join(","),
        String(context.Accidental.SHARP),
        "enharmonic spelling should only set the pitch-compatible carrier accidental"
    );

    edo26TxtConfig.alwaysExplicitAccidental = false;
    context.setAccidental(
        carrierHead,
        null,
        function () {
            throw new Error("carrier cleanup should preserve existing head glyphs");
        },
        edo26TxtConfig
    );
    assert.strictEqual(carrierHead.elements.length, 2,
        "cleanup should preserve the carrier head's compound Xen identity");

    context.setAccidental(
        carrierTail,
        null,
        function () {
            throw new Error("clearing a tied Xen glyph should not add elements");
        },
        edo26TxtConfig,
        { forceAttached: true, clearAttached: true }
    );
    assert.strictEqual(carrierTail.elements.length, 0,
        "non-explicit enharmonic tails should remove stale attached glyphs");
    assert.strictEqual(carrierTailAccidentalWrites.length, 0,
        "clearing a tied Xen glyph should not invoke accidentalType=NONE");
    assert.strictEqual(carrierTail.accidental.visible, false,
        "clearing a tied Xen glyph should retain its hidden TPC carrier");
    var implicitTailToken = context.tokenizeNote(carrierTail);
    assert.strictEqual(implicitTailToken.accidentals, null,
        "a tied continuation must not become explicit bar accidental state");
    assert.strictEqual(
        context.accidentalsHash(implicitTailToken.tiedAttachedAccidentals),
        "5 1 148 1",
        "an implicit tied tail should inherit Xen identity only for itself"
    );
    var originalGetAccidentalForTie = context.getAccidental;
    try {
        context.getAccidental = function () { return null; };
        assert.strictEqual(
            context.readNoteData(
                implicitTailToken,
                edo26TxtConfig,
                null,
                100,
                200,
                {}
            ).xen.hash,
            "6 5 1 148 1",
            "tied inheritance should parse the continuation itself as B triple-sharp"
        );
    } finally {
        context.getAccidental = originalGetAccidentalForTie;
    }

    context.chooseNextNote = function () { return null; };
    var noNextTuneCalls = tuneCarrierCalls;
    var noNextResult = context.executeTranspose(
        carrierHead,
        0,
        0,
        {
            currTuning: edo26TxtConfig,
            currKeySig: null,
            bars: [0]
        },
        function () { throw new Error("a skipped enharmonic must not add elements"); },
        {}
    );
    assert.strictEqual(context.transposeResultSkipped(noNextResult), true,
        "an enharmonic with no next spelling should return an explicit skip");
    assert.strictEqual(tuneCarrierCalls, noNextTuneCalls,
        "a skipped enharmonic should not retune or rewrite PlayEvents");

    var pendingSurroundingHead = fakeCarrierNote(
        60, 14, 0, -30.769230769230944, 25);
    var pendingSurroundingTail = fakeCarrierNote(
        60, 14, 0, -30.769230769230944, 125);
    var pendingSurroundingTie = {
        startNote: pendingSurroundingHead,
        endNote: pendingSurroundingTail
    };
    pendingSurroundingHead.tieForward = pendingSurroundingTie;
    pendingSurroundingHead.firstTiedNote = pendingSurroundingHead;
    pendingSurroundingHead.lastTiedNote = pendingSurroundingTail;
    pendingSurroundingTail.tieBack = pendingSurroundingTie;
    pendingSurroundingTail.firstTiedNote = pendingSurroundingHead;
    pendingSurroundingTail.lastTiedNote = pendingSurroundingTail;
    pendingSurroundingHead.elements.push({
        name: "Fingering",
        text: "#x",
        z: context.DEFAULT_FINGERING_Z_INDEX
    });
    var pendingSurroundingPlayEvents =
        JSON.stringify(pendingSurroundingHead.playEvents);
    var pendingSurroundingParseCalls = 0;
    context.parseNote = function () {
        pendingSurroundingParseCalls++;
        throw new Error(
            "protected surrounding preparation must skip pending fingering input");
    };

    assert.strictEqual(
        context.makeAccidentalsExplicit(
            pendingSurroundingHead,
            edo26TxtConfig,
            null,
            0,
            200,
            function () {
                throw new Error("pending surrounding input must not add elements");
            },
            {},
            true
        ),
        true,
        "pending accidental input on a surrounding note should be left for that note's own operation"
    );
    assert.strictEqual(pendingSurroundingParseCalls, 0,
        "protected surrounding preparation should not parse or commit pending input");
    assert.strictEqual(pendingSurroundingHead.elements.length, 1,
        "protected surrounding preparation should leave pending fingering attached");
    assert.strictEqual(pendingSurroundingHead.pitch, 60,
        "pending surrounding input should preserve the tied head pitch");
    assert.strictEqual(pendingSurroundingTail.pitch, 60,
        "pending surrounding input should preserve the tied tail pitch");
    assert.strictEqual(pendingSurroundingHead.tpc, 14,
        "pending surrounding input should preserve the tied head TPC");
    assert.strictEqual(pendingSurroundingTail.tpc, 14,
        "pending surrounding input should preserve the tied tail TPC");
    assert.strictEqual(pendingSurroundingHead.tieForward, pendingSurroundingTie,
        "pending surrounding input should preserve the forward tie");
    assert.strictEqual(pendingSurroundingTail.tieBack, pendingSurroundingTie,
        "pending surrounding input should preserve the backward tie");
    assert.strictEqual(
        JSON.stringify(pendingSurroundingHead.playEvents),
        pendingSurroundingPlayEvents,
        "pending surrounding input should preserve PlayEvents"
    );
    assert.strictEqual(
        context.makeAccidentalsExplicit(
            pendingSurroundingTail,
            edo26TxtConfig,
            null,
            0,
            200,
            function () {
                throw new Error("a pending tied head must keep its tail unchanged");
            },
            {},
            true
        ),
        true,
        "pending accidental input on a tied head should skip tail preparation too"
    );
    assert.strictEqual(pendingSurroundingParseCalls, 0,
        "a tied tail should detect pending input from its head before parsing");
    assert.strictEqual(pendingSurroundingTail.elements.length, 0,
        "skipping a pending tie chain should not add a tail accidental");
    assert.strictEqual(pendingSurroundingTail.accidental, null,
        "skipping a pending tie chain should not add a native tail carrier");
    assert.strictEqual(
        context.readFingeringAccidentalInput(
            context.tokenizeNote(pendingSurroundingHead),
            edo26TxtConfig,
            true
        ).symCodes.join(","),
        "5,148",
        "the note's own later operation should still consume the pending input"
    );
    assert.strictEqual(pendingSurroundingHead.elements.length, 0,
        "the pending fingering should be consumed exactly once by its own operation"
    );
    assert.strictEqual(
        context.readFingeringAccidentalInput(
            context.tokenizeNote(pendingSurroundingHead),
            edo26TxtConfig,
            true
        ),
        null,
        "a consumed pending fingering should not be processed twice"
    );

    var futureCompoundNote = fakeCarrierNote(
        60, 26, 1, -30.769230769230944, 30);
    var futureCompoundParseOptions = null;
    context.parseNote = function () {
        futureCompoundParseOptions = arguments[8];
        return {
            ms: {
                internalNote: futureCompoundNote,
                tick: 30,
                nominalsFromA4: -6
            },
            xen: { orderedSymbols: [5, 148] },
            secondaryAccSyms: []
        };
    };
    context.makeAccidentalsExplicit(
        futureCompoundNote,
        edo26TxtConfig,
        null,
        0,
        100,
        function (type) {
            return { name: type == "FINGERING" ? "Fingering" : "Symbol" };
        },
        {},
        true
    );
    assert.strictEqual(futureCompoundParseOptions.preview, true,
        "protected surrounding parsing should be read-only");
    assert.strictEqual(futureCompoundNote.pitch, 60,
        "protecting a later compound accidental should preserve MIDI pitch");
    assert.strictEqual(futureCompoundNote.accidental.visible, false,
        "a later compound accidental should receive a hidden native carrier");
    assert.strictEqual(
        futureCompoundNote.elements.slice().sort(function (a, b) {
            return b.z - a.z;
        }).map(function (element) {
            return context.nativeAccidentalLabelToSymbolCode(element.symbol);
        }).join(","),
        "5,148",
        "a later compound accidental should retain only its Xen display symbols"
    );

    var invalidProtectedNote = fakeCarrierNote(60, 14, 0, 0, 35);
    context.parseNote = function () { return null; };
    assert.strictEqual(
        context.makeAccidentalsExplicit(
            invalidProtectedNote,
            edo26TxtConfig,
            null,
            0,
            100,
            function () {
                throw new Error("invalid protected parsing must not add elements");
            },
            {},
            true
        ),
        false,
        "invalid protected parsing should report failure for transaction rollback"
    );

    var rejectedNote = fakeCarrierNote(60, 14, 0, 17.5, 20);
    var rejectedNoteData = {
        ms: {
            internalNote: rejectedNote,
            tick: 20,
            nominalsFromA4: -5
        },
        xen: edo26TxtConfig.notesTable["0"],
        equaves: 0,
        secondaryAccSyms: []
    };
    var rejectedPlayEvents = JSON.stringify(rejectedNote.playEvents);
    context.parseNote = function () { return rejectedNoteData; };
    context.chooseNextNote = function () {
        return {
            xen: edo26TxtConfig.notesTable["3"],
            nominal: 3,
            equaves: 0,
            lineOffset: -3,
            matchPriorAcc: false
        };
    };
    forceExplicitCarrierCalls = 0;
    tuneCarrierCalls = 0;

    var rejectedTransposeResult = context.executeTranspose(
        rejectedNote,
        0,
        0,
        {
            currTuning: edo26TxtConfig,
            currKeySig: null,
            bars: [0]
        },
        function () { throw new Error("rejected spelling must not add elements"); },
        {}
    );

    assert.strictEqual(
        context.transposeResultFailed(rejectedTransposeResult),
        false,
        "unsupported spelling should be a safe skip, not a transaction failure"
    );
    assert.strictEqual(
        context.transposeResultSkipped(rejectedTransposeResult),
        true,
        "unsupported spelling should report a skip so callers avoid cleanup"
    );
    assert.strictEqual(rejectedNote.line, 0,
        "unsupported enharmonic spelling should preserve the staff line");
    assert.strictEqual(rejectedNote.pitch, 60,
        "unsupported enharmonic spelling should preserve MIDI pitch");
    assert.strictEqual(rejectedNote.tpc, 14,
        "unsupported enharmonic spelling should preserve TPC");
    assert.strictEqual(rejectedNote.tuning, 17.5,
        "unsupported enharmonic spelling should preserve tuning");
    assert.strictEqual(JSON.stringify(rejectedNote.playEvents), rejectedPlayEvents,
        "unsupported enharmonic spelling should preserve PlayEvents");
    assert.strictEqual(rejectedNote.elements.length, 0,
        "unsupported enharmonic spelling should preserve attached elements");
    assert.strictEqual(rejectedNote.accidentalWrites.length, 0,
        "unsupported enharmonic spelling should not write accidentalType");
    assert.strictEqual(forceExplicitCarrierCalls, 0,
        "unsupported spelling should be rejected before surrounding mutations");
    assert.strictEqual(tuneCarrierCalls, 0,
        "unsupported spelling should not retune the note");
} finally {
    edo26TxtConfig.alwaysExplicitAccidental = originalAlwaysExplicitForCarrier;
    context.parseNote = originalParseNoteForCarrier;
    context.getBarBoundaries = originalGetBarBoundariesForCarrier;
    context.forceExplicitAccidentalsAfterNote = originalForceExplicitForCarrier;
    context.tuneNote = originalTuneNoteForCarrier;
    context.chooseNextNote = originalChooseNextNoteForCarrier;
    if (originalElementForCarrier === undefined)
        delete context.Element;
    else
        context.Element = originalElementForCarrier;
    if (originalSymIdForCarrier === undefined)
        delete context.SymId;
    else
        context.SymId = originalSymIdForCarrier;
}

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
