#!/usr/bin/env python3
"""Integration tests for the QML export helper's three-output job."""

import shutil
import struct
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
PLUGIN_DIR = REPOSITORY_ROOT / "Xen Tuner"


def _vlq(value):
    encoded = [value & 0x7F]
    value >>= 7
    while value:
        encoded.insert(0, (value & 0x7F) | 0x80)
        value >>= 7
    return bytes(encoded)


def _chunk(chunk_type, payload):
    return chunk_type + struct.pack(">I", len(payload)) + payload


def _native_midi_fixture():
    track = bytearray(b"\x00\xc0\x08\x00\x90\x3c\x60")
    track.extend(_vlq(240) + b"\x80\x3c\x00")
    track.extend(b"\x00\xff\x2f\x00")
    return _chunk(b"MThd", struct.pack(">HHH", 0, 1, 480)) + _chunk(
        b"MTrk", bytes(track)
    )


class MidxWriterIntegrationTest(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tempdir.cleanup)
        self.directory = Path(self.tempdir.name)
        self.plugin_directory = self.directory / "plugin"
        self.plugin_directory.mkdir()
        for filename in ("midx_python_writer.py", "midx_pitch_bend_converter.py"):
            shutil.copy2(PLUGIN_DIR / filename, self.plugin_directory / filename)

    def _run_job(
        self,
        bend_range="2.0",
        seed_outputs=False,
        missing_completion_directory=False,
    ):
        score_directory = self.directory / "\u4e50\u8c31"
        score_directory.mkdir()
        native_path = score_directory / "\u8f93\u5165.native.mid"
        offset_path = score_directory / "\u8f93\u5165.offsets.csv"
        midx_path = score_directory / "\u8f93\u51fa.midx"
        midi2_path = score_directory / "\u8f93\u51fa.midi2"
        pitch_bend_path = score_directory / "\u8f93\u51fa.pitch-bend.mid"
        if missing_completion_directory:
            completion_path = score_directory / "missing" / "\u8f93\u51fa.complete"
        else:
            completion_path = score_directory / "\u8f93\u51fa.complete"
        debug_path = score_directory / "\u8f93\u51fa.debug.log"
        native_path.write_bytes(_native_midi_fixture())
        offset_path.write_text("0,0,60,8192\n", encoding="utf-8")

        old_contents = {}
        if seed_outputs:
            for path, value in (
                (midx_path, b"old midx"),
                (midi2_path, b"old midi2"),
                (pitch_bend_path, b"old pitch bend"),
            ):
                path.write_bytes(value)
                old_contents[path] = value

        job_lines = [
            "native_midi_path=%s" % native_path,
            "offset_path=%s" % offset_path,
            "output_path=%s" % midx_path,
            "midi2_output_path=%s" % midi2_path,
            "pitch_bend_output_path=%s" % pitch_bend_path,
            "pitch_bend_range_semitones=%s" % bend_range,
            "completion_path=%s" % completion_path,
            "ticks_per_quarter=480",
            "debug_path=%s" % debug_path,
        ]
        (self.plugin_directory / "midx_writer_job.txt").write_text(
            "\n".join(job_lines) + "\n", encoding="utf-8"
        )
        result = subprocess.run(
            [sys.executable, str(self.plugin_directory / "midx_python_writer.py")],
            cwd=str(self.directory),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        return result, (midx_path, midi2_path, pitch_bend_path, completion_path), old_contents

    def test_job_writes_midx_midi2_pitch_bend_and_completion_marker(self):
        result, paths, _old_contents = self._run_job()
        midx_path, midi2_path, pitch_bend_path, completion_path = paths

        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertTrue(midx_path.read_bytes().startswith(b"MThd"))
        self.assertTrue(midi2_path.read_bytes().startswith(b"SMF2CLIP"))
        self.assertTrue(pitch_bend_path.read_bytes().startswith(b"MThd"))
        completion = completion_path.read_text(encoding="utf-8")
        self.assertIn("status=ok\n", completion)
        self.assertIn("pitch_bend_notes=1\n", completion)
        self.assertIn("pitch_bend_channel_steals=0\n", completion)
        self.assertFalse(list(self.directory.rglob("*.xen-tuner.backup.*")))

    def test_failed_pitch_bend_stage_preserves_previous_outputs(self):
        result, paths, old_contents = self._run_job(bend_range="0", seed_outputs=True)
        _midx_path, _midi2_path, _pitch_bend_path, completion_path = paths

        self.assertEqual(result.returncode, 1)
        self.assertFalse(completion_path.exists())
        for path, expected in old_contents.items():
            self.assertEqual(path.read_bytes(), expected)
        self.assertFalse(list(self.directory.rglob("*.xen-tuner.tmp")))

    def test_completion_marker_failure_rolls_back_all_outputs(self):
        result, _paths, old_contents = self._run_job(
            seed_outputs=True,
            missing_completion_directory=True,
        )

        self.assertEqual(result.returncode, 1)
        for path, expected in old_contents.items():
            self.assertEqual(path.read_bytes(), expected)
        self.assertFalse(list(self.directory.rglob("*.xen-tuner.tmp")))
        self.assertFalse(list(self.directory.rglob("*.xen-tuner.backup.*")))
