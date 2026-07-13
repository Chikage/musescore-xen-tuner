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
context.Accidental = {
    NONE: 0,
    NATURAL: 1,
    SHARP: 2,
    FLAT: 3,
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
assertAccidentals(
    context.tokenizeNote(fakeNote("FLAT", [{
        symbol: { toString: function () { return "accidentalSharp"; } }
    }])).accidentals,
    { "5": 1 },
    "attached Xen Tuner symbols should take precedence over native accidentals"
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
    "0c 200c 300c 500c 700c 800c 1000c 1200c"
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
var nativeKeySigParms = { currTuning: cReferenceTuningConfig, currKeySig: null };
nativeKeySigEvent.config(nativeKeySigParms);
assertKeySig(
    nativeKeySigParms.currKeySig,
    ["5 1", null, null, "5 1", null, null, null],
    "native key signature config event should defer mapping to the active tuning config"
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
