// Copyright (C) 2023 euwbah
// 
// This file is part of Xen Tuner.
// 
// Xen Tuner is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
// 
// Xen Tuner is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU General Public License for more details.
// 
// You should have received a copy of the GNU General Public License
// along with Xen Tuner.  If not, see <http://www.gnu.org/licenses/>.

// MUST USE ES5 SYNTAX FOR MSCORE COMPAT.
//
// fns.js is the compatibility entry point. MuseScore/QML loads this file via
// Qt.include(), while index.html loads it as a browser script for the tuning
// config generator. Keep public functions global so existing Fns.* calls work.

var FNS_MODULE_PATHS = [
    "./modules/00-runtime.js",
    "./modules/01-lifecycle-cache.js",
    "./modules/02-symbols-and-notes.js",
    "./modules/03-config-parser.js",
    "./modules/04-note-tuning.js",
    "./modules/05-score-navigation.js",
    "./modules/06-note-editing.js",
    "./modules/07-layout-display.js",
    "./modules/08-operations.js"
];

function includeFnsModule(path) {
    if (typeof Qt !== "undefined" && Qt.include) {
        var includeStatus = Qt.include(path);
        if (typeof DEBUG_IMPORTS !== "undefined" && DEBUG_IMPORTS) {
            console.log("Import " + path + " " + includeStatus.status);
        }
        return includeStatus;
    }

    if (typeof XMLHttpRequest !== "undefined" && typeof document !== "undefined") {
        var currentScript = document.currentScript;
        if (!currentScript) {
            var scripts = document.getElementsByTagName("script");
            currentScript = scripts[scripts.length - 1];
        }

        var basePath = "";
        if (currentScript && currentScript.src) {
            basePath = currentScript.src.slice(0, currentScript.src.lastIndexOf("/") + 1);
        }

        var request = new XMLHttpRequest();
        request.open("GET", basePath + path, false);
        request.send(null);

        if (request.status == 0 || (request.status >= 200 && request.status < 300)) {
            (0, eval)(request.responseText + "\n//# sourceURL=" + basePath + path);
        } else if (typeof console !== "undefined") {
            console.error("Cannot include Xen Tuner module: " + path);
        }
        return null;
    }

    if (typeof console !== "undefined") {
        console.error("Cannot include Xen Tuner module without Qt.include or document: " + path);
    }
    return null;
}

for (var fnsModuleIdx = 0; fnsModuleIdx < FNS_MODULE_PATHS.length; fnsModuleIdx++) {
    includeFnsModule(FNS_MODULE_PATHS[fnsModuleIdx]);
}
