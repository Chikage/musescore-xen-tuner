import QtQuick 2.9
import QtQuick.Controls 2.2
import QtTest 1.2

TestCase {
    name: "EditableComboDefaults"

    Component {
        id: comboComponent

        ComboBox {
            model: ["0", "1", "2"]
            currentIndex: -1
            editable: true
            Component.onCompleted: editText = "1"
        }
    }

    function test_defaultAndEditableText() {
        var combo = createTemporaryObject(comboComponent, this);
        verify(combo !== null);
        tryCompare(combo, "editText", "1");
        combo.editText = "2";
        compare(combo.editText, "2");
    }
}
