// Copyright (C) 2023 euwbah
// This file is part of Xen Tuner. See ../fns.js for license.
// Module: runtime state, user configuration, and shared helpers.
// MUST USE ES5 SYNTAX FOR MSCORE COMPAT.

var Lookup = ImportLookup();

var isMS4; // init sets this to true if MuseScore 4 is detected.

/**
 * If {@link isMS4}, this will be assigned to `mu::plugins::api::enums::AccidentalType`,
 * otherwise, it will be `MS::PluginAPI::Accidental` for MuseScore 3.
 */
var Accidental = null;
var NoteType = null;
var Element = null;
var SymId = null; // WARNING: SymId has a long loading time.
/** @type {FileIO} */
var fileIO;
/**
 * Contains the home directory of the plugin
 */
var pluginHomePath = '';
/** @type {PluginAPIScore} */
var _curScore = null; // don't clash with namespace

var DEBUG_LOG = false;
var LOG_2 = Math.log(2);

function strStartsWith(str, prefix) {
    return str.slice(0, prefix.length) == prefix;
}

function strEndsWith(str, suffix) {
    return suffix.length == 0 || str.slice(str.length - suffix.length) == suffix;
}

function log2(x) {
    return Math.log(x) / LOG_2;
}

function isNullish(value) {
    return value === undefined || value === null;
}

function applyConfigsUpTo(configs, parms, tick, startIdx) {
    var idx = startIdx || 0;
    while (idx < configs.length && configs[idx].tick <= tick) {
        configs[idx].config(parms);
        idx++;
    }
    return idx;
}

function sortConfigUpdateEvents(a, b) {
    if (a.tick != b.tick)
        return a.tick - b.tick;

    var aPriority = a.priority || 0;
    var bPriority = b.priority || 0;
    if (aPriority != bPriority)
        return aPriority - bPriority;

    var aOrder = a.order || 0;
    var bOrder = b.order || 0;
    return aOrder - bOrder;
}

/**
 * FontStyle enumeration.
 * 
 * Values used as bitmask.
 * 
 * TODO: This is a polyfill for the missing FontStyle enumeration in the PluginAPI.
 * Remove this once the PluginAPI has a FontStyle enumeration.
 */
var FontStyle = {
    Normal: 0,
    Bold: 1,
    Italic: 2,
    Underline: 4,
};

/**
                                            _____                               
  __  __________  _____   _________  ____  / __(_)___ _   _   ______ ___________
 / / / / ___/ _ \/ ___/  / ___/ __ \/ __ \/ /_/ / __ `/  | | / / __ `/ ___/ ___/
/ /_/ (__  )  __/ /     / /__/ /_/ / / / / __/ / /_/ /   | |/ / /_/ / /  (__  ) 
\__,_/____/\___/_/      \___/\____/_/ /_/_/ /_/\__, /    |___/\__,_/_/  /____/  
                                              /____/                                                
*/

/**
 * When using JI ratios attached to noteheads as fingerings,
 * this determines whether the period after the ratio is required.
 * 
 * If you wish to use fingerings normally (i.e. to denote fingerings)
 * you should leave this as `true`.
 * 
 * If you don't want to enter a period after every JI ratio, and you
 * don't mind having fingerings rendered as JI ratios, you can set this
 * to false.
 */
var REQUIRE_PERIOD_AFTER_FINGERING_RATIO = true;

/*
Sets the maximum interval (in cents) of notes that will be
considered enharmonically equivalent.

If your tuning system is extremely huge and has very small
intervals, you may need to set this to a smaller value so
that notes do not get incorrectly classified as enharmonic
equivalents.

Don't set this too low, it may cause floating point errors to
make enharmonically equivalent show up as not equivalent.

Don't set this too high, it may cause notes that should not be
considered enharmonically equivalent to show up as equivalent.
*/
var ENHARMONIC_EQUIVALENT_THRESHOLD = 0.005;

/*
When in complex/non-octave tunings, certain notes can be very far off from
the original 12edo pitches of the notes. Using cents tuning alone for
large tuning offsets will cause an unpleasant timbre during playback.

Any tuning offsets more than the specified number of semitones will include
PlayEvent adjustments, which will internally change the MIDI note playback
of this note during playback.

However, when PlayEvents are used to offset tuning a note, the playback sounded
when selecting/modifying the note will not include the semitone offset. 

The score has to be played in order to hear the correct pitch.

If you rather hear the correct pitch when selecting/modifying the note,
in spite of weird timbres caused by playback, set this number higher
(e.g. 40). 

If you rather preserve timbre as much as possible, set this
number to 1.

3 is a good midpoint for preserving selection playback for most
standard tunings.
*/
var PLAY_EVENT_MOD_SEMITONES_THRESHOLD = 12;
var PLAY_EVENT_PREVIEW_CONSISTENCY_THRESHOLD = 1000;
var PLAY_EVENT_PLAYBACK_TIMBRE_THRESHOLD = 1;
var PROJECT_CONFIG_FILE = "xen-tuner.config.json";
var DEFAULT_TUNINGS_DIR = "tunings/";
var playbackOptimizationAutoDetect = false;
var playbackOptimizationPreferPlaybackTimbre = false;

function normalizeTuningConfigPath(filePath) {
    while (filePath.length > 0 && (filePath.charAt(0) == "/" || filePath.charAt(0) == "\\")) {
        filePath = filePath.slice(1);
    }
    return filePath;
}

function tuningConfigFilePath(filePath, extension) {
    return pluginHomePath + DEFAULT_TUNINGS_DIR + normalizeTuningConfigPath(filePath) + extension;
}

function tuningConfigSourceName(filePath, extension) {
    return DEFAULT_TUNINGS_DIR + normalizeTuningConfigPath(filePath) + extension;
}

/**
 * All symbol/ascii accidentals must be at least this far apart
 * from each other. 
 * 
 * Some accidentals are very very thin and the default auto-positioning
 * will make them too tight and cluttered to read.
 */
var MIN_ACC_WIDTH = 0.75;

/**
 * Represents additional horizontal space to put between accidentals
 * when auto-positioning them.
 * 
 * (Increases the width of the accidental bounding box)
 * 
 * The smaller the number, the more tightly packed accidental symbols
 * are when auto-positioning accidentals.
 * 
 * Number is in spatium units.
 */
var ACC_SPACE = 0.1;

/**
 * Represents additional horizontal space to put between the notehead
 * and the accidental when auto-positioning accidentals.
 * 
 * Number is in spatium units.
 */
var ACC_NOTESPACE = 0.2;

/**
 * Font size of text-based ASCII accidentals. In px.
 * 
 * Text-based accidentals are rendered with fingering text.
 * 
 * Auto placement of single ASCII symbols/punctuation is
 * optimized for this font size.
 */
var ASCII_ACC_FONT_SIZE = 11;

/**
 * Font size of the fingering text containing the step number of 
 * the note.
 */
var STEPS_DISPLAY_FONT_SIZE = 10;

/**
 * Font size of the fingering text containing cents offset of the note.
 */
var CENTS_DISPLAY_FONT_SIZE = 10;

/**
 * By default, whenever an accidental is entered via ascii
 * input, it will clear all prior accidentals attached to the note.
 * 
 * This mimics the same behavior as entering accidentals via 
 * AccidentalVector method.
 * 
 * However, if you want the new accidentals to pile up on top of
 * existing accidentals instead of replacing the old ones, set this
 * to false.
 */
var CLEAR_ACCIDENTALS_AFTER_ASCII_ENTRY = true;

/**
 * If `true`, the non-diatonic up/down operations will keep prior secondary
 * accidentals that were attached to the note.
 * 
 * This defaults to `false` as the intention of a non-diatonic up/down is to
 * modify the existing accidentals on the note.
 * 
 * It would seem weird to keep some of the old accidentals only because
 * they are 'secondary' accidentals, then have the user manually delete them
 * later.
 * 
 * However, in HCJI where comma shifts are notated as secondary accidentals,
 * (which is not recommended), then the user may find this feature handy
 * and set this to `true`.
 */
var KEEP_SECONDARY_ACCIDENTALS_AFTER_TRANSPOSE = false;
/**
 * If `false`, the plugin will delete secondary accidentals after a
 * diatonic transpose is performed. (That is, aux(0))
 * 
 * This defaults to `true` to keep in line with the expected behavior
 * that a "diatonic" transpose should only change the nominal and
 * not affect the accidentals.
 */
var KEEP_SECONDARY_ACCIDENTALS_AFTER_DIATONIC = true;
/**
 * If `false`, the plugin will delete secondary accidentals after a
 * enharmonic cycle operation is performed.
 * 
 * This defaults to `true` to keep in line with the expectation that
 * enharmonic notes should have the same pitch. Thus, any secondary
 * accidentals present must remain to keep the pitch consistent.
 */
var KEEP_SECONDARY_ACCIDENTALS_AFTER_ENHARMONIC = true;

/**
 * If true, the plugin will allow `cmd('pitch-up')` and `cmd('pitch-down')` to be
 * sent when the selection doesn't include notes and up/down operations are being sent.
 * 
 * Set this to false when the user is editing text elements, so that the user can
 * press up/down to navigate the text without being interrupted.
 */
var fallthroughUpDownCommand = true;

/**
 * In the event that a particular note in the tuningTable is this many
 * cents underneath an equave, it will be assumed that the note's tuning
 * is exactly one equave.
 * 
 * This prevents floating point errors from causing the enharmonics of
 * a note to have the wrong octave offset due to floating point errors.
 */
var EPSILON = 1e-8;

/**
 * Contains a lookup of valid characters that can occur after
 * a backslash escape character when declaring Symbol Codes in
 * tuning config via Text Code or ASCII.
 * 
 * @type {Object.<string, boolean>}
 */
var VALID_ASCII_ACC_ESC_CHARS = {
    '\\': true,
    '\'': true,
    '/': true
};

/**
 * The default tuning config in case tunings/default.txt is invalid or not found.
 */
var DEFAULT_TUNING_CONFIG = "           \n\
A4: 440                                 \n\
0 200c 300c 500c 700c 800c 1000c 1200c  \n\
bbb bb b (100c) # x #x                  \n\
aux(0)                                  \n\
aux(1)                                  \n\
sec()                                   \n\
'bbb' bbb -300c                         \n\
'bb' bb -200c                           \n\
'b' b -100c                             \n\
'###' #x 300c                           \n\
'#x' #x 300c                            \n\
'x#' #x 300c                            \n\
'##' x 200c                             \n\
'x' x 200c                              \n\
'#' # 100c";

/**
 * If a fingering has this Z index, it signifies that it is a
 * per-note tuning fingering annotation that has already been
 * processed.
 * 
 * This currently no purpose other than to set the Z index of
 * the fingering to the non-default value so that it won't be
 * repeatedly attempted to be processed as an ASCII-representation
 * accidental entry, which is computationally intensive.
 */
var PROCESSED_FINGERING_ANNOTATION_Z = 3903;

var STEPS_DISPLAY_FINGERING_Z = 3904;
var CENTS_DISPLAY_FINGERING_Z = 3905;

/**
 * This is the default Z index for fingerings as of MuseScore 3.6.2.
 * 
 * If MuseScore changes this, we need to change this as well.
 * 
 * The default fingering z index is used to mark that a fingering
 * has not been processed, and that we will need to process it.
 */
var DEFAULT_FINGERING_Z_INDEX = 3900;
