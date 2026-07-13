import MuseScore 3.0
import QtQuick 2.9
import QtQuick.Controls 2.2
import QtQuick.Layouts 1.2

MuseScore {
    id: pluginId
    version: "0.3.5"
    pluginType: "dock"
    dockArea: "left"
    description: "Standalone step calculator for Xen Tuner."
    menuPath: "Plugins.Xen Tuner.Calc Steps"
    implicitHeight: 300
    implicitWidth: defaultWindowWidth

    readonly property var suffixPrimes: [
        2, 3, 5, 7, 11, 13, 17, 19, 23,
        29, 31, 37, 41, 43, 47, 53, 59, 61,
        67, 71, 73, 79, 83, 89, 97, 101
    ]
    readonly property double log2Base: Math.log(2)
    readonly property int defaultWindowWidth: 300
    readonly property int windowMargin: 14
    readonly property int buttonWidth: 80
    readonly property int controlHeight: 28
    readonly property int controlGap: 10

    ColumnLayout {
        spacing: controlGap
        anchors.fill: parent
        anchors.margins: windowMargin

        Text {
            id: resultLabel
            text: "Ready."
            font.pointSize: 9
            color: "#2C3E50"
            Layout.fillWidth: true
            Layout.fillHeight: true
            wrapMode: Text.Wrap
            verticalAlignment: Text.AlignTop
        }

        TextField {
            id: intervalInput
            Layout.fillWidth: true
            Layout.preferredHeight: controlHeight
            font.pointSize: 9
            placeholderText: "64/63"
            text: "64/63"
            color: "#2C3E50"
            padding: 6
            selectByMouse: true
            activeFocusOnPress: true

            background: Rectangle {
                radius: 6
                border.color: "#BDC3C7"
                border.width: 1
                color: "#FFFFFF"
            }
        }

        TextField {
            id: edoInput
            Layout.fillWidth: true
            Layout.preferredHeight: controlHeight
            font.pointSize: 9
            placeholderText: "7, 31a, 36a[+5]"
            text: "7"
            color: "#2C3E50"
            padding: 6
            selectByMouse: true
            activeFocusOnPress: true

            background: Rectangle {
                radius: 6
                border.color: "#BDC3C7"
                border.width: 1
                color: "#FFFFFF"
            }
        }

        RowLayout {
            spacing: controlGap
            Layout.fillWidth: true
            Layout.preferredHeight: controlHeight

            Button {
                text: "Calc"
                Layout.preferredWidth: buttonWidth
                Layout.preferredHeight: controlHeight
                font.pointSize: 9
                onClicked: calculateResult()
                background: Rectangle {
                    radius: 6
                    color: parent.pressed ? "#3498DB" : "#2980B9"
                }
                contentItem: Text {
                    text: parent.text
                    color: "white"
                    font.pointSize: 9
                    horizontalAlignment: Text.AlignHCenter
                    verticalAlignment: Text.AlignVCenter
                }
            }

            Item {
                Layout.fillWidth: true
            }

            Button {
                text: "Clear"
                Layout.preferredWidth: buttonWidth
                Layout.preferredHeight: controlHeight
                font.pointSize: 9
                onClicked: {
                    resultLabel.text = "";
                    resultLabel.color = "#2C3E50";
                }
                background: Rectangle {
                    radius: 6
                    color: parent.pressed ? "#95A5A6" : "#7F8C8D"
                }
                contentItem: Text {
                    text: parent.text
                    color: "white"
                    font.pointSize: 9
                    horizontalAlignment: Text.AlignHCenter
                    verticalAlignment: Text.AlignVCenter
                }
            }
        }

        RowLayout {
            spacing: controlGap
            Layout.fillWidth: true
            Layout.preferredHeight: controlHeight

            Button {
                text: "Quit"
                Layout.preferredWidth: buttonWidth
                Layout.preferredHeight: controlHeight
                font.pointSize: 9
                onClicked: Qt.quit()
                background: Rectangle {
                    radius: 6
                    color: parent.pressed ? "#E74C3C" : "#C0392B"
                }
                contentItem: Text {
                    text: parent.text
                    color: "white"
                    font.pointSize: 9
                    horizontalAlignment: Text.AlignHCenter
                    verticalAlignment: Text.AlignVCenter
                }
            }

            Item {
                Layout.fillWidth: true
            }
        }
    }

    function calculateResult() {
        try {
            var fraction = parsePositiveFraction(intervalInput.text.trim());
            var edoConfig = parseEdoConfig(edoInput.text.trim().toLowerCase());
            var numerator = fraction[0];
            var denominator = fraction[1];
            var edo = edoConfig[0];
            var letterSuffix = edoConfig[1];
            var primeOffset = edoConfig[2];

            var gcdVal = gcd(numerator, denominator);
            numerator = numerator / gcdVal;
            denominator = denominator / gcdVal;

            var primeFactors = primeFactorsInt(numerator);
            var denominatorFactors = primeFactorsInt(denominator);
            var key;
            for (key in denominatorFactors) {
                if (denominatorFactors.hasOwnProperty(key)) {
                    primeFactors[key] = (primeFactors[key] || 0) - denominatorFactors[key];
                    if (primeFactors[key] == 0) {
                        delete primeFactors[key];
                    }
                }
            }

            var primes = [];
            for (key in primeFactors) {
                if (primeFactors.hasOwnProperty(key)) {
                    primes.push(parseInt(key, 10));
                }
            }
            primes.sort(function(a, b) { return a - b; });

            var replaceSecondRound = {};
            for (var l = 0; l < letterSuffix.length; l++) {
                var prime = suffixPrime(letterSuffix.charAt(l));
                if (prime) {
                    replaceSecondRound[prime] = true;
                }
            }

            var aArray = [];
            var bArray = [];
            var result = 0;
            for (var i = 0; i < primes.length; i++) {
                var currPrime = primes[i];
                var exponent = primeFactors[currPrime];
                var logVal = edo * Math.log(currPrime) / log2Base;
                var steps = Math.round(logVal);

                if (replaceSecondRound[currPrime]) {
                    steps = logVal - steps >= 0 ? steps - 1 : steps + 1;
                }
                if (primeOffset[currPrime]) {
                    steps += primeOffset[currPrime];
                }

                aArray.push(exponent);
                bArray.push(steps);
                result += exponent * steps;
            }

            resultLabel.text =
                "S: " + result +
                "\nprime factors: " + JSON.stringify(primeFactors) +
                "\nprimes: " + JSON.stringify(primes) +
                "\na: " + JSON.stringify(aArray) +
                "\nb: " + JSON.stringify(bArray) +
                "\nsecond nearest: " + JSON.stringify(objectKeys(replaceSecondRound)) +
                "\noffsets: " + JSON.stringify(primeOffset);
            resultLabel.color = "#27AE60";
        } catch (e) {
            resultLabel.text = "Error: " + e.message;
            resultLabel.color = "#E74C3C";
        }
    }

    function parsePositiveFraction(text) {
        var parts = text.split("/");
        if (parts.length > 2 || parts[0] == "") {
            throw new Error("interval must be a positive integer or fraction");
        }

        var numerator = parseInt(parts[0], 10);
        var denominator = parts.length == 2 ? parseInt(parts[1], 10) : 1;
        if (isNaN(numerator) || isNaN(denominator)) {
            throw new Error("fraction values must be integers");
        }
        if (numerator <= 0 || denominator <= 0) {
            throw new Error("fraction values must be positive");
        }
        return [numerator, denominator];
    }

    function parseEdoConfig(text) {
        var match = text.match(/^(\d+)([a-z]*)(\[[+-]+\d+(?:,[+-]+\d+)*\])?$/);
        if (!match) {
            throw new Error("edo format: 31, 24bc, 36a[+5,-7,++11]");
        }

        var edo = parseInt(match[1], 10);
        if (isNaN(edo) || edo <= 0) {
            throw new Error("edo must be a positive integer");
        }

        return [edo, match[2] || "", parsePrimeOffsets(match[3] || "")];
    }

    function parsePrimeOffsets(offsetBracket) {
        var offsets = {};
        if (!offsetBracket) {
            return offsets;
        }

        var items = offsetBracket.slice(1, -1).split(",");
        for (var i = 0; i < items.length; i++) {
            var match = items[i].match(/^([+-]+)(\d+)$/);
            if (!match) {
                continue;
            }

            var targetPrime = parseInt(match[2], 10);
            if (isNaN(targetPrime) || targetPrime < 2) {
                continue;
            }

            var signs = match[1];
            var delta = 0;
            for (var s = 0; s < signs.length; s++) {
                delta += signs.charAt(s) == "+" ? 1 : -1;
            }
            offsets[targetPrime] = (offsets[targetPrime] || 0) + delta;
        }
        return offsets;
    }

    function suffixPrime(ch) {
        var idx = ch.charCodeAt(0) - 97;
        return idx >= 0 && idx < suffixPrimes.length ? suffixPrimes[idx] : null;
    }

    function primeFactorsInt(n) {
        var factors = {};
        while (n % 2 == 0) {
            factors[2] = (factors[2] || 0) + 1;
            n = n / 2;
        }
        for (var i = 3; i * i <= n; i += 2) {
            while (n % i == 0) {
                factors[i] = (factors[i] || 0) + 1;
                n = n / i;
            }
        }
        if (n > 1) {
            factors[n] = (factors[n] || 0) + 1;
        }
        return factors;
    }

    function gcd(a, b) {
        while (b) {
            var tmp = a % b;
            a = b;
            b = tmp;
        }
        return a;
    }

    function objectKeys(obj) {
        var keys = [];
        for (var key in obj) {
            if (obj.hasOwnProperty(key)) {
                keys.push(key);
            }
        }
        return keys;
    }
}
