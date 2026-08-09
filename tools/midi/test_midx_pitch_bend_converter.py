#!/usr/bin/env python3
"""Tests for converting Xen Tuner MIDX and MIDI 2.0 clips to MIDI 1.0."""

import importlib.util
import struct
import tempfile
import unittest
from pathlib import Path


REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
CONVERTER_PATH = REPOSITORY_ROOT / "Xen Tuner" / "midx_pitch_bend_converter.py"


def _load_converter():
    spec = importlib.util.spec_from_file_location("midx_pitch_bend_converter", CONVERTER_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


CONVERTER = _load_converter()


def _vlq(value):
    encoded = [value & 0x7F]
    value >>= 7
    while value:
        encoded.insert(0, (value & 0x7F) | 0x80)
        value >>= 7
    return bytes(encoded)


def _chunk(chunk_type, payload):
    return chunk_type + struct.pack(">I", len(payload)) + payload


def _midx_offset_event(delta, pitch, cents):
    magnitude = round(abs(cents) * 32768.0 / 64.0)
    offset_word = min(magnitude, 0x7FFF) | (0x8000 if cents < 0 else 0)
    payload = b"\x7dXT\x03" + bytes([pitch]) + struct.pack(">H", offset_word)
    return _vlq(delta) + b"\xff\x7f" + _vlq(len(payload)) + payload


def _make_midx_fixture():
    track = bytearray()
    track.extend(_midx_offset_event(0, 60, 32.0))
    track.extend(b"\x00\x90\x3c\x60")
    track.extend(_midx_offset_event(0, 64, -16.0))
    track.extend(b"\x00\x90\x40\x50")
    track.extend(_vlq(240) + b"\x80\x3c\x00")
    track.extend(b"\x00\x80\x40\x00")
    track.extend(b"\x00\xff\x2f\x00")
    header = _chunk(b"MThd", struct.pack(">HHH", 0, 1, 480))
    return header + _chunk(b"MTrk", bytes(track))


def _make_empty_midx_fixture():
    header = _chunk(b"MThd", struct.pack(">HHH", 0, 1, 480))
    return header + _chunk(b"MTrk", b"\x00\xff\x2f\x00")


def _make_percussion_fixture():
    track = bytearray()
    track.extend(_midx_offset_event(0, 37, -20.0))
    track.extend(b"\x00\x99\x24\x60")
    track.extend(_vlq(120) + b"\x89\x24\x00")
    track.extend(b"\x00\xff\x2f\x00")
    header = _chunk(b"MThd", struct.pack(">HHH", 0, 1, 480))
    return header + _chunk(b"MTrk", bytes(track))


def _make_channel_overflow_fixture():
    track = bytearray()
    for index in range(16):
        pitch = 40 + index
        track.extend(_midx_offset_event(0, pitch, -60.0 + index * 8.0))
        track.extend(bytes([0, 0x90, pitch, 80]))
    for index in range(16):
        pitch = 40 + index
        track.extend(_vlq(240 if index == 0 else 0) + bytes([0x80, pitch, 0]))
    track.extend(b"\x00\xff\x2f\x00")
    header = _chunk(b"MThd", struct.pack(">HHH", 0, 1, 480))
    return header + _chunk(b"MTrk", bytes(track))


def _ump32(word):
    return struct.pack(">I", word)


def _ump64(word1, word2):
    return struct.pack(">II", word1, word2)


def _ump128(word1, word2=0, word3=0, word4=0):
    return struct.pack(">IIII", word1, word2, word3, word4)


def _midi2_note(status, source_pitch, velocity16, attribute_type=0, attribute=0):
    word1 = (0x4 << 28) | ((status & 0xFF) << 16) | (source_pitch << 8) | attribute_type
    word2 = ((velocity16 & 0xFFFF) << 16) | (attribute & 0xFFFF)
    return _ump64(word1, word2)


def _make_midi2_fixture():
    attribute_pitch = round(61.5 * 512.0)
    packets = [
        _ump32(0x00400000),
        _ump32(0x00300000 | 960),
        _ump32(0x00400000),
        _ump128(0xF0200000),
        _ump32(0x00400000),
        _midi2_note(0x90, 60, 0xFFFF, 0x03, attribute_pitch),
        _ump32(0x00400000 | 240),
        _midi2_note(0x80, 60, 0),
        _ump32(0x00400000),
        _ump128(0xF0210000),
    ]
    return b"SMF2CLIP" + b"".join(packets)


def _read_vlq(data, offset):
    value = 0
    while True:
        byte = data[offset]
        offset += 1
        value = (value << 7) | (byte & 0x7F)
        if byte < 0x80:
            return value, offset


def _parse_smf(path):
    data = Path(path).read_bytes()
    if data[:4] != b"MThd":
        raise AssertionError("converted output is not a Standard MIDI File")
    header_length = struct.unpack(">I", data[4:8])[0]
    midi_format, track_count, division = struct.unpack(">HHH", data[8:14])
    offset = 8 + header_length
    tracks = []

    while offset < len(data):
        chunk_type = data[offset:offset + 4]
        chunk_length = struct.unpack(">I", data[offset + 4:offset + 8])[0]
        payload = data[offset + 8:offset + 8 + chunk_length]
        offset += 8 + chunk_length
        if chunk_type != b"MTrk":
            continue

        events = []
        index = 0
        tick = 0
        running_status = None
        while index < len(payload):
            delta, index = _read_vlq(payload, index)
            tick += delta
            status_or_data = payload[index]
            index += 1

            if status_or_data == 0xFF:
                meta_type = payload[index]
                index += 1
                length, index = _read_vlq(payload, index)
                meta_data = payload[index:index + length]
                index += length
                events.append((tick, 0xFF, bytes([meta_type]) + meta_data))
                running_status = None
                continue

            if status_or_data in (0xF0, 0xF7):
                length, index = _read_vlq(payload, index)
                index += length
                running_status = None
                continue

            if status_or_data & 0x80:
                status = status_or_data
                running_status = status
                first_data = None
            else:
                if running_status is None:
                    raise AssertionError("invalid running status in converted output")
                status = running_status
                first_data = status_or_data

            data_length = 1 if status & 0xF0 in (0xC0, 0xD0) else 2
            event_data = bytearray()
            if first_data is not None:
                event_data.append(first_data)
            missing = data_length - len(event_data)
            event_data.extend(payload[index:index + missing])
            index += missing
            events.append((tick, status, bytes(event_data)))
        tracks.append(events)

    if len(tracks) != track_count:
        raise AssertionError("SMF track count does not match its header")
    return midi_format, division, [event for track in tracks for event in track]


def _pitch_bend_value(event):
    return event[2][0] | (event[2][1] << 7)


class PitchBendConverterTest(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tempdir.cleanup)
        self.directory = Path(self.tempdir.name)

    def _convert(self, filename, fixture, bend_range=2.0):
        input_path = self.directory / filename
        output_path = self.directory / (filename + ".mid")
        input_path.write_bytes(fixture)
        stats = CONVERTER.convert_file(str(input_path), str(output_path), bend_range)
        midi_format, division, events = _parse_smf(output_path)
        self.assertEqual(midi_format, 1)
        return stats, division, events

    def assertRpnBendRange(self, events, channels, semitones, cents):
        expected = [(101, 0), (100, 0), (6, semitones), (38, cents), (101, 127), (100, 127)]
        for channel in channels:
            controls = [
                (data[0], data[1])
                for tick, status, data in events
                if tick == 0
                and status == 0xB0 | channel
                and data[0] in (101, 100, 6, 38)
            ]
            self.assertEqual(controls, expected, "incorrect pitch-bend RPN on channel %d" % channel)

    def test_midx_offsets_emit_bends_and_split_concurrent_notes(self):
        stats, division, events = self._convert("concurrent.midx", _make_midx_fixture())

        self.assertEqual(stats["input_format"], "MIDX")
        self.assertEqual(stats["notes"], 2)
        self.assertEqual(stats["channels_used"], 2)
        self.assertEqual(division, 480)

        note_ons = [
            event
            for event in events
            if event[1] & 0xF0 == 0x90 and event[2][1] > 0
        ]
        self.assertEqual({event[2][0] for event in note_ons}, {60, 64})
        note_channels = {event[2][0]: event[1] & 0x0F for event in note_ons}
        self.assertNotEqual(note_channels[60], note_channels[64])

        note_offs = [event for event in events if event[1] & 0xF0 == 0x80]
        self.assertEqual(
            {event[2][0]: event[1] & 0x0F for event in note_offs},
            note_channels,
        )

        non_center_bends = {
            event[1] & 0x0F: _pitch_bend_value(event)
            for event in events
            if event[1] & 0xF0 == 0xE0 and _pitch_bend_value(event) != 8192
        }
        self.assertGreater(non_center_bends[note_channels[60]], 8192)
        self.assertLess(non_center_bends[note_channels[64]], 8192)
        self.assertRpnBendRange(events, note_channels.values(), 2, 0)

    def test_midi2_note_pitch_attribute_emits_adjusted_note_and_bend(self):
        stats, division, events = self._convert(
            "attribute.midi2", _make_midi2_fixture(), bend_range=2.5
        )

        self.assertEqual(stats["input_format"], "MIDI2")
        self.assertEqual(stats["notes"], 1)
        self.assertEqual(division, 960)

        note_ons = [
            event
            for event in events
            if event[1] & 0xF0 == 0x90 and event[2][1] > 0
        ]
        self.assertEqual(len(note_ons), 1)
        note_on = note_ons[0]
        channel = note_on[1] & 0x0F
        self.assertEqual(note_on[2][0], 61)

        note_offs = [event for event in events if event[1] & 0xF0 == 0x80]
        self.assertEqual([(event[1] & 0x0F, event[2][0]) for event in note_offs], [(channel, 61)])

        bends = [
            _pitch_bend_value(event)
            for event in events
            if event[1] == 0xE0 | channel and _pitch_bend_value(event) != 8192
        ]
        self.assertEqual(bends, [9830])
        self.assertRpnBendRange(events, [channel], 2, 50)

    def test_empty_midx_writes_valid_empty_pitch_bend_midi(self):
        stats, division, events = self._convert("empty.midx", _make_empty_midx_fixture())

        self.assertEqual(stats["notes"], 0)
        self.assertEqual(stats["channels_used"], 0)
        self.assertEqual(division, 480)
        self.assertFalse(any(status & 0xF0 in (0x80, 0x90) for _tick, status, _data in events))

    def test_gm_percussion_stays_on_channel_ten_without_pitch_bend(self):
        stats, _division, events = self._convert("drums.midx", _make_percussion_fixture())

        self.assertEqual(stats["percussion_notes"], 1)
        self.assertEqual(stats["percussion_offsets_ignored"], 1)
        note_ons = [event for event in events if event[1] == 0x99 and event[2][1] > 0]
        note_offs = [event for event in events if event[1] == 0x89]
        self.assertEqual([(event[2][0], event[2][1]) for event in note_ons], [(36, 96)])
        self.assertEqual([event[2][0] for event in note_offs], [36])
        self.assertFalse(any(status == 0xE9 for _tick, status, _data in events))

    def test_same_tick_channel_overflow_drops_stolen_note_before_writing_it(self):
        stats, _division, events = self._convert(
            "overflow.midx", _make_channel_overflow_fixture()
        )

        self.assertEqual(stats["notes"], 16)
        self.assertEqual(stats["channel_steals"], 1)
        note_ons = [
            event for event in events if event[1] & 0xF0 == 0x90 and event[2][1] > 0
        ]
        self.assertEqual(len(note_ons), 15)
        self.assertFalse(
            any(tick == 0 and status & 0xF0 == 0x80 for tick, status, _data in events)
        )


if __name__ == "__main__":
    unittest.main()
