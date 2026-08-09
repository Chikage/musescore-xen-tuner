// Copyright (C) 2023 euwbah
// This file is part of Xen Tuner. See ../fns.js for license.
// Module: tuning config, key signature, reference tuning, and text config parsing.
/**
 * Parses a string that declares {@link SymbolCode}s in a Tuning Config.
 * 
 * E.g. '\\\'+.'.'$'.# represents 3 symbols. Left to right, they are
 * 
 * 1. ASCII symbol consisting of \'+. (quote, plus, period).\
 *    \\ escapes into backslash\
 *    \' escapes into quote.
 * 2. ASCII symbol consisting of $ (dollar sign)
 * 3. Standard-issue SMuFL sharp symbol.
 * 
 * Backslash escapes must be used both inside and outside quotes.
 * 
 * The valid escapes are:
 * 
 * - \\  - backslash
 * - \' - quote
 * - \/ - forward slash.
 * 
 * 'abc'# is invalid syntax. A dot must separate distinct symbols,
 * and ASCII symbols are distinct from SMuFL symbols.
 * 
 * The plugin will not check for this syntax error and will instead
 * parse it as a single ASCII symbol: 'abc#'.
 * 
 * If failed to parse, logs error messages to the console.
 * 
 * @param {string} str Text that represents a symbol.
 * @param {boolean?} suppressError If true, will not log error messages to the console.
 * @returns {SymbolCode[]?} Array of {@link SymbolCode}s, or `null` if the string is invalid.
 */
function parseSymbolsDeclaration(str, suppressError) {
    var symCodes = [];
    var isQuoted = false; // true if pending a closing quote.
    var isEscape = false; // true if pending an escape sequence.

    // stores current single symbol being processed.
    // the period seperates each symbol.
    var currStr = '';
    var currIsQuoted = false;

    for (var i = 0; i < str.length; i++) {
        var c = str[i];

        if (isEscape) {
            if (!VALID_ASCII_ACC_ESC_CHARS[c]) {
                // invalid escape sequence.
                if (!suppressError)
                    console.error('TUNING CONFIG ERROR: Invalid escape sequence: \\' + c);
                return null;
            }
            isEscape = false;
            currStr += c; // add character verbatim.
        } else if (c == '\\') {
            isEscape = true;
        } else if (c == '\'') {
            isQuoted = !isQuoted;
            currIsQuoted = true;
        } else if (c == '.') {
            if (isQuoted) {
                // still inside quotes, add period verbatim.
                currStr += c;
                continue;
            }

            // period separates symbols.
            if (currIsQuoted) {
                // Push an ASCII symbol code.
                // Prepend with a quote.
                symCodes.push("'" + currStr);
            } else {
                // Push a SMuFL symbol code.
                var code = readSymbolCode(currStr);

                if (code == null) {
                    if (!suppressError)
                        console.error('TUNING CONFIG ERROR: invalid symbol: ' + currStr);
                    return null;
                }

                symCodes.push(code);
            }

            currStr = '';
            currIsQuoted = false;
        } else {
            // otherwise just add the character.
            currStr += c;
        }
    }

    if (isQuoted) {
        if (!suppressError)
            console.error('TUNING CONFIG ERROR: symbol missing closing quote: ' + str);
        return null;
    }

    if (currStr.length > 0) {
        // last symbol 

        // period separates symbols.
        if (currIsQuoted) {
            // Push an ASCII symbol code.
            symCodes.push("'" + currStr);
        } else {
            // Push a SMuFL symbol code.
            var code = readSymbolCode(currStr);

            if (code == null) {
                if (!suppressError)
                    console.error('TUNING CONFIG ERROR: invalid symbol: ' + currStr);
                return null;
            }

            symCodes.push(code);
        }

        return symCodes;
    }

    return null;
}

/**
 * Convert user-input string that denotes a cent/ratio interval value
 * into the number of cents it represents.
 * 
 * If the string is invalid, it logs the error message and returns `null`.
 * 
 * @param {string} str Parses cents or ratio text into cents offset.
 * @param {boolean?} suppressError If true, will not log error messages to the console.
 * @returns {number?} Cents offset, or null if invalid syntax.
 */
function parseCentsOrRatio(str, suppressError) {
    var str = str.trim();
    var offset = null;
    try {
        if (strEndsWith(str, 'c')) {
            // in cents
            offset = parseFloat(eval(str.slice(0, -1)));
        } 
        else if (strEndsWith(str, 'me')) {
            // in decimal
            offset = parseFloat(eval(str.slice(0, -2))) / LOG_2 * 1.2;
        }
        else if (strStartsWith(str, 'ie')) {
            // in decimal
            offset = parseFloat(eval(1000 / str.slice(2))) / LOG_2 * 1.2;
        }
         else if (/\\|ed/.test(str))  {
            var parts = str.split(/\\|ed/);
            if (parts.length < 2 || parts.length > 3 || parts[0] === '' || parts[1] === '') {
                throw new Error('Invalid equal-division interval');
            }
            var a = parseFloat(eval(parts[0]));
            var b = parseFloat(eval(parts[1]));
            var c = parts.length > 2 && parts[2] !== '' ? parseFloat(eval(parts[2])) : 2;
            if (isNaN(a) || isNaN(b) || isNaN(c) || b == 0 || c <= 0) {
                throw new Error('Invalid equal-division interval');
            }
            // in decimal
            offset = a * 1200 * Math.log(c) / LOG_2 / b;
        }
        else {
            var ratio = parseFloat(eval(str));
            if (ratio < 0) {
                offset = -log2(-ratio) * 1200;
            } else if (ratio == 0) {
                offset = 0;
            } else {
                offset = log2(ratio) * 1200;
            }
        }
    } catch (e) {
        if (!suppressError) {
            console.error('TUNING CONFIG ERROR parsing cents/ratio: Cannot parse as cents or ratio: ' + str
                + '\nErr: ' + e);
        }
        return null;
    }
    if (!isNaN(offset)) {
        return offset;
    } else {
        if (!suppressError) {
            console.error('TUNING CONFIG ERROR parsing cents/ratio: Invalid accidental tuning offset specified: ' + str);
        }
        return null;
    }
}

/**
 * Splits an accidental degree declaration in the acc chain into 
 * symbols string and tuning offset.
 * 
 * E.g.: `'(!!!)(Math.pow(3/2,3))'` should return:
 * 
 * `['(!!!)', 'Math.pow(3/2,3)']`
 * 
 * Parsing method:
 * 
 * - If the string ends with a closing bracket, find the matching opening bracket.
 * - Split at the matching opening bracket. The left part is the symbols declaration
 *   and the right part is the tuning offset.
 * - If the entire string is matched as the tuning offset, treat the entire string
 *   as the symbols declaration.
 * - If the matched tuning offset has a syntax error, treat the entire string as
 *   the symbols declaration.
 * 
 * 
 * @param {string} str 
 * String containing accidental symbols definition and optional irregular 
 * tuning offset. Whitespace should be trimmed.
 * 
 * @returns {[string, number]?}
 * `[symbols, centsOffset]`. Returns null if the syntax is invalid.
 */
function parseSymbolOffsetPair(str) {
    var splitIdx = 0;
    if (strEndsWith(str, ')')) {
        var bracketDepth = 1;
        for (var i = str.length - 2; i >= 0; i--) {
            var c = str[i];
            if (c == ')') {
                bracketDepth++;
            } else if (c == '(') {
                bracketDepth--;
            }
            if (bracketDepth == 0) {
                splitIdx = i;
                break;
            }
        }
    } else {
        return [str, 0];
    }

    var symbols = str.slice(0, splitIdx);
    var offset = str.slice(splitIdx + 1, str.length - 1); // remove surrounding parens

    if (splitIdx == 0) {
        return [str, 0];
    }

    var maybeOffset = parseCentsOrRatio(offset);

    if (maybeOffset == null) {
        symbols = str;
        maybeOffset = 0;
    }

    return [symbols, maybeOffset];
}

function tuningConfigSourceHash(sourceText) {
    var hash = 5381;
    for (var i = 0; i < sourceText.length; i++) {
        hash = (((hash << 5) + hash) + sourceText.charCodeAt(i)) >>> 0;
    }
    return sourceText.length + ':' + hash.toString(36);
}

function createTuningConfigCacheKey(textOrPath, sourceText) {
    if (sourceText && sourceText.length > 0) {
        return textOrPath + '\n#source=' + tuningConfigSourceHash(sourceText);
    }
    return textOrPath;
}

function normalizeConfigLineEndings(text) {
    return text.replace(/\r\n?/g, '\n');
}

function normalizeCentsToEquave(rawCents, equaveSize) {
    var cents = rawCents;
    var equavesAdjusted = 0;
    var equaveMagnitude = Math.abs(equaveSize);

    if (equaveSize > 0) {
        while (cents < 0) {
            cents += equaveMagnitude;
            equavesAdjusted++;
        }
        while (cents >= equaveMagnitude) {
            cents -= equaveMagnitude;
            equavesAdjusted--;
        }
        if (equaveMagnitude - cents < EPSILON) {
            cents = 0;
            equavesAdjusted--;
        }
    } else if (equaveSize < 0) {
        while (cents < 0) {
            cents += equaveMagnitude;
            equavesAdjusted--;
        }
        while (cents >= equaveMagnitude) {
            cents -= equaveMagnitude;
            equavesAdjusted++;
        }
        if (equaveMagnitude - cents < EPSILON) {
            cents = 0;
            equavesAdjusted++;
        }
    }

    return [cents, equavesAdjusted];
}

function tuningJSONValueToText(value) {
    if (value === undefined || value === null) {
        return null;
    }

    return String(value);
}

function tuningJSONFirstDefinedValue(obj, keys) {
    if (!obj) {
        return null;
    }

    for (var i = 0; i < keys.length; i++) {
        var value = obj[keys[i]];
        if (value !== undefined && value !== null) {
            return value;
        }
    }

    return null;
}

function tuningJSONIntervalToText(value) {
    if (typeof (value) == 'number' && value == 0) {
        return '0c';
    }

    return tuningJSONValueToText(value);
}

function tuningJSONTextAccidentalToDeclaration(value) {
    var text = tuningJSONValueToText(value);
    if (text == null) {
        return null;
    }

    text = text.replace(/\\/g, '\\\\')
        .replace(/'/g, "\\'")
        .replace(/\//g, '\\/');

    return "'" + text + "'";
}

function compactTuningJSONReferenceToText(jsonTuningConfig) {
    var ref = jsonTuningConfig.ref || jsonTuningConfig.reference;

    if (typeof (ref) == 'string') {
        return ref;
    }

    if (!ref || typeof (ref) != 'object') {
        console.error('TUNING CONFIG ERROR: JSON tuning config is missing ref.');
        return null;
    }

    var refKeys = Object.keys(ref);
    if (refKeys.length != 1) {
        console.error('TUNING CONFIG ERROR: JSON ref must contain exactly one reference note.');
        return null;
    }

    var refFreq = tuningJSONValueToText(ref[refKeys[0]]);
    if (refFreq == null) {
        console.error('TUNING CONFIG ERROR: JSON ref has an invalid frequency.');
        return null;
    }

    return refKeys[0] + ': ' + refFreq;
}

function compactTuningJSONChainToText(chainConfig) {
    if (!chainConfig || typeof (chainConfig) != 'object' || !Array.isArray(chainConfig.chain)) {
        return null;
    }

    var step = tuningJSONIntervalToText(tuningJSONFirstDefinedValue(chainConfig, ['step', 'increment']));
    if (step == null) {
        console.error('TUNING CONFIG ERROR: JSON accidental chain is missing step.');
        return null;
    }

    var hasOrigin = false;
    var parts = [];
    for (var i = 0; i < chainConfig.chain.length; i++) {
        var symbol = chainConfig.chain[i];

        if (typeof (symbol) == 'number' && symbol == 0) {
            parts.push('(' + step + ')');
            hasOrigin = true;
            continue;
        }

        var symbolText = tuningJSONValueToText(symbol);
        if (symbolText == null) {
            console.error('TUNING CONFIG ERROR: JSON accidental chain has an invalid symbol.');
            return null;
        }
        parts.push(symbolText);
    }

    if (!hasOrigin) {
        console.error('TUNING CONFIG ERROR: JSON accidental chain must include numeric 0 as the 1/1 origin.');
        return null;
    }

    return parts.join(' ');
}

function appendCompactTuningJSONAuxExtra(lines, auxExtra) {
    if (!Array.isArray(auxExtra)) {
        return;
    }

    for (var i = 0; i < auxExtra.length; i++) {
        var entry = auxExtra[i];
        if (typeof (entry) == 'string') {
            if (strStartsWith(entry, 'aux(')) {
                lines.push(entry);
            } else {
                lines.push('aux(' + entry + ')');
            }
        } else if (Array.isArray(entry)) {
            lines.push('aux(' + entry.join(',') + ')');
        }
    }
}

function appendCompactTuningJSONAuxOrder(lines, aux, auxKeys) {
    var order = aux.order || aux.auxOrder;

    if (Array.isArray(order)) {
        for (var i = 0; i < order.length; i++) {
            var entry = order[i];
            if (typeof (entry) == 'number') {
                lines.push('aux(' + entry + ')');
            } else if (typeof (entry) == 'string') {
                if (strStartsWith(entry, 'aux(')) {
                    lines.push(entry);
                } else {
                    lines.push('aux(' + entry + ')');
                }
            } else if (Array.isArray(entry)) {
                lines.push('aux(' + entry.join(',') + ')');
            }
        }
        return true;
    }

    for (var auxIdx = 0; auxIdx < auxKeys.length; auxIdx++) {
        lines.push('aux(' + parseInt(auxKeys[auxIdx]) + ')');
    }

    return false;
}

function sortCompactTuningJSONSecondaryAccidentals(secList) {
    return secList.slice().sort(function (a, b) {
        var aSymbol = tuningJSONValueToText(a && a.symbol) || "";
        var bSymbol = tuningJSONValueToText(b && b.symbol) || "";
        var aSymbols = parseSymbolsDeclaration(aSymbol, true);
        var bSymbols = parseSymbolsDeclaration(bSymbol, true);
        var aSymbolCount = aSymbols ? aSymbols.length : 0;
        var bSymbolCount = bSymbols ? bSymbols.length : 0;

        if (aSymbolCount != bSymbolCount) {
            return bSymbolCount - aSymbolCount;
        }

        var aText = tuningJSONValueToText(a && a.text) || "";
        var bText = tuningJSONValueToText(b && b.text) || "";
        return bText.length - aText.length;
    });
}

function compactTuningJSONToText(jsonTuningConfig) {
    if (!jsonTuningConfig || typeof (jsonTuningConfig) != 'object') {
        return null;
    }

    if (!jsonTuningConfig.ref && !jsonTuningConfig.reference && !jsonTuningConfig.nom) {
        return null;
    }

    var refLine = compactTuningJSONReferenceToText(jsonTuningConfig);
    if (refLine == null) {
        return null;
    }

    var nominals = jsonTuningConfig.nom;
    if (!Array.isArray(nominals) || nominals.length < 2) {
        console.error('TUNING CONFIG ERROR: JSON tuning config must contain a nom array with at least two entries.');
        return null;
    }

    var nominalWords = [];
    for (var i = 0; i < nominals.length; i++) {
        var nominalText = tuningJSONIntervalToText(nominals[i]);
        if (nominalText == null) {
            console.error('TUNING CONFIG ERROR: JSON nominal tuning contains an invalid value.');
            return null;
        }
        nominalWords.push(nominalText);
    }

    var lines = [refLine, nominalWords.join(' ')];
    var aux = jsonTuningConfig.aux || {};
    var auxKeys = Object.keys(aux).filter(function (key) {
        return key.match(/^[0-9]+$/);
    }).sort(function (a, b) {
        return parseInt(a) - parseInt(b);
    });

    for (var chainIdx = 0; chainIdx < auxKeys.length; chainIdx++) {
        var key = auxKeys[chainIdx];
        var auxEntry = aux[key];
        if (auxEntry && typeof (auxEntry) == 'object' && Array.isArray(auxEntry.chain)) {
            var chainLine = compactTuningJSONChainToText(auxEntry);
            if (chainLine == null) {
                return null;
            }
            lines.push(chainLine);
        } else if (parseInt(key) != 0) {
            console.error('TUNING CONFIG ERROR: JSON aux entry ' + key + ' must contain an accidental chain.');
            return null;
        }
    }

    if (Array.isArray(jsonTuningConfig.extra)) {
        for (var extraIdx = 0; extraIdx < jsonTuningConfig.extra.length; extraIdx++) {
            lines.push(tuningJSONValueToText(jsonTuningConfig.extra[extraIdx]));
        }
    }

    var hasAuxOrder = appendCompactTuningJSONAuxOrder(lines, aux, auxKeys);
    if (!hasAuxOrder) {
        appendCompactTuningJSONAuxExtra(lines, aux.auxExtra);
        appendCompactTuningJSONAuxExtra(lines, aux.extra);
    }

    var opt = jsonTuningConfig.opt || {};
    var displaySteps = opt.displaysteps || opt.displaySteps;
    if (displaySteps) {
        lines.push('displaysteps(' + displaySteps.steps + ', ' + displaySteps.position + ')');
    }

    var displayCents = opt.displaycents || opt.displayCents;
    if (displayCents) {
        var displayCentsReference = displayCents.reference || displayCents.mode || 'nominal';
        lines.push('displaycents(' + displayCentsReference + ', ' + displayCents.precision + ', ' + displayCents.position + ')');
    }

    if (opt.explicit) {
        lines.push('explicit()');
    }
    if (opt.nobold) {
        lines.push('nobold()');
    }

    if (Array.isArray(jsonTuningConfig.sec) && jsonTuningConfig.sec.length > 0) {
        lines.push('sec()');

        var sortedSec = sortCompactTuningJSONSecondaryAccidentals(jsonTuningConfig.sec);
        for (var secIdx = 0; secIdx < sortedSec.length; secIdx++) {
            var sec = sortedSec[secIdx];
            var secText = tuningJSONTextAccidentalToDeclaration(sec.text);
            var secSymbol = tuningJSONValueToText(sec.symbol);
            var secStep = tuningJSONIntervalToText(tuningJSONFirstDefinedValue(sec, ['step', 'tuning', 'cents']));

            if (secText == null || secSymbol == null || secStep == null) {
                console.error('TUNING CONFIG ERROR: JSON secondary accidental declaration is invalid.');
                return null;
            }

            lines.push(secText + ' ' + secSymbol + ' ' + secStep);
        }
    }

    return lines.join('\n');
}

function parseTuningConfigJSONText(text, sourceName, sourcePath) {
    var jsonTuningConfig = null;

    try {
        jsonTuningConfig = JSON.parse(text);
    } catch (e) {
        return null;
    }

    if (jsonTuningConfig && jsonTuningConfig.nominals && jsonTuningConfig.stepsList && jsonTuningConfig.tuningTable) {
        setTuningConfigSourceInfo(jsonTuningConfig, sourceName, sourcePath);
        return {
            tuningConfig: jsonTuningConfig
        };
    }

    var legacyText = compactTuningJSONToText(jsonTuningConfig);
    if (legacyText != null) {
        return {
            text: legacyText
        };
    }

    return null;
}

function getCachedTuningConfig(cacheKey, textOrPath, isNotPath, silent) {
    if (tuningConfigCache[cacheKey]) {
        ensureTuningConfigLogInfo(tuningConfigCache[cacheKey], textOrPath, isNotPath);
        if (!silent) {
            log('Using cached tuning config:\n' + textOrPath + '\n' +
                tuningConfigCache[cacheKey].stepsList.length + ' notes/equave, ' + tuningConfigCache[cacheKey].equaveSize + 'c equave');
        }

        return tuningConfigCache[cacheKey];
    }

    if (_curScore) {
        var tuningCacheStr = _curScore.metaTag('tuningconfigs');
        if (tuningCacheStr && tuningCacheStr.length && tuningCacheStr.length > 0) {
            var tuningCache = JSON.parse(tuningCacheStr);
            var maybeCached = tuningCache && tuningCache[cacheKey];
            if (maybeCached) {
                ensureTuningConfigLogInfo(maybeCached, textOrPath, isNotPath);
                if (!silent) {
                    log('Using cached tuning config:\n' + textOrPath + '\n' +
                        maybeCached.stepsList.length + ' notes/equave, ' + maybeCached.equaveSize + 'c equave');
                }

                setTuningConfigSourceInfo(maybeCached, maybeCached.sourceName || textOrPath, maybeCached.sourcePath || "");
                tuningConfigCache[cacheKey] = maybeCached;

                return maybeCached;
            }
        }
    } else {
        console.error('ERROR: _curScore not defined. Unable to read cache.');
    }

    return null;
}

/**
 * Tests if a certain text/tuning file is a tuning config.
 * 
 * First it will look up cached TuningConfigs so it won't
 * have to parse the text again.
 * 
 * The cache will contain strings (either entire texts or references to .txt files) 
 * that generated a TuningConfig, and maps it to TuningConfig objects.
 * 
 * If a cached TuningConfig is not found, parses the text/tuning file
 * and creates a TuningConfig object.
 * 
 * Example tuning config text:
 * 
 * ```txt
 * A4: 440
 * 0 203.91 294.13 498.04 701.96 792.18 996.09 1200
 * bb.bb 7 bb b (113.685) # x 2 x.x
 * \.\ \ (21.506) / /./
 * ```
 * 
 * @param {string} text 
 *  The system/staff text contents, or a path to a file containing the config text.
 * 
 *  The path is read relative to the default `tunings/` folder in the plugin home directory.
 *  The '.txt' extension is optional.
 * 
 * @param {boolean?} isNotPath 
 *  Optional. Specify `true` to read text verbatim instead of trying to read from a file.
 * 
 * @param {boolean?} silent
 *  Optional. Specify `true` to suppress cache loading messages.
 * 
 * @returns {TuningConfig} The parsed tuning configuration object, or null text was not a tuning config.
 */
function parseTuningConfig(textOrPath, isNotPath, silent) {

    // Check if a tuning config file in the default tunings directory is specified.
    // Use the contents of that file as the tuning config if there's anything
    // in that file.
    var text = '';
    var sourceName = "";
    var sourcePath = "";
    var textOrPath = textOrPath.trim();
    var cacheKey = textOrPath;
    var cachedTuningConfig = null;

    if (!isNotPath && fileIO) {
        // read from a file

        if (textOrPath.length == 0) {
            // log('not tuning config: empty text');
            return null;
        }

        var filePath = textOrPath;

        if (strEndsWith(textOrPath, '.txt')) {
            filePath = textOrPath.slice(0, textOrPath.length - 4);
        } else if (strEndsWith(textOrPath, '.json')) {
            filePath = textOrPath.slice(0, textOrPath.length - 5);
        }

        // Try read from .json first.

        fileIO.source = tuningConfigFilePath(filePath, '.json');

        text = fileIO.read().trim();
        if (text.length > 0) {
            cacheKey = createTuningConfigCacheKey(textOrPath, text);
            cachedTuningConfig = getCachedTuningConfig(cacheKey, textOrPath, isNotPath, silent);
            if (cachedTuningConfig != null) {
                return cachedTuningConfig;
            }
        }

        var jsonParseResult = parseTuningConfigJSONText(text, tuningConfigSourceName(filePath, '.json'), fileIO.source);
        if (jsonParseResult != null) {
            sourceName = tuningConfigSourceName(filePath, '.json');
            sourcePath = fileIO.source;

            if (jsonParseResult.tuningConfig) {
                tuningConfigCache[cacheKey] = jsonParseResult.tuningConfig;
                log('Loaded JSON tuning config from ' + fileIO.source + ':\n');
                return jsonParseResult.tuningConfig;
            }

            text = jsonParseResult.text;
        } else {
            // Otherwise, try read .txt

            fileIO.source = tuningConfigFilePath(filePath, '.txt');

            text = fileIO.read().trim();
            sourceName = tuningConfigSourceName(filePath, '.txt');
            sourcePath = fileIO.source;

            if (text.length > 0) {
                cacheKey = createTuningConfigCacheKey(textOrPath, text);
                cachedTuningConfig = getCachedTuningConfig(cacheKey, textOrPath, isNotPath, silent);
                if (cachedTuningConfig != null) {
                    return cachedTuningConfig;
                }
            }
        }
    }

    if (text.length == 0) {
        // If no file/IO Error, parse the textOrPath as the config itself.
        text = textOrPath;
        sourceName = isNotPath ? "direct tuning text" : "score tuning text";
        cacheKey = textOrPath;
        cachedTuningConfig = getCachedTuningConfig(cacheKey, textOrPath, isNotPath, silent);
        if (cachedTuningConfig != null) {
            return cachedTuningConfig;
        }
    } else {
        log('Reading tuning config from ' + fileIO.source);
    }

    var directJSONParseResult = parseTuningConfigJSONText(text, sourceName, sourcePath);
    if (directJSONParseResult != null) {
        if (directJSONParseResult.tuningConfig) {
            tuningConfigCache[cacheKey] = directJSONParseResult.tuningConfig;
            return directJSONParseResult.tuningConfig;
        }

        text = directJSONParseResult.text;
    }

    text = normalizeConfigLineEndings(text);
    var rawConfigText = text;
    var rawAuxDeclarations = collectAuxSourceLines(rawConfigText);
    var rawAuxIndex = 0;

    // remove comments from tuning config text.
    // comments start with two slashes
    text = text.replace(/^(.*?)\/\/.*$/gm, '$1')
        // remove empty lines
        .replace(/^(?:[\t ]*(?:\r?\n|\r))+/gm, '')
        .trim();

    /** @type {TuningConfig} */
    var tuningConfig = { // TuningConfig
        notesTable: {},
        tuningTable: {},
        tuningOverrideTable: {},
        avTable: {},
        avToSymbols: {},
        stepsList: [],
        stepsLookup: {},
        enharmonics: {},
        nominals: [],
        ligatures: [],
        accChains: [],
        auxList: [null], // the 0th entry should be null.
        auxLogTexts: [null], // human-readable aux declarations for UI logs.
        accChainLogTexts: [],
        numNominals: null,
        equaveSize: null,
        tuningNote: null,
        tuningNominal: null,
        relativeTuningNominal: 0,
        tuningFreq: null,
        originalTuningFreq: null,
        // lookup of symbols used in tuning config.
        // anything not included should be ignored.
        usedSymbols: {
            // Natural symbol should always be included.
            2: true
        },
        usedSecondarySymbols: {},
        // Lazily populated mapping from MuseScore-native standard accidental
        // SymbolCodes to the active tuning's primary accidental-chain symbols.
        nativeAccidentalMap: null,
        unmappedNativeAccidentals: {},
        secondaryAccList: [],
        secondaryAccIndexTable: {},
        secondaryAccTable: {},
        secondaryTunings: {},
        asciiToSmuflConv: {},
        asciiToSmuflConvList: [],
        alwaysExplicitAccidental: false,
        nonBoldTextAccidental: false,
        displayCentsPosition: 'above',
        displayCentsReference: 'nominal',
        displayCentsPrecision: 0,
        displaySteps: null,
        displayStepsPosition: 'below',
        sourceName: sourceName,
        sourcePath: sourcePath,
        referenceLogText: "",
        nominalsLogText: "",
    };

    var lines = text.split('\n').map(function (x) { return x.trim() });

    // Need at least reference note and nominal declarations.
    if (lines.length < 2)
        return null;

    tuningConfig.referenceLogText = lines[0];
    tuningConfig.nominalsLogText = lines[1];

    // PARSE TUNING NOTE.
    //
    //

    var referenceTuning = lines[0].split(':').map(function (x) { return x.trim() });

    if (referenceTuning.length != 2) {
        // log(lines[0] + ' is not a reference tuning');
        return null;
    }

    var referenceLetter = referenceTuning[0][0].toLowerCase();
    var referenceOctave = parseInt(referenceTuning[0].slice(1));

    var nominalsFromA4 = (referenceOctave - 4) * 7;
    var lettersNominal = Lookup.LETTERS_TO_NOMINAL[referenceLetter];

    if (lettersNominal == undefined) {
        // log("Invalid reference note specified: " + referenceLetter);
        return null;
    }

    nominalsFromA4 += lettersNominal;

    // Since the written octave resets at C, but we need to convert it
    // such that the octave resets at A4, we need to subtract one octave
    // if the nominal is within C to G.
    if (lettersNominal >= 2)
        nominalsFromA4 -= 7;

    tuningConfig.tuningNominal = nominalsFromA4;
    tuningConfig.tuningNote = Lookup.LETTERS_TO_SEMITONES[referenceLetter] + (referenceOctave - 4) * 12 + 69;
    tuningConfig.tuningFreq = parseFloat(eval(referenceTuning[1])); // specified in Hz.
    tuningConfig.originalTuningFreq = tuningConfig.tuningFreq;

    if (isNaN(tuningConfig.tuningFreq)) {
        return null;
    }

    // PARSE NOMINALS
    //
    //

    var hasInvalid = false;
    var nominals = lines[1].split(' ').map(function (x) {
        var f = parseCentsOrRatio(x);
        if (f == null) hasInvalid = true;
        return f
    });

    if (hasInvalid) {
        log('Invalid nominal decl: ' + lines[1]);
        return null;
    }

    tuningConfig.nominals = nominals.slice(0, nominals.length - 1);
    tuningConfig.equaveSize = nominals[nominals.length - 1];
    if (tuningConfig.equaveSize == 0) {
        console.error('TUNING CONFIG ERROR: Equave size must be non-zero!');
        return null;
    }
    tuningConfig.numNominals = tuningConfig.nominals.length;

    // PARSE ACCIDENTAL CHAINS
    //
    //

    for (var i = 2; i < lines.length; i++) {
        var line = lines[i].trim();

        // each new line is a new accidental chain.

        // terminate when 'lig(x,y,...)' is found (move on to ligature declarations)
        // terminate when 'aux(x,y,...)' is found (move on to aux stepwise declarations)

        var matches = line.match(/(lig|aux|sec|explicit|nobold|override|displaycents|displaysteps)\([0-9,a-zA-Z\s]*\)/);
        if (matches != null) {
            break;
        }

        var accChainWords = line.split(' ').map(function (x) { return x.trim(); });

        var increment = null;
        var symbolsLookup = {}; // contains all unique symbols used.
        var degreesSymbols = [];
        var tunings = [];
        var offsets = [];
        var centralIdx = null;
        var incrementLogText = "";

        for (var j = 0; j < accChainWords.length; j++) {
            var word = accChainWords[j];

            var matchIncrement = word.match(/^\((.+)\)$/);

            if (matchIncrement != null) {
                var maybeIncrement = parseCentsOrRatio(matchIncrement[1]);

                if (maybeIncrement == null) {
                    console.warn('TUNING CONFIG: ' + (i + 1) + ': invalid accidental chain increment: ' + matchIncrement[1]
                        + '\nAttempting to parse as symbols instead');
                } else if (increment != null) {
                    console.error('TUNING CONFIG ERROR: Multiple acc chain increments specified in: ' + line);
                } else {
                    increment = maybeIncrement;
                    incrementLogText = matchIncrement[1];
                    degreesSymbols.push(null);
                    offsets.push(0);
                    centralIdx = j;
                    continue;
                }
            }

            // degree syntax: sym1.sym2.symN(<optional additional cents offset>)
            // e.g.: +.7./(-23.5) declares a degree containing:
            // SHARP_SLASH, FLAT2, ARROW_UP symbols
            // with additional offset -23.5 cents

            var symbols_offset = parseSymbolOffsetPair(word);

            var symbolCodes = parseSymbolsDeclaration(symbols_offset[0]);

            if (symbolCodes == null) {
                console.error('TUNING CONFIG ERROR: ' + (i + 1) + ': Could not parse accidental decl: ' + word);
                return null;
            }

            var offset = symbols_offset[1];

            symbolCodes.forEach(function (x) {
                symbolsLookup[x] = true;
                tuningConfig.usedSymbols[x] = true;
            });

            degreesSymbols.push(symbolCodes);
            offsets.push(offset);
        }

        if (increment == null || centralIdx == null) {
            console.error('TUNING CONFIG ERROR: ' + (i + 1) + ': Invalid accidental chain: "' + accChainWords.join(' ') + '" in ' + line);
            return null;
        }

        for (var j = 0; j < offsets.length; j++) {
            if (j == centralIdx)
                tunings.push(0);
            else
                tunings.push((j - centralIdx) * increment + offsets[j]);
        }

        // Add new acc chain
        tuningConfig.accChainLogTexts.push(line);
        tuningConfig.accChains.push({ // AccidentalChain
            degreesSymbols: degreesSymbols,
            symbolsUsed: Object.keys(symbolsLookup),
            tunings: tunings,
            centralIdx: centralIdx,
            stepLogText: incrementLogText,
        });
    }

    // PARSE OTHER CONFIGS
    // (can be declared in any order)
    //
    // lig(x,y,...)
    // aux(x,y,...)
    // sec()
    //
    //

    /**
     * Stores current parsing state.
     * 
     * First value is a string that signifies what info the parser is
     * parsing. Empty string `''` denotes that the parser is awaiting
     * EOF or a new config declaration.
     * 
     * Only `'lig'` and `'sec'` are valid states which have additional
     * data.
     * 
     * If state is `'lig'`, the second value is a {@link Ligature} object.
     * 
     * @type {[''|'lig'|'sec'|'override', Ligature?]}
     */
    var state = [];

    /**
     * After EOF or at the start of each new declaration, add the previously
     * parsed declaration to the tuning config.
     * 
     * Call this before modifying the `state`.
     */
    var commitParsedSection = function () {
        if (state.length == 0)
            return;

        if (state[0] == 'lig') {
            // Push the ligature to the tuning config.
            tuningConfig.ligatures.push(state[1]);
        }

        // The other parsing states commit info as they go,
        // so there's nothing else to do here.
    }

    for (; i < lines.length; i++) {
        var line = lines[i].trim();
        var ligMa = line.match(/^lig\(([0-9,\s]+)\)([\?!]*)/);
        var auxMa = line.match(/^aux\(([0-9,\s]+)\)/);
        var secMa = line == 'sec()';
        var noBold = line == 'nobold()';
        var explicit = line == 'explicit()';
        var override = line == 'override()';
        var displayCentsMa = line.match(/^displaycents\(([0-9,\sa-zA-Z]+)\)/);
        var displayStepsMa = line.match(/^displaysteps\(([0-9,\sa-zA-Z]+)\)/);

        // First we check for declaration lines lig, aux, or sec.
        // Is so, we process the declaration and possibly update the parser state.

        if (auxMa != null) {
            hasInvalid = false;
            var auxSourceLine = rawAuxDeclarations[rawAuxIndex] || line;
            rawAuxIndex++;
            var nomAndChainIndices = auxMa[1]
                .split(',')
                .map(function (x) {
                    var auxIdx = parseInt(x);
                    // recall:
                    // 0: change nominal
                    // 1 to N: change accidental chain (1-based index)
                    if (isNaN(auxIdx) || auxIdx < 0 || auxIdx > tuningConfig.accChains.length) {
                        console.error('TUNING CONFIG ERROR: ' + (auxIdx + 1) + ': Invalid accidental chain index: ' + x
                            + '\nin aux declaration: ' + line);
                        hasInvalid = true;
                    }
                    return auxIdx;
                });
            if (hasInvalid)
                return null;

            var constantConstrictions = []; // ConstantConstrictions list

            for (var accChainIdx = 0; accChainIdx < tuningConfig.accChains.length; accChainIdx++) {
                // invert the accidental chains - only accidental chains not specified by the aux declaration
                // should maintain at the same degree.

                // accChainIdx is 0-based, +1 to make it 1-based.
                if (nomAndChainIndices.indexOf(accChainIdx + 1) != -1)
                    continue;

                constantConstrictions.push(accChainIdx + 1);
            }

            // aux(0) Represents that the nominal should change.
            // if the user doesn't specify 0, then the nominal should not change.

            if (nomAndChainIndices.indexOf(0) == -1)
                constantConstrictions.push(0);

            tuningConfig.auxList.push(constantConstrictions);
            tuningConfig.auxLogTexts.push(formatAuxLogText(auxSourceLine, nomAndChainIndices, tuningConfig));

            commitParsedSection();
            state = []; // aux has no section. await next section.
            continue;
        } else if (ligMa != null) {
            var regarding = ligMa[1]
                .split(',')
                .map(function (x) {
                    var n = parseInt(x);
                    if (isNaN(n) || n < 1) hasInvalid = true;
                    return n - 1;
                });

            if (hasInvalid) {
                console.error('TUNING CONFIG ERROR: ' + (i + 1) + ': Invalid ligature declaration: ' + line);
                return null;
            }

            var isWeak = false;
            var isImportant = false;

            if (ligMa[2]) {
                if (ligMa[2].indexOf('!') != -1)
                    isImportant = true;
                if (ligMa[2].indexOf('?') != -1)
                    isWeak = true;
            }

            commitParsedSection();
            state = [
                'lig',
                {
                    regarding: regarding,
                    isWeak: isWeak,
                    isImportant: isImportant,
                    ligAvToSymbols: {},
                }
            ];
            continue;
        } else if (secMa) {
            commitParsedSection();
            state = ['sec'];
            continue;
        } else if (noBold) {
            commitParsedSection();
            tuningConfig.nonBoldTextAccidental = true;
            state = [];
            continue;
        } else if (explicit) {
            commitParsedSection();
            tuningConfig.alwaysExplicitAccidental = true;
            state = [];
            continue;
        } else if (override) {
            commitParsedSection();
            state = ['override'];
            continue;
        } else if (displayStepsMa != null) {
            commitParsedSection();
            state = [];
            var csv = displayStepsMa[1].split(',').map(function (x) { return x.trim() });
            if (csv.length != 2) {
                console.error('TUNING CONFIG ERROR: ' + (i + 1) + ': Invalid displaysteps declaration. Expected 2 arguments: ' + line);
                return null;
            }

            var steps = parseInt(csv[0]);
            var position = csv[1];

            if (isNaN(steps) || steps < 2) {
                console.error('TUNING CONFIG ERROR: ' + (i + 1) +
                    ': Invalid displaysteps declaration, invalid edo/neji steps: ' + line);
                return null;
            }
            if (position != 'above' && position != 'below') {
                console.error('TUNING CONFIG ERROR: ' + (i + 1) +
                    ': Invalid displaysteps declaration, display must be above or below: ' + line);
                return null;
            }

            tuningConfig.displaySteps = steps;
            tuningConfig.displayStepsPosition = position;
            continue;
        } else if (displayCentsMa != null) {
            commitParsedSection();
            state = [];
            var csv = displayCentsMa[1].split(',').map(function (x) { return x.trim() });
            if (csv.length != 3) {
                console.error('TUNING CONFIG ERROR: ' + (i + 1) + ': Invalid displaycents declaration. Expected 3 arguments: ' + line);
                return null;
            }

            var centType = csv[0];
            var precision = parseInt(csv[1]);
            var position = csv[2];

            if (centType != 'nominal' && centType != 'absolute' && centType != 'semitone') {
                console.error('TUNING CONFIG ERROR: ' + (i + 1) +
                    ': Invalid displaycents declaration. Cent type must be nominal/absolute/semitone: ' + line);
                return null;
            }
            if (isNaN(precision) || precision < 0 || precision > 20) {
                console.error('TUNING CONFIG ERROR: ' + (i + 1) +
                    ': Invalid displaycents declaration, invalid precision specified: ' + line);
                return null;
            }
            if (position != 'above' && position != 'below') {
                console.error('TUNING CONFIG ERROR: ' + (i + 1) +
                    ': Invalid displaycents declaration, display must be above or below: ' + line);
                return null;
            }

            tuningConfig.displayCentsReference = centType;
            tuningConfig.displayCentsPrecision = precision;
            tuningConfig.displayCentsPosition = position;
            continue;
        }

        // If we are here, then there are no section/setting declarations

        if (state.length == 0) {
            console.error('TUNING CONFIG ERROR: ' + (i + 1)
                + ': Expected aux(...), lig(...), sec(), explicit(), or nobold(). Instead, got '
                + line);
            return null;
        }

        if (state[0] == 'lig') {
            // parse ligature entry.
            var words = line.split(' ').map(function (x) { return x.trim() });
            var ligAv = words.slice(0, words.length - 1).map(function (x) { return parseInt(x) });

            var ligatureSymbols = parseSymbolsDeclaration(words[words.length - 1]);

            if (ligatureSymbols == null) {
                return null;
            }

            ligatureSymbols.forEach(function (x) {
                tuningConfig.usedSymbols[x] = true;
            });

            state[1].ligAvToSymbols[ligAv] = ligatureSymbols;
        } else if (state[0] == 'sec') {
            // parse secondary accidental declaration.
            // directly modifies the tuning config.

            var words = line.split(' ').map(function (x) { return x.trim() });
            var numNomsMin1 = tuningConfig.numNominals - 1;
            var firstWordSymCodes = parseSymbolsDeclaration(words[0]);

            if (firstWordSymCodes == null) {
                console.error('TUNING CONFIG ERROR: ' + (i + 1) + ': Invalid secondary symbol declaration: ' + line
                    + '\n"' + words[0] + '" is not a valid symbol code combination.');
                return null;
            }

            var firstWordIsSingleElemTextAcc = firstWordSymCodes.length == 1 && typeof (firstWordSymCodes[0]) == 'string';
            var maybeSecondWordSymbol = parseSymbolsDeclaration(words[1], true);
            var maybeSecondWordCents = parseCentsOrRatio(words[1], true);

            if (words.length == 2 || (words.length == 2 + numNomsMin1 &&
                !(words.length == 3 && firstWordIsSingleElemTextAcc &&
                    (maybeSecondWordSymbol == null && maybeSecondWordCents != null))
            )
                // if there's only 2 nominals, the sec acc decl has 3 words, and the first word is
                // a single-element text accidental,
                // the decl can only be treated as a per-nominal sec declaration with
                // implicit text replacement IF the second word DEFINITELY IS NOT a symbol
                // and COULD BE a cents/ratio.
                // Otherwise it defaults to a nominal-agnostic secondary acc tuning
                // with explicit text replacement with the second word treated as
                // Symbol Codes.
            ) {
                // Declaring a secondary symbol without conversion
                var cents = [];

                for (var wordIdx = 1; wordIdx < words.length; wordIdx++) {
                    var maybeCents = parseCentsOrRatio(words[wordIdx]);
                    if (maybeCents == null) {
                        console.error('TUNING CONFIG ERROR: ' + (i + 1) + ': Invalid secondary symbol declaration: ' + line
                            + '\n"' + words[wordIdx] + '" is not a valid cents or ratio tuning.');
                        if (words.length > 2)
                            log('HELP: Did you specify the correct number of nominals for per-nominal tuning declaration?');
                        return null;
                    }
                    cents.push(maybeCents);
                }

                var accHash = accidentalsHash(firstWordSymCodes);

                tuningConfig.secondaryAccList.push(accHash);
                tuningConfig.secondaryAccIndexTable[accHash] = tuningConfig.secondaryAccList.length - 1;
                tuningConfig.secondaryAccTable[accHash] = firstWordSymCodes;
                tuningConfig.secondaryTunings[accHash] = cents.length == 1 ? cents[0] : cents;

                firstWordSymCodes.forEach(function (c) {
                    tuningConfig.usedSecondarySymbols[c] = true;
                });

                // if the declared SymbolCode is a single-element, pure ASCII symbol,
                // implicitly declare the ASCII-to-SymCode conversion.

                // in these cases, it is obvious that if the user enters the
                // ASCII of the accidental itself, the user will want that exact
                // ASCII to be entered as a symbol.

                if (firstWordIsSingleElemTextAcc) {
                    var asciiFrom = firstWordSymCodes[0].slice(1);
                    tuningConfig.asciiToSmuflConv[asciiFrom] = firstWordSymCodes;
                    tuningConfig.asciiToSmuflConvList.push(asciiFrom);
                }
            } else if (words.length == 3 || words.length == 3 + numNomsMin1) {
                // Declaring a secondary symbol with conversion.
                // Conversion always goes from ASCII

                if (!firstWordIsSingleElemTextAcc) {
                    console.error('TUNING CONFIG ERROR: ' + (i + 1) + ': Convert-from text must be a single-element text symbol.\n'
                        + 'Received a multi-symbol/hybrid accidental instead' + line);
                    return null;
                }

                // The first word must be the ascii to be converted
                var symCodesTo = parseSymbolsDeclaration(words[1]);
                var cents = [];

                if (symCodesTo == null) {
                    console.error('TUNING CONFIG ERROR: ' + (i + 1) + ': Invalid secondary symbol declaration: ' + line
                        + '\n"' + words[1] + '" is not a valid symbol code combination.');
                    return null;
                }

                for (var wordIdx = 2; wordIdx < words.length; wordIdx++) {
                    var maybeCents = parseCentsOrRatio(words[wordIdx]);
                    if (maybeCents == null) {
                        console.error('TUNING CONFIG ERROR: ' + (i + 1) + ': Invalid secondary symbol declaration: ' + line
                            + '\n"' + words[wordIdx] + '" is not a valid cents or ratio tuning.');
                        return null;
                    }
                    cents.push(maybeCents);
                }

                // remove the preceding quote from the ascii SymbolCode
                var asciiFrom = firstWordSymCodes[0].slice(1);
                var accHashTo = accidentalsHash(symCodesTo);

                tuningConfig.secondaryAccList.push(accHashTo);
                tuningConfig.secondaryAccIndexTable[accHashTo] = tuningConfig.secondaryAccList.length - 1;
                tuningConfig.secondaryAccTable[accHashTo] = symCodesTo;
                tuningConfig.secondaryTunings[accHashTo] = cents.length == 1 ? cents[0] : cents;
                tuningConfig.asciiToSmuflConv[asciiFrom] = symCodesTo;
                tuningConfig.asciiToSmuflConvList.push(asciiFrom);

                symCodesTo.forEach(function (c) {
                    tuningConfig.usedSecondarySymbols[c] = true;
                });
            } else {
                console.error('TUNING CONFIG ERROR: ' + (i + 1) +
                    ': Secondary symbol declaration must have 2 or 3 (for nominal-agnostic tunings) or '
                    + (2 + numNomsMin1) + ' or ' + (3 + numNomsMin1)
                    + ' (for nominal-specific tunings) space-separated words. Got: ' + line);
                return null;
            }
        } else if (state[0] == 'override') {
            // parse override() declarations.

            var words = line.split(' ').map(function (x) { return x.trim() });

            /*
            format of each override decl:
            <nominal:int[0, N]> <avdeg1: int> ... <avdegN: int> <ratio/cents from fundamental>
            */

            if (words.length != tuningConfig.accChains.length + 2) {
                console.error('TUNING CONFIG ERROR: ' + (i + 1)
                    + ': Override declaration has incorrect number of acc vector degrees in: ' + line
                    + '\nExpected ' + tuningConfig.accChains.length + ' degrees, got ' + (words.length - 2)
                    + ' instead.');
                log('HELP: Make sure there are no spaces in the cents/ratio tuning');
                return null;
            }

            var nominal = parseInt(words[0]);
            var av = words.slice(1, words.length - 1).map(function (x) { return parseInt(x) });
            var overrideCents = parseCentsOrRatio(words[words.length - 1]);

            if (isNaN(nominal) || nominal < 0 || nominal >= tuningConfig.numNominals) {
                console.error('TUNING CONFIG ERROR: ' + (i + 1)
                    + ': Override declaration has invalid nominal ' + words[0] + ' in ' + line
                    + '\nExpected a number from 0 to ' + (tuningConfig.numNominals - 1) + ' inclusive.');
                return null;
            }

            var isValid = true;
            for (var avIdx = 0; avIdx < av.length; avIdx++) {
                var deg = av[avIdx];
                var min = -tuningConfig.accChains[avIdx].centralIdx;
                var max = min + tuningConfig.accChains[avIdx].length - 1;
                if (isNaN(deg) || deg < min || deg > max) {
                    console.error('TUNING CONFIG ERROR: ' + (i + 1)
                        + ': Override declaration has invalid accidental vector degree ' + words[avIdx + 1] + ' in ' + line
                        + '\nExpected a number from ' + min + ' to ' + max + ' inclusive.');
                    isValid = false;
                    break;
                }
            }

            if (!isValid) {
                return null;
            }

            if (overrideCents == null) {
                console.error('TUNING CONFIG ERROR: ' + (i + 1)
                    + ': Override declaration has invalid cents/ratio ' + words[words.length - 1] + ' in ' + line);
                return null;
            }

            tuningConfig.tuningOverrideTable[[nominal].concat(av)] = overrideCents;
        }
    }

    commitParsedSection();

    //
    //
    // END OF PARSING
    //
    //

    //
    //
    // SETTLE PERMUTATIONS OF XenNotes
    // 
    //

    /**
     * Permute all combinations of accidental chains.
     * 
     * The number of accidental chains can vary, so we need a way to
     * generate a variable number of nested for loops.
     */

    // This will be populated with all possible permutations of
    // accidental vectors.
    //
    // E.g. in the case of 2 accidental chains, this will be:
    // [0, 0], [0, 1], [0, 2], ...
    // [1, 0], [1, 1], [1, 2], ...
    // ...
    var idxPermutations = [];

    for (var i = 0; i < tuningConfig.accChains.length; i++) {
        var accChain = tuningConfig.accChains[i];

        if (idxPermutations.length == 0) {
            // first iteration: populate with indices of first acc chain.
            for (var j = 0; j < accChain.degreesSymbols.length; j++) {
                idxPermutations.push([j]);
            }

            continue;
        }

        // subsequent iterations: permute existing indices with indices of
        // current acc chain

        var newPermutations = [];

        for (var j = 0; j < accChain.degreesSymbols.length; j++) {
            for (var k = 0; k < idxPermutations.length; k++) {
                newPermutations.push(idxPermutations[k].concat([j]));
            }
        }

        idxPermutations = newPermutations;
    }

    // Now we have all permutations of accidental vectors by index

    /* 
    Contains all possible XenNote names within one equave.

    A list of objects, each containing:
        - av AccidentalVector (with 0 being the centralIdx)
        - xen XenNote
        - cents (cents from nominal modulo equave)
        - equavesAdjusted (non-zero if cents was wrapped around the equave)
    */


    /**
     * This is a KVP of {@link XenNote.hash XenNote hashes} to {@link XNE}.
     * 
     * The user may declare ligatures that have the same {@link XenNote.hash} as
     * existing {@link XenNote XenNotes} from the accidental chains to explicitly give
     * them 'important' priority. (See `hewm/5 limit.txt` or `updown/22edo.txt`)
     * 
     * It's important to let ligatured {@link XNE} override default {@link XNE} entries
     * that come from acc chains.
     * 
     * @type {XenNotesEquaves}
     */
    var xenNotesEquaves = {};

    // Now we iterate the nominals to populate

    for (var nomIdx = 0; nomIdx < tuningConfig.nominals.length; nomIdx++) {
        var nominalCents = tuningConfig.nominals[nomIdx];

        // if there are no accidental chains, we can just add the nominal

        if (tuningConfig.accChains.length == 0) {
            var hash = createXenHash(nomIdx, {});
            var cents = nominalCents;
            var equavesAdjusted = 0;

            if (tuningConfig.tuningOverrideTable[[nomIdx]]) {
                cents = tuningConfig.tuningOverrideTable[[nomIdx]];
            }

            var centsEquavesAdjusted = normalizeCentsToEquave(cents, tuningConfig.equaveSize);
            cents = centsEquavesAdjusted[0];
            equavesAdjusted = centsEquavesAdjusted[1];
            xenNotesEquaves[hash] = {
                av: [],
                xen: { // XenNote
                    nominal: nomIdx,
                    orderedSymbols: [],
                    accidentals: null,
                    hash: hash,
                    hasLigaturePriority: false, // these don't matter
                    hasImportantLigature: true,
                },
                cents: cents,
                equavesAdjusted: equavesAdjusted,
            };
            continue;
        }

        // otherwise, iterate all permutations of accidental vectors
        // and create a new entry for each accidental vector

        for (var j = 0; j < idxPermutations.length; j++) {
            var avIndices = idxPermutations[j];
            var centOffset = 0;
            var accidentalVector = [];
            var accidentalSymbols = {};

            /*
            Stores the order that the SymbolCode keys should appear in.
            This determines the order accidentals will be displayed left-to-right.

            According to spec, symbols belonging to the first accidental chain 
            should be displayed right-most.

            If a single degree of a chain consists of multiple symbols, they are to be
            displayed left-to-right in the order the user specified.
            */
            var orderedSymbols = [];

            for (var accChainIdx = 0; accChainIdx < tuningConfig.accChains.length; accChainIdx++) {
                // Loop each accidental chain of the current accidental vector.

                var accChain = tuningConfig.accChains[accChainIdx];
                var avIdx = avIndices[accChainIdx];
                // Degree of this acc chain.
                var accDegree = avIdx - accChain.centralIdx;

                accidentalVector.push(accDegree);

                if (accDegree == 0) {
                    // The degree on this chain is 0, it doesn't contribute to
                    // the accidental. Continue.
                    continue;
                }

                // Symbols used for this degree.
                // If there are multiple, they are in left-to-right order which
                // the user specified them.
                var accSymbols = accChain.degreesSymbols[avIdx];

                var newSymbols = [];

                accSymbols.forEach(function (symCode) {
                    if (accidentalSymbols[symCode]) {
                        accidentalSymbols[symCode]++;
                    } else {
                        accidentalSymbols[symCode] = 1;
                    }
                    newSymbols.push(symCode);
                });

                // Since the first accidental chain should be right-most,
                // the newer symbols should be concat to the left of the
                // rest of the symbols.
                orderedSymbols = newSymbols.concat(orderedSymbols);

                centOffset += accChain.tunings[avIdx];
            }

            var cents = nominalCents + centOffset;
            var equavesAdjusted = 0;

            if (tuningConfig.tuningOverrideTable[[nomIdx].concat(accidentalVector)]) {
                cents = tuningConfig.tuningOverrideTable[[nomIdx].concat(accidentalVector)];
            }

            var centsEquavesAdjusted = normalizeCentsToEquave(cents, tuningConfig.equaveSize);
            cents = centsEquavesAdjusted[0];
            equavesAdjusted = centsEquavesAdjusted[1];

            var hash = createXenHash(nomIdx, accidentalSymbols);
            xenNotesEquaves[hash] = {
                av: accidentalVector,
                xen: { // XenNote
                    nominal: nomIdx,
                    orderedSymbols: orderedSymbols,
                    accidentals: orderedSymbols.length == 0 ? null : accidentalSymbols,
                    hash: hash,
                    hasLigaturePriority: false,
                    hasImportantLigature: false,
                },
                cents: cents,
                equavesAdjusted: equavesAdjusted,
            };

            tuningConfig.avToSymbols[accidentalVector] = orderedSymbols;


            // SETTLE IMPLEMENTING LIGATURES AS ENHARMONICS
            //
            //

            /** 
             * A list of orderedSymbols that are populated as ligatures are found.
             * Every subsequent ligature match builds upon prior enharmonically equivalent spellings.
             * 
             * E.g. lets say we have symbols [a,b,c,d].
             * Ligature 1 matches [a,b] into X and ligature 2 matches [c,d] into Y.
             * 
             * This value will initialize with only [[1,2,3,4]].
             * After processing lig 1, it will contain [[1,2,3,4], [X,3,4]].
             * After processing lig 2, it will contain [[1,2,3,4], [X,3,4], [1,2,Y], [X,Y]], where
             * each new value is lig2 applied to each of the previous values.
             * 
             * All of which are valid equivalent ligatured spellings of the original symbols.
             * 
             * This implementation relies on the fact that ligatures declared do not entirely overlap.
             * It is up to the user's discretion to ensure ligatures are sensible.
             * 
             * @type {SymbolCode[][]} 
             */
            var ligatureEnharmonics = [orderedSymbols];

            /**
             * Keeps track of the highest ligature precedence encountered so far, so
             * that a lower-precedence ligature does not override the
             * {@link TuningConfig.avToSymbols} lookup which determines the best way to
             * represent a particular AV when accidentals are entered via fingering.
             * 
             * 0: weak, non-important (does not override avToSymbols lookup)
             * 1: strong, non-important
             * 2: weak, important
             * 3: strong, important
             */
            var highestPrecedenceEncountered = 0;

            tuningConfig.ligatures.forEach(function (lig) {
                var newEnharmonicsToAdd = [];
                var currLigPrecedence = lig.isWeak + lig.isImportant * 2;
                ligatureEnharmonics.forEach(function (unligSymbols) {
                    var ligAv = [];

                    // This list will contain the ligatured spelling of the accidental.
                    // Only used when a ligature match is found.
                    var ligOrderedSymbols = unligSymbols.map(function (x) { return x; }); // shallow copy

                    /*
                    As per spec, the ligatured symbols take the place of the right-most
                    symbol it replaces.
                    */

                    // Stores the index of the right-most symbol it replaces.
                    // This will be where the ligature is inserted.
                    var ligSymbolIdx = 0;

                    lig.regarding.forEach(function (idx) {
                        // idx represents each accidental chain that this ligature checks for
                        var deg = accidentalVector[idx];

                        // append this degree to the ligature subspace vector.
                        ligAv.push(deg);

                        // Remove symbols from ligOrderedSymbols that are
                        // replaced by the ligature.

                        var accChain = tuningConfig.accChains[idx];
                        var symbolsCausedByDegree = accChain.degreesSymbols[avIndices[idx]];

                        if (symbolsCausedByDegree == null) {
                            // continue. the current degree of this accidental vector doesn't need any symbols
                            return;
                        }

                        for (var sIdx = 0; sIdx < symbolsCausedByDegree.length; sIdx++) {
                            var symCode = symbolsCausedByDegree[sIdx];
                            var idxOfSymbol = ligOrderedSymbols.lastIndexOf(symCode);
                            if (idxOfSymbol == -1) {
                                console.warn('TUNING CONFIG WARN: Cannot find symbol to remove based on standard accidental chain when creating ligatures.'
                                    + ' This shouldn\'t happen. Pretending the nothing is wrong.');
                                return;
                            }
                            ligOrderedSymbols.splice(idxOfSymbol, 1);
                            if (idxOfSymbol > ligSymbolIdx) {
                                ligSymbolIdx = idxOfSymbol;
                            } else if (idxOfSymbol < ligSymbolIdx) {
                                // If removed symbol is before ligSymbolIdx,
                                // push the lig symbol up 1 index.
                                ligSymbolIdx--;
                            }
                        }
                    });

                    // contains symbols from ligature, in user-specified order.
                    var ligSymbols = lig.ligAvToSymbols[ligAv];

                    if (ligSymbols) {
                        // A ligature match is found.

                        // Insert the ligature symbols into the ordered symbols.
                        ligOrderedSymbols = ligOrderedSymbols
                            .slice(0, ligSymbolIdx)
                            .concat(ligSymbols)
                            .concat(ligOrderedSymbols.slice(ligSymbolIdx));

                        // Add the ligature as if it were an enharmonic equivalent.

                        var hash = createXenHash(nomIdx, ligOrderedSymbols);
                        // log(hash + ': ligOrderedSymbols: ' + JSON.stringify(ligOrderedSymbols));
                        xenNotesEquaves[hash] = {
                            av: accidentalVector,
                            xen: { // XenNote
                                nominal: nomIdx,
                                orderedSymbols: ligOrderedSymbols,
                                accidentals: ligOrderedSymbols.length == 0 ? null : accidentalSymbolsFromList(ligOrderedSymbols),
                                hash: hash,
                                hasLigaturePriority: !lig.isWeak,
                                hasImportantLigature: lig.isImportant,
                            },
                            cents: cents,
                            equavesAdjusted: equavesAdjusted,
                        };

                        newEnharmonicsToAdd.push(ligOrderedSymbols);

                        if (currLigPrecedence >= 1 && currLigPrecedence >= highestPrecedenceEncountered) {
                            // Only strong or important ligatures can override the default
                            // best representation of the accidental vector.
                            tuningConfig.avToSymbols[accidentalVector] = ligOrderedSymbols;
                            highestPrecedenceEncountered = currLigPrecedence;
                        }
                    }
                });
                ligatureEnharmonics = ligatureEnharmonics.concat(newEnharmonicsToAdd);
            }); // end iterating ligatures
        } // end iterating idxPermutations
    }
    // end of xenNotesEquaves population

    // SETTLE TABLE LOOKUPS
    //
    //

    /*
        Sort all XenNotes by cents, then by accidentalVector.join()

        (array comparison uses .join implicitly)
    */

    /**
     * @type {SortedXNE}
     */
    var sortedXNEs =
        Object.keys(xenNotesEquaves)
            .map(function (x) { return xenNotesEquaves[x]; })
            .sort(function (a, b) {
                if (a.cents != b.cents)
                    return a.cents - b.cents;

                var avLength = Math.min(a.av.length, b.av.length);
                for (var avIdx = 0; avIdx < avLength; avIdx++) {
                    if (a.av[avIdx] != b.av[avIdx])
                        return a.av[avIdx] - b.av[avIdx];
                }

                if (a.av.length != b.av.length)
                    return a.av.length - b.av.length;
                if (a.xen.hash < b.xen.hash)
                    return -1;
                if (a.xen.hash > b.xen.hash)
                    return 1;
                return 0;
            });

    /*
    Iterate all XenNotes in order
    */

    // Contains cents of previous note.
    // If current note is enharmonically equivalent, don't update this value.
    var prevEnhEquivCents = null;
    var firstNoteCents = null;

    sortedXNEs.forEach(function (x) {
        var av = x.av;
        var xenNote = x.xen;
        var cents = x.cents;
        var equavesAdjusted = x.equavesAdjusted;
        var hash = xenNote.hash;

        if (firstNoteCents == null)
            firstNoteCents = cents;

        // Add to NotesTable
        tuningConfig.notesTable[hash] = xenNote;
        tuningConfig.avTable[hash] = av;
        tuningConfig.tuningTable[hash] = [cents, equavesAdjusted];

        if (prevEnhEquivCents != null && isEnharmonicallyEquivalent(cents, prevEnhEquivCents, tuningConfig.equaveSize)) {
            // Curr note should belong to the same group as prev note.
            // Safe to assume tuningConfig.stepsList is not empty.

            // Contains list of enharmonically equivalent XenNote hashes.
            var enharmGroup = tuningConfig.stepsList[tuningConfig.stepsList.length - 1];
            enharmGroup.push(hash);
            tuningConfig.stepsLookup[hash] = tuningConfig.stepsList.length - 1;
        } else if (prevEnhEquivCents != null && isEnharmonicallyEquivalent(cents, firstNoteCents, tuningConfig.equaveSize)) {
            // we looped back to the first note from the other end.
            // Add to the first step.
            tuningConfig.stepsList[0].push(hash);
            tuningConfig.stepsLookup[hash] = 0;
        } else {
            // Curr note is not enharmonically equivalent.

            // Add new entry in StepwiseList

            tuningConfig.stepsList.push([hash]);
            tuningConfig.stepsLookup[hash] = tuningConfig.stepsList.length - 1;

            // Update cents of new note.
            prevEnhEquivCents = cents;
        }
    });

    // Populate enharmonic graphs:

    for (var i = 0; i < tuningConfig.stepsList.length; i++) {
        var allEnhEquivNotes = tuningConfig.stepsList[i];
        // true if hasImportantLigature
        var containsImportantFlag = false;
        var importantOrNominal = allEnhEquivNotes.filter(function (hash) {
            var note = tuningConfig.notesTable[hash];
            if (note.hasImportantLigature) {
                containsImportantFlag = true;
                return true;
            }

            if (note.accidentals == null) {
                return true;
            }
            return false;
        });
        var enhEquivNotes = allEnhEquivNotes;
        if (containsImportantFlag) {
            // if some notes in the enharmonic equivalent list have important ligatures,
            // we only want to consider important or nominal notes.
            enhEquivNotes = importantOrNominal;
        }
        // otherwise, we should consider all notes as enharmonic cyclable.

        if (enhEquivNotes.length > 1) {
            // If there are more than one enharmonic equivalents,
            // populate the enharmonic graph.

            // log((i+1) + '/' + tuningConfig.stepsList.length + ': ' 
            //     + JSON.stringify(enhEquivNotes));

            for (var j = 0; j < enhEquivNotes.length; j++) {
                var hash = enhEquivNotes[j];
                var nextHash = enhEquivNotes[(j + 1) % enhEquivNotes.length];
                tuningConfig.enharmonics[hash] = nextHash;
            }
        }

        if (containsImportantFlag && enhEquivNotes.length > 0) {
            // Spellings excluded by important-ligature preference must still
            // have an outgoing edge. This is especially important for existing
            // MuseScore-native accidentals: the first enharmonic action moves
            // them into the preferred cycle instead of becoming a no-op.
            var preferredHash = enhEquivNotes[0];
            for (var excludedIdx = 0;
                excludedIdx < allEnhEquivNotes.length;
                excludedIdx++) {
                var excludedHash = allEnhEquivNotes[excludedIdx];
                if (enhEquivNotes.indexOf(excludedHash) == -1)
                    tuningConfig.enharmonics[excludedHash] = preferredHash;
            }
        }
    }

    // DONE!

    // Make sure to save the new tuning to the runtime and metaTag caches.

    if (_curScore) {
        tuningConfigCache[cacheKey] = tuningConfig;
        saveMetaTagCache();

        log('Saved tuning to runtime & metaTag cache.');
    }

    log(tuningConfig.stepsList.length + ' notes/equave');

    return tuningConfig;
}

/**
 * Parse System/Staff Text into `KeySig` object.
 * 
 * Key Sig text example format for tuning system with 5 nominals:
 * 
 * ```txt
 * keysig x./ 20 0 +.9 3
 * ```
 * 
 * The above KeySig denotes for the 1st to 5th nominals respectively: 
 * 
 * 1. double sharp & up arrow
 * 2. SymbolCode 20
 * 3. no accidental
 * 4. quarter sharp & SymbolCode 9
 * 5. SymbolCode 3
 * 
 * - KeySig declarations must be prepended with 'keysig' (cAsE dOeSn'T mAtTeR)
 * 
 * - Every nominal must be separated with one or more spaces
 * 
 * - Multiple symbols on one nominal must be separated by a period (.), as per usual.
 * 
 * 
 * WARNING: The returned KeySig may not have the correct number of nominals
 * for the tuning system. It's important to CHECK if the `KeySig` is valid
 * w.r.t. the tuning system before trying to apply it in `readNoteData()` or
 * anywhere else.
 * 
 * @param {string} text System/Staff Text content
 * @returns {KeySig?} KeySig object or null if not a KeySig
 */
function parseKeySig(text) {
    var trimmedText = text.trim();
    if (!trimmedText.match(/^keysig!?(?:\s|$)/i)) {
        return null;
    }

    var nomSymbols = trimmedText.split(/\s+/).slice(1);

    var keySig = [];

    nomSymbols.forEach(function (s) {
        var symCodes = parseSymbolsDeclaration(s);

        if (symCodes == null) {
            keySig.push(null);
        } else {
            keySig.push(keySignatureAccidentalHashFromSymbols(symCodes));
        }
    });

    log('Parsed keySig: ' + JSON.stringify(keySig));

    return keySig;
}

var KEY_SIGNATURE_DEGREE_TO_NATIVE_NOMINAL = [2, 3, 4, 5, 6, 0, 1]; // C D E F G A B
var KEY_SIGNATURE_LETTER_TO_NATIVE_NOMINAL = {
    a: 0,
    b: 1,
    c: 2,
    d: 3,
    e: 4,
    f: 5,
    g: 6
};

function keySignatureSequenceTokens(sequence) {
    if (Array.isArray(sequence)) {
        return sequence.map(function (token) {
            return String(token).trim();
        });
    }

    if (sequence === undefined || sequence === null)
        return [];

    var text = String(sequence).trim();
    if (text.length == 0)
        return [];

    if (text.match(/[\s,]/)) {
        return text.split(/[\s,]+/).filter(function (token) {
            return token.length > 0;
        });
    }

    return text.split('');
}

function keySignatureNativeNominal(sequenceToken) {
    var token = String(sequenceToken).trim().toLowerCase();
    if (KEY_SIGNATURE_LETTER_TO_NATIVE_NOMINAL[token] !== undefined)
        return KEY_SIGNATURE_LETTER_TO_NATIVE_NOMINAL[token];

    var degree = parseInt(token, 10);
    if (!isNaN(degree) && degree >= 1 && degree <= 7 && String(degree) == token)
        return KEY_SIGNATURE_DEGREE_TO_NATIVE_NOMINAL[degree - 1];

    return null;
}

function keySignatureSymbolDeclaration(value) {
    if (Array.isArray(value)) {
        return value.map(function (symbol) {
            return String(symbol);
        }).join('.');
    }

    if (value === undefined || value === null)
        return '';

    return String(value).trim();
}

function keySignatureAccidentalHashFromSymbols(symbols) {
    if (!symbols || symbols.length == 0)
        return null;

    var firstSymbolCode = parseInt(symbols[0], 10);
    var isSingleNaturalOrNone = symbols.length == 1 &&
        !isNaN(firstSymbolCode) && firstSymbolCode <= 2;

    if (isSingleNaturalOrNone)
        return null;

    var accHash = normalizeAccidentalHash(accidentalsHash(symbols));
    return accHash == '' ? null : accHash;
}

function keySignatureDisplaySymbols(symbols) {
    if (!symbols || symbols.length == 0)
        return [];

    var firstSymbolCode = parseInt(symbols[0], 10);
    var isSingleNone = symbols.length == 1 &&
        !isNaN(firstSymbolCode) && firstSymbolCode <= 1;

    return isSingleNone ? [] : symbols;
}

/**
 * Parse the compact JSON format used by the Load Key Signature button.
 *
 * @param {string} text JSON source text
 * @param {TuningConfig} tuningConfig tuning active at the insertion point
 * @returns {{ok:boolean,error:string,name:string,keySig:KeySig,
 *   declarationText:string,entries:Object[]}}
 */
function parseKeySignatureJSON(text, tuningConfig) {
    var result = {
        ok: false,
        error: '',
        name: '',
        keySig: null,
        declarationText: '',
        entries: []
    };

    var parsed;
    try {
        parsed = JSON.parse(text);
    } catch (e) {
        result.error = 'Invalid key signature JSON: ' + e;
        return result;
    }

    if (!parsed || typeof parsed != 'object' || Array.isArray(parsed)) {
        result.error = 'Key signature JSON must contain one object.';
        return result;
    }

    if (String(parsed.ver || '').toLowerCase() != 'ks') {
        result.error = 'The JSON ver field must be "ks".';
        return result;
    }

    if (!tuningConfig || tuningConfig.numNominals != 7) {
        result.error = 'Loaded key signatures currently require a 7-nominal tuning.';
        return result;
    }

    var sequence = keySignatureSequenceTokens(parsed.seq);
    if (sequence.length == 0) {
        result.error = 'The key signature seq field is empty.';
        return result;
    }

    if (!Array.isArray(parsed.sgn) || parsed.sgn.length != sequence.length) {
        result.error = 'The sgn array must have the same number of entries as seq.';
        return result;
    }

    var keySig = [];
    var declarations = [];
    var seenNominals = {};
    for (var nominalIdx = 0; nominalIdx < tuningConfig.numNominals; nominalIdx++) {
        keySig.push(null);
        declarations.push('0');
    }

    for (var i = 0; i < sequence.length; i++) {
        var nativeNominal = keySignatureNativeNominal(sequence[i]);
        if (nativeNominal === null) {
            result.error = 'Invalid seq entry "' + sequence[i] + '". Use scale degrees 1-7 or letters A-G.';
            return result;
        }

        if (seenNominals[nativeNominal]) {
            result.error = 'The seq field contains the same nominal more than once: ' + sequence[i];
            return result;
        }
        seenNominals[nativeNominal] = true;

        var declaration = keySignatureSymbolDeclaration(parsed.sgn[i]);
        if (declaration.length == 0) {
            result.error = 'Empty sgn entry at position ' + (i + 1) + '.';
            return result;
        }

        var symbols = parseSymbolsDeclaration(declaration, true);
        if (symbols == null || symbols.length == 0) {
            result.error = 'Invalid symbol declaration "' + declaration + '" at sgn position ' + (i + 1) + '.';
            return result;
        }

        for (var symbolIdx = 0; symbolIdx < symbols.length; symbolIdx++) {
            var symbolCode = symbols[symbolIdx];
            var numericSymbolCode = parseInt(symbolCode, 10);
            var isNaturalOrNone = !isNaN(numericSymbolCode) && numericSymbolCode <= 2;
            if (!isNaturalOrNone &&
                !tuningConfig.usedSymbols[symbolCode] &&
                !tuningConfig.usedSecondarySymbols[symbolCode]) {
                result.error = 'Symbol "' + symbolCode + '" is not defined by the current tuning.';
                return result;
            }
        }

        var tuningNominal = mod(
            nativeNominal - tuningConfig.tuningNominal,
            tuningConfig.numNominals
        );
        var accidentalHash = keySignatureAccidentalHashFromSymbols(symbols);
        var displaySymbols = keySignatureDisplaySymbols(symbols);

        keySig[tuningNominal] = accidentalHash;
        declarations[tuningNominal] = declaration;
        result.entries.push({
            sequenceToken: sequence[i],
            nativeNominal: nativeNominal,
            tuningNominal: tuningNominal,
            declaration: declaration,
            symbols: displaySymbols
        });
    }

    result.ok = true;
    result.name = parsed.ksn === undefined || parsed.ksn === null ||
        String(parsed.ksn).trim().length == 0 ?
        'Unnamed key signature' : String(parsed.ksn).trim();
    result.keySig = keySig;
    // The exclamation mark is an internal priority marker. It remains hidden
    // in the score and ensures this loaded signature wins over a native or
    // older custom signature at the same tick.
    result.declarationText = 'keysig! ' + declarations.join(' ');
    return result;
}

var NATIVE_KEY_SIG_SHARP_NOMINALS = [5, 2, 6, 3, 0, 4, 1]; // F C G D A E B
var NATIVE_KEY_SIG_FLAT_NOMINALS = [1, 4, 0, 3, 6, 2, 5]; // B E A D G C F

function nativeKeySignatureToKeySig(nativeKeySignature, tuningConfig) {
    var count = parseInt(nativeKeySignature);
    if (isNaN(count) || !tuningConfig || tuningConfig.numNominals != 7) {
        return null;
    }

    if (count > 7)
        count = 7;
    else if (count < -7)
        count = -7;

    var keySig = [];
    for (var i = 0; i < tuningConfig.numNominals; i++) {
        keySig.push(null);
    }

    if (count == 0) {
        return keySig;
    }

    var symCode = count > 0 ? 5 : 6; // MuseScore sharp or flat
    var mappedSymbols = nativeAccidentalSymbolsForTuning(symCode, tuningConfig);
    if (mappedSymbols == null) {
        warnUnmappedNativeAccidental(symCode, tuningConfig);
        return keySig;
    }
    var accHash = accidentalsHash(mappedSymbols);
    var nominalOrder = count > 0 ? NATIVE_KEY_SIG_SHARP_NOMINALS : NATIVE_KEY_SIG_FLAT_NOMINALS;
    var numAccidentals = Math.abs(count);

    for (var i = 0; i < numAccidentals; i++) {
        var nativeNominal = nominalOrder[i];
        var tuningNominal = mod(nativeNominal - tuningConfig.tuningNominal, tuningConfig.numNominals);
        keySig[tuningNominal] = accHash;
    }

    return keySig;
}

function nativeNominalKeySignatureEntriesToKeySig(entries, tuningConfig) {
    if (!entries || !tuningConfig || tuningConfig.numNominals != 7)
        return null;

    var keySig = [];
    for (var i = 0; i < tuningConfig.numNominals; i++)
        keySig.push(null);

    for (var entryIdx = 0; entryIdx < entries.length; entryIdx++) {
        var entry = entries[entryIdx];
        if (!entry || entry.nativeNominal === undefined ||
            entry.nativeNominal === null || !entry.symbols ||
            entry.symbols.length == 0) {
            continue;
        }

        var mappedEntrySymbols = mapNativeAccidentalSymbols(
            accidentalSymbolsFromList(entry.symbols),
            tuningConfig
        );
        var mappedEntryList = accidentalSymbolListFromSymbols(mappedEntrySymbols);
        var accidentalHash = keySignatureAccidentalHashFromSymbols(mappedEntryList);
        var tuningNominal = mod(
            entry.nativeNominal - tuningConfig.tuningNominal,
            tuningConfig.numNominals
        );
        keySig[tuningNominal] = accidentalHash;
    }

    return keySig;
}

function refreshCurrentKeySignature(parms) {
    if (!parms || !parms.currKeySigSource) {
        if (parms)
            parms.currKeySig = null;
        return;
    }

    var source = parms.currKeySigSource;
    if (source.kind == 'native-count') {
        parms.currKeySig = nativeKeySignatureToKeySig(
            source.value,
            parms.currTuning
        );
    } else if (source.kind == 'native-entries') {
        parms.currKeySig = nativeNominalKeySignatureEntriesToKeySig(
            source.value,
            parms.currTuning
        );
    } else {
        parms.currKeySig = source.value;
    }
}

function setCurrentKeySignatureSource(parms, kind, value) {
    parms.currKeySigSource = {
        kind: kind,
        value: value
    };
    refreshCurrentKeySignature(parms);
}

function createNativeKeySigConfigEvent(nativeKeySignature, tick) {
    var count = parseInt(nativeKeySignature);
    if (isNaN(count)) {
        return null;
    }

    return {
        kind: 'native-keysig',
        text: 'native keysig ' + count,
        tick: tick,
        priority: 20,
        config: function (parms) {
            setCurrentKeySignatureSource(parms, 'native-count', count);
        }
    };
}

function cursorNativeKeySignature(cursor) {
    try {
        if (cursor.keySignature === undefined || cursor.keySignature === null) {
            return null;
        }

        var keySignature = parseInt(cursor.keySignature);
        if (isNaN(keySignature)) {
            return null;
        }

        return keySignature;
    } catch (e) {
        return null;
    }
}

function cursorNativeKeySignatureTick(cursor) {
    var fallbackTick = cursor ? cursor.tick : 0;
    try {
        if (cursor.keySignatureTick === undefined || cursor.keySignatureTick === null)
            return { hasValue: false, tick: fallbackTick };

        var tick = parseInt(cursor.keySignatureTick, 10);
        if (isNaN(tick))
            return { hasValue: false, tick: fallbackTick };

        return { hasValue: true, tick: tick };
    } catch (e) {
        return { hasValue: false, tick: fallbackTick };
    }
}

function cursorNativeKeySignatureCustomState(cursor) {
    try {
        if (cursor.keySignatureCustom === undefined || cursor.keySignatureCustom === null)
            return null;

        return cursor.keySignatureCustom === true;
    } catch (e) {
        return null;
    }
}

function cursorNativeKeySignatureStateKey(keySignature, cursor) {
    var key = String(keySignature);
    var customState = cursorNativeKeySignatureCustomState(cursor);
    if (customState !== null)
        key += customState ? '|custom' : '|native';

    var tickState = cursorNativeKeySignatureTick(cursor);
    if (tickState.hasValue)
        key += '|' + tickState.tick;

    return key;
}

function appendNativeKeySigConfigEvent(configs, cursor, state) {
    var keySignature = cursorNativeKeySignature(cursor);
    if (keySignature == null) {
        return;
    }

    var stateKey = cursorNativeKeySignatureStateKey(keySignature, cursor);
    if (state.hasValue && state.lastValue == stateKey) {
        return;
    }

    state.hasValue = true;
    state.lastValue = stateKey;

    var tickState = cursorNativeKeySignatureTick(cursor);
    var event = createNativeKeySigConfigEvent(keySignature, tickState.tick);
    if (event != null) {
        configs.push(event);
    }
}

/**
 * The user can specify just the reference tuning (e.g. `A4: 405`)
 * to update the Tuning Config's reference note & frequency
 * without having to recalculate the whole tuning config.
 * 
 * This saves a lot of loading time for large JI systems with
 * comma shifts implemented as reference tuning changes, or
 * when the user wants to write for transposing instruments.
 * 
 * When only reference tuning is changed, the mode of the nominals
 * will be preserved, unless `!` is prefixed to the change reference
 * tuning declaration. 
 * 
 * E.g.: `!C4: 263` will set the 0th nominal to the midi note C4, whereas 
 * `C4: 263` will keep the 0th nominal as per the tuning config (
 * which is {@link TuningConfig.tuningNominal}), but change the
 * 0th nominal's tuning frequency such that the written C4 on the
 * score will be exactly 263 Hz.
 * 
 * If the reference frequency is not specified (e.g. 'D4:'), 
 * it represents that the reference nominal should change without 
 * changing the tuning.
 * 
 * E.g. If reference is originally A4: 440 and "C4:" is specified,
 * then the relative reference offset will be -5, but the tuning frequency 
 * will remain the same (at A4: 440),
 * 
 * The use case would be when JI ratios are specified as per-note
 * fingering annotations, and the ratios are to be related to a
 * different 1/1 instead of the default.
 * 
 * @param {string} text reference tuning text
 * @returns {ChangeReferenceTuning?}
 */
function parseChangeReferenceTuning(text) {

    var text = text.trim();

    // The change reference tuning should be on 1 line.
    // Otherwise, it should be parsed as a new tuning config.
    if (text.indexOf("\n") != -1)
        return null;

    // PARSE TUNING NOTE.
    //
    //

    var referenceTuning = text.split(':').map(function (x) { return x.trim() });

    if (referenceTuning.length != 2) {
        // log(text + ' is not a reference tuning');
        return null;
    }

    var preserveNominalsMode = true;
    if (referenceTuning[0][0] == '!') {
        referenceTuning[0] = referenceTuning[0].slice(1).trim();
        preserveNominalsMode = false;
    }

    var referenceLetter = referenceTuning[0][0].toLowerCase();
    var referenceOctave = parseInt(referenceTuning[0].slice(1));
    if (isNaN(referenceOctave)) {
        // octave wasn't specified, so we assume it's 4.
        referenceOctave = 4;
    }

    var nominalsFromA4 = (referenceOctave - 4) * 7;
    var lettersNominal = Lookup.LETTERS_TO_NOMINAL[referenceLetter];

    if (lettersNominal == undefined) {
        // log("Invalid reference note specified: " + referenceLetter);
        return null;
    }

    nominalsFromA4 += lettersNominal;

    // Since the written octave resets at C, but we need to convert it
    // such that the octave resets at A4, we need to subtract one octave
    // if the nominal is within C to G.
    if (lettersNominal >= 2)
        nominalsFromA4 -= 7;

    var changeRelativeNominalOnly = referenceTuning[1] == '';
    var changeReferenceNote = {
        preserveNominalsMode: preserveNominalsMode,
        tuningNominal: nominalsFromA4,
        tuningNote: Lookup.LETTERS_TO_SEMITONES[referenceLetter] + (referenceOctave - 4) * 12 + 69,
        tuningFreq: changeRelativeNominalOnly ? null : parseFloat(eval(referenceTuning[1])), // specified in Hz.
        changeRelativeNominalOnly: changeRelativeNominalOnly
    };

    if (isNaN(changeReferenceNote.tuningFreq) && !changeRelativeNominalOnly) {
        return null;
    }

    return changeReferenceNote;
}

/**
 * Removes HTML/XML formatting code from text and decodes HTML escape sequences.
 * 
 * Make sure formatting code is removed before parsing System/Staff/Fingering text!
 * 
 * @param {string} str Raw System/Staff text contents
 * @returns {string} Text with formatting code removed
 */
function removeFormattingCode(str) {
    if (typeof (str) == 'string')
        return _decodeHTMLEscape(str.replace(/<[^>]*>/g, ''));
    else
        return null;
}

/**
 * Use this when writing to the {@link PluginAPIElement.text} property.
 * 
 * Characters <, >, &, " are escaped to their HTML escape sequences.
 * 
 * @param {string} str String to escape
 * @returns {string} Escaped string
 */
function escapeHTML(str) {
    var str = str.replace(/&/g, '&amp;');
    str = str.replace(/</g, '&lt;');
    str = str.replace(/>/g, '&gt;');
    str = str.replace(/"/g, '&quot;');
    return str;
}

/**
 * Decodes html espace sequences.
 * 
 * **DO NOT USE DIRECTLY**. Use `removeFormattingCode()` instead!
 * 
 * Text in musescore is HTML Encoded (since it is represented in XML).
 * 
 * @param {string} str String containing html escape sequences
 */
function _decodeHTMLEscape(str) {
    var str = str.replace(/&amp;/g, '&');
    str = str.replace(/&lt;/g, '<');
    str = str.replace(/&gt;/g, '>');
    str = str.replace(/&quot;/g, '"');

    return str;
}

/**
 * Parses a System/Staff Text contents to check if it represents any config.
 * 
 * If a config is found, returns a `ConfigUpdateEvent` object to be added to
 * the `parms.staffConfigs[]` list.
 * 
 * `ConfigUpdateEvent`s can modify the parms object.
 * 
 * @param {string} text System/Staff Text contents
 * @param {number} tick Current tick position
 * @returns {ConfigUpdateEvent?} 
 *  The `ConfigUpdateEvent` to add to `staffConfigs[]`, or `null` if invalid/not a config
 * 
 */
function parsePossibleConfigs(text, tick) {
    if (tick === undefined || tick === null) {
        console.error('FATAL ERROR: parsePossibleConfigs() missing tick parameter!');
        return null;
    }

    var text = removeFormattingCode(text);


    /** @type {ChangeReferenceTuning|TuningConfig|KeySig|null} */
    var maybeConfig;

    // First, check for reference tuning changes.

    maybeConfig = parseChangeReferenceTuning(text);

    if (maybeConfig != null) {
        log("Found reference tuning change:\n" + text);
        // reference tuning change found.

        return { // ConfigUpdateEvent
            kind: 'reference',
            text: text,
            tick: tick,
            priority: 10,
            config: function (parms) {
                if (!maybeConfig.preserveNominalsMode && !maybeConfig.changeRelativeNominalOnly) {
                    // Changes mode of the nominals.
                    // When the user declares "!C4: 440", the nominals will start
                    // from C4 instead of whatever it was.

                    parms.currTuning.tuningNominal = maybeConfig.tuningNominal;
                    parms.currTuning.relativeTuningNominal = 0;
                    parms.currTuning.tuningNote = maybeConfig.tuningNote;
                    parms.currTuning.tuningFreq = maybeConfig.tuningFreq;
                    parms.currTuning.originalTuningFreq = maybeConfig.tuningFreq;
                } else if (!maybeConfig.changeRelativeNominalOnly) {
                    // We need to preserve the tuning nominal & tuning note, but change
                    // the tuning frequency so that the declared reference note is
                    // effectively correct.
                    //
                    // This prevents the nominals mode from going out of sync, unless
                    // explicitly wanted by the user.

                    /*
                    Method:

                    1. Calculate actual Hz of the new reference nominal using the original reference tuning.
                    2. Calculate interval between the above frequency and the actual frequency the user specified.
                    3. Apply that interval to currTuning.originalTuningFreq to get the new tuning frequency.
                    */

                    var nominalsFromReference = maybeConfig.tuningNominal - parms.currTuning.tuningNominal;
                    parms.currTuning.relativeTuningNominal = nominalsFromReference;
                    var xenNominal = mod(nominalsFromReference, parms.currTuning.numNominals);
                    var equaves = Math.floor(nominalsFromReference / parms.currTuning.numNominals);
                    var oldCentsFromReference = parms.currTuning.nominals[xenNominal] + equaves * parms.currTuning.equaveSize;
                    var oldHz = parms.currTuning.originalTuningFreq * Math.pow(2, oldCentsFromReference / 1200);
                    var newHz = maybeConfig.tuningFreq;

                    // log('oldHz: ' + oldHz, 'newHz: ' + newHz, 'oldCentsFromReference: ' + oldCentsFromReference);

                    parms.currTuning.tuningFreq = newHz / oldHz * parms.currTuning.originalTuningFreq;
                } else {
                    parms.currTuning.relativeTuningNominal = maybeConfig.tuningNominal - parms.currTuning.tuningNominal;
                }

                refreshCurrentKeySignature(parms);
            }
        };
    }

    // Then, check for Tuning Config declarations.

    maybeConfig = parseTuningConfig(text);

    if (maybeConfig != null) {
        var numSteps = maybeConfig.stepsList.length;
        log("Found tuning config:\n" + text + "\n" + numSteps + " notes/equave");
        // tuning config found.

        return { // ConfigUpdateEvent
            kind: 'tuning',
            text: text,
            tuningConfig: maybeConfig,
            eventTick: tick,
            priority: 0,
            // Spoofing 1 tick earlier, because any TuningConfigs should
            // should be applied before a ChangeReferenceTuning event.
            // 
            // This way, a System Text TuningConfig can be used to apply to
            // all staves, while individual staves can use ChangeReferenceTuning
            // to emulate transposing instruments.
            tick: tick - 1,
            config: function (parms) {
                parms.currTuning = maybeConfig;
                refreshCurrentKeySignature(parms);
            }
        };
    }

    maybeConfig = parseKeySig(text);

    if (maybeConfig != null) {
        // key sig found
        log("Found key sig:\n" + text);

        return { // ConfigUpdateEvent
            kind: 'keysig',
            text: text,
            tick: tick,
            priority: text.trim().match(/^keysig!(?:\s|$)/i) ? 40 : 30,
            config: function (parms) {
                setCurrentKeySignatureSource(parms, 'static', maybeConfig);
            }
        }
    }

    return null;
}

/**
 * At the start of each voice, call this to reset parms to default.
 * 
 * @param {Parms} parms Parms object.
 */
function resetParms(parms) {
    parms.currTuning = generateDefaultTuningConfig();
    parms.currKeySig = null;
    parms.currKeySigSource = null;
}
