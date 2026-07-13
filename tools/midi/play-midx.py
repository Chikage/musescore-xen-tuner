#!/usr/bin/env python3
# Copyright (C) 2026
#
# Terminal MIDX player/debugger. It parses the MIDX Standard MIDI File superset
# exported by Xen Tuner, renders microtonal pitches to audio, and mirrors the
# rendered note data back to the terminal in real time.

from __future__ import annotations

import argparse
import bisect
import base64
import heapq
import math
import os
import re
import shutil
import struct
import subprocess
import sys
import tempfile
import threading
import time
import wave
from dataclasses import dataclass
from typing import Dict, Iterable, List, Optional, Tuple


MIDX_META_TYPE = 0x7F
MIDX_PITCHED_OFFSET_PAYLOAD_LEN = 7
MIDX_EXPERIMENTAL_MANUFACTURER_ID = 0x7D
MIDX_NAMESPACE = b"XT"
MIDX_PITCHED_OFFSET_RECORD_TYPE = 0x03
MIDI2_CLIP_HEADER = b"SMF2CLIP"
MIDI2_DEFAULT_TICKS_PER_QUARTER = 480
DEFAULT_TEMPO_US_PER_QUARTER = 500000
DEFAULT_SAMPLE_RATE = 44100
DEFAULT_TAIL_SECONDS = 0.25
DEFAULT_SUSTAIN_SECONDS = 0.0
DEFAULT_GM_RELEASE_SECONDS = 0.18
DEFAULT_REVERB_AMOUNT = 0.0
DEFAULT_REVERB_SECONDS = 1.6
DEFAULT_REVERB_DECAY = 0.62
OFFSET_CENT_RANGE = 64.0
OFFSET_MAGNITUDE_STEPS = 32768.0
SOUNDFONT_FILENAME = "acoustic_grand_piano-sounds.js"
MACOS_GM_SOUNDBANK = "/System/Library/Components/CoreAudio.component/Contents/Resources/gs_instruments.dls"
NOTE_NAMES_SHARP = ("C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B")
GM_PROGRAM_NAMES = (
    "Acoustic Grand Piano", "Bright Acoustic Piano", "Electric Grand Piano", "Honky-tonk Piano",
    "Electric Piano 1", "Electric Piano 2", "Harpsichord", "Clavinet",
    "Celesta", "Glockenspiel", "Music Box", "Vibraphone", "Marimba", "Xylophone", "Tubular Bells", "Dulcimer",
    "Drawbar Organ", "Percussive Organ", "Rock Organ", "Church Organ", "Reed Organ", "Accordion", "Harmonica", "Tango Accordion",
    "Acoustic Guitar nylon", "Acoustic Guitar steel", "Electric Guitar jazz", "Electric Guitar clean", "Electric Guitar muted", "Overdriven Guitar", "Distortion Guitar", "Guitar Harmonics",
    "Acoustic Bass", "Electric Bass finger", "Electric Bass pick", "Fretless Bass", "Slap Bass 1", "Slap Bass 2", "Synth Bass 1", "Synth Bass 2",
    "Violin", "Viola", "Cello", "Contrabass", "Tremolo Strings", "Pizzicato Strings", "Orchestral Harp", "Timpani",
    "String Ensemble 1", "String Ensemble 2", "Synth Strings 1", "Synth Strings 2", "Choir Aahs", "Voice Oohs", "Synth Voice", "Orchestra Hit",
    "Trumpet", "Trombone", "Tuba", "Muted Trumpet", "French Horn", "Brass Section", "Synth Brass 1", "Synth Brass 2",
    "Soprano Sax", "Alto Sax", "Tenor Sax", "Baritone Sax", "Oboe", "English Horn", "Bassoon", "Clarinet",
    "Piccolo", "Flute", "Recorder", "Pan Flute", "Blown Bottle", "Shakuhachi", "Whistle", "Ocarina",
    "Lead 1 square", "Lead 2 sawtooth", "Lead 3 calliope", "Lead 4 chiff", "Lead 5 charang", "Lead 6 voice", "Lead 7 fifths", "Lead 8 bass+lead",
    "Pad 1 new age", "Pad 2 warm", "Pad 3 polysynth", "Pad 4 choir", "Pad 5 bowed", "Pad 6 metallic", "Pad 7 halo", "Pad 8 sweep",
    "FX 1 rain", "FX 2 soundtrack", "FX 3 crystal", "FX 4 atmosphere", "FX 5 brightness", "FX 6", "FX 7 echoes", "FX 8 sci-fi",
    "Sitar", "Banjo", "Shamisen", "Koto", "Kalimba", "Bagpipe", "Fiddle", "Shanai",
    "Tinkle Bell", "Agogo", "Steel Drums", "Woodblock", "Taiko Drum", "Melodic Tom", "Synth Drum", "Reverse Cymbal",
    "Guitar Fret Noise", "Breath Noise", "Seashore", "Bird Tweet", "Telephone Ring", "Helicopter", "Applause", "Gunshot",
)


@dataclass
class TempoEvent:
    tick: int
    us_per_quarter: int


@dataclass
class RawNoteEvent:
    tick: int
    pitch: int
    midi_pitch: int
    cents: float
    velocity: int
    track: int
    channel: int
    program: int
    bank_msb: int
    bank_lsb: int
    order: int


@dataclass
class TrackInfo:
    track: int
    name: Optional[str] = None
    instrument: Optional[str] = None


@dataclass
class Note:
    start_tick: int
    end_tick: int
    start_sec: float
    end_sec: float
    pitch: int
    midi_pitch: int
    cents: float
    velocity: int
    track: int
    channel: int
    program: int
    bank_msb: int
    bank_lsb: int
    frequency: float
    sample_name: Optional[str] = None
    sample_shift_cents: Optional[float] = None

    @property
    def duration_sec(self) -> float:
        return max(0.0, self.end_sec - self.start_sec)

    @property
    def program_name(self) -> str:
        if 0 <= self.program < len(GM_PROGRAM_NAMES):
            return GM_PROGRAM_NAMES[self.program]
        return "Program %d" % self.program


class MidxParseError(Exception):
    pass


@dataclass
class SoundSample:
    name: str
    pitch: int
    sample_rate: int
    frames: List[float]

    @property
    def frequency(self) -> float:
        return midi_pitch_to_frequency(self.pitch, 0.0, 440.0)


@dataclass
class RealtimeVoice:
    note: Note
    phase: float = 0.0
    sample_index: int = 0
    release_sample: Optional[int] = None
    release_elapsed: int = 0
    release_start_level: float = 1.0


class RealtimeSynth:
    def __init__(
        self,
        notes: List[Note],
        sample_rate: int,
        gain: float,
        waveform: Optional[str],
        sustain_seconds: float,
        reverb_amount: float,
        reverb_seconds: float,
        reverb_decay: float,
    ) -> None:
        self.notes = sorted(notes, key=lambda n: (n.start_sec, n.track, n.channel, n.pitch))
        self.sample_rate = sample_rate
        self.gain = gain
        self.waveform = waveform
        self.sustain_samples = max(0, int(sustain_seconds * sample_rate))
        self.reverb_amount = max(0.0, min(1.0, reverb_amount))
        self.reverb_decay = max(0.0, min(0.95, reverb_decay))
        self.note_index = 0
        self.sample_cursor = 0
        self.active: List[RealtimeVoice] = []
        self.total_samples = int(
            math.ceil(
                (
                    max((note.end_sec for note in notes), default=0.0)
                    + max(0.05, sustain_seconds + (reverb_seconds if reverb_amount > 0.0 else 0.0))
                )
                * sample_rate
            )
        )
        self.reverb_delays = [max(1, int(seconds * sample_rate)) for seconds in (0.0297, 0.0371, 0.0411, 0.0533)]
        max_delay = max(1, int(max(0.1, reverb_seconds) * sample_rate))
        self.reverb_delays = [min(max_delay, delay) for delay in self.reverb_delays]
        self.reverb_buffer = [0.0] * (max(self.reverb_delays) + 1)
        self.reverb_index = 0

    @property
    def done(self) -> bool:
        return self.sample_cursor >= self.total_samples and not self.active and self.note_index >= len(self.notes)

    def render_block(self, frame_count: int) -> List[float]:
        out: List[float] = []
        for _ in range(frame_count):
            current_sec = self.sample_cursor / float(self.sample_rate)
            while self.note_index < len(self.notes) and self.notes[self.note_index].start_sec <= current_sec:
                self.active.append(RealtimeVoice(self.notes[self.note_index]))
                self.note_index += 1

            value = 0.0
            remaining_voices: List[RealtimeVoice] = []
            for voice in self.active:
                note = voice.note
                held_samples = max(1, int(round(note.duration_sec * self.sample_rate)))
                family = gm_family(note.program, note.channel)
                if voice.release_sample is None and current_sec >= note.end_sec:
                    voice.release_sample = voice.sample_index
                    voice.release_elapsed = 0
                    voice.release_start_level = gm_envelope(
                        min(voice.sample_index, held_samples - 1),
                        held_samples,
                        self.sample_rate,
                        family,
                    )

                if voice.release_sample is not None and voice.release_elapsed >= max(1, self.sustain_samples):
                    continue

                if voice.release_sample is None:
                    env = gm_envelope(voice.sample_index, held_samples, self.sample_rate, family)
                else:
                    release_len = max(1, self.sustain_samples)
                    env = voice.release_start_level * max(0.0, 1.0 - voice.release_elapsed / float(release_len)) ** 2.0

                harmonic_phase = (note.program + 1) * 0.173
                if self.waveform:
                    sample = render_waveform_sample(voice.phase, self.waveform)
                else:
                    sample = gm_wave_sample(voice.phase, harmonic_phase, family, note.program)
                value += velocity_to_gain(note.velocity, self.gain) * env * sample
                voice.phase += 2.0 * math.pi * note.frequency / self.sample_rate
                if voice.phase > 2.0 * math.pi:
                    voice.phase %= 2.0 * math.pi
                voice.sample_index += 1
                if voice.release_sample is not None:
                    voice.release_elapsed += 1
                remaining_voices.append(voice)

            self.active = remaining_voices
            out.append(self.apply_realtime_reverb(value))
            self.sample_cursor += 1
        return out

    def apply_realtime_reverb(self, value: float) -> float:
        if self.reverb_amount <= 0.0:
            return value
        wet = 0.0
        for delay in self.reverb_delays:
            wet += self.reverb_buffer[(self.reverb_index - delay) % len(self.reverb_buffer)]
        wet /= float(len(self.reverb_delays))
        mixed = value * (1.0 - self.reverb_amount * 0.35) + wet * self.reverb_amount
        self.reverb_buffer[self.reverb_index] = value + wet * self.reverb_decay
        self.reverb_index = (self.reverb_index + 1) % len(self.reverb_buffer)
        return mixed


class ByteReader:
    def __init__(self, data: bytes, source: str) -> None:
        self.data = data
        self.source = source
        self.pos = 0

    def remaining(self) -> int:
        return len(self.data) - self.pos

    def read(self, count: int) -> bytes:
        if self.pos + count > len(self.data):
            raise MidxParseError(
                "%s: unexpected end of file at byte %d while reading %d bytes"
                % (self.source, self.pos, count)
            )
        out = self.data[self.pos : self.pos + count]
        self.pos += count
        return out

    def read_u16(self) -> int:
        return struct.unpack(">H", self.read(2))[0]

    def read_u32(self) -> int:
        return struct.unpack(">I", self.read(4))[0]

    def read_vlq(self) -> int:
        value = 0
        for _ in range(4):
            byte = self.read(1)[0]
            value = (value << 7) | (byte & 0x7F)
            if byte < 0x80:
                return value
        raise MidxParseError("%s: invalid variable-length quantity near byte %d" % (self.source, self.pos))


def decode_cent_offset(raw: int) -> float:
    sign = -1.0 if raw & 0x8000 else 1.0
    magnitude = raw & 0x7FFF
    return sign * (magnitude / OFFSET_MAGNITUDE_STEPS * OFFSET_CENT_RANGE)


def decode_pitched_offset_payload(payload: bytes) -> Optional[Tuple[int, float]]:
    if (
        len(payload) == MIDX_PITCHED_OFFSET_PAYLOAD_LEN
        and payload[0] == MIDX_EXPERIMENTAL_MANUFACTURER_ID
        and payload[1:3] == MIDX_NAMESPACE
        and payload[3] == MIDX_PITCHED_OFFSET_RECORD_TYPE
    ):
        return payload[4], decode_cent_offset((payload[5] << 8) | payload[6])

    return None


def pop_inline_pitched_offset(
    inline_offsets: List[Tuple[int, int, float]],
    midi_pitch: int,
    tick: int,
) -> Optional[Tuple[int, float]]:
    for index, (queued_tick, pitch, cents) in enumerate(inline_offsets):
        if queued_tick == tick and pitch == midi_pitch:
            inline_offsets.pop(index)
            return pitch, cents

    same_tick = [
        (index, pitch, cents)
        for index, (queued_tick, pitch, cents) in enumerate(inline_offsets)
        if queued_tick == tick
    ]
    if len(same_tick) == 1:
        index, pitch, cents = same_tick[0]
        inline_offsets.pop(index)
        return pitch, cents
    return None


def midi_pitch_to_frequency(pitch: int, cents: float, a4_frequency: float) -> float:
    return a4_frequency * (2.0 ** (((pitch - 69) * 100.0 + cents) / 1200.0))


def note_name_to_pitch(name: str) -> Optional[int]:
    match = re.match(r"^([A-G])([b#]?)(-?\d+)$", name)
    if not match:
        return None
    letter, accidental, octave_text = match.groups()
    semitone = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}[letter]
    if accidental == "b":
        semitone -= 1
    elif accidental == "#":
        semitone += 1
    octave = int(octave_text)
    return (octave + 1) * 12 + semitone


def pitch_to_note_name(pitch: int) -> str:
    octave = pitch // 12 - 1
    return "%s%d" % (NOTE_NAMES_SHARP[pitch % 12], octave)


def find_default_soundfont(midx_path: str) -> Optional[str]:
    candidates = [
        os.path.join(os.path.dirname(os.path.abspath(midx_path)), SOUNDFONT_FILENAME),
        os.path.join(os.path.dirname(os.path.abspath(__file__)), SOUNDFONT_FILENAME),
    ]
    for candidate in candidates:
        if os.path.exists(candidate):
            return candidate
    return None


def extract_soundfont_data_uris(path: str) -> Dict[str, Tuple[str, str]]:
    with open(path, "r", encoding="utf-8", errors="ignore") as infile:
        text = infile.read()
    pattern = re.compile(r'"([A-G][b#]?-?\d+)"\s*:\s*"data:audio/([^;"]+);base64,([^"]+)"')
    out: Dict[str, Tuple[str, str]] = {}
    for name, extension, data in pattern.findall(text):
        if note_name_to_pitch(name) is not None:
            out[name] = (extension.lower(), data)
    return out


def decode_audio_data_uri(name: str, extension: str, data: str, target_sample_rate: int) -> SoundSample:
    decoder = choose_decoder()
    suffix = "." + ("mp3" if extension in ("mpeg", "mp3") else extension)
    source_file = tempfile.NamedTemporaryFile(prefix="midx-sample-%s-" % name, suffix=suffix, delete=False)
    wav_file = tempfile.NamedTemporaryFile(prefix="midx-sample-%s-" % name, suffix=".wav", delete=False)
    wav_file.close()
    os.unlink(wav_file.name)

    try:
        source_file.write(base64.b64decode(data))
        source_file.close()
        run_decoder(decoder, source_file.name, wav_file.name, target_sample_rate)
        sample_rate, frames = read_wav_mono(wav_file.name)
        pitch = note_name_to_pitch(name)
        if pitch is None:
            raise RuntimeError("invalid soundfont sample name: %s" % name)
        return SoundSample(name=name, pitch=pitch, sample_rate=sample_rate, frames=frames)
    finally:
        for path in (source_file.name, wav_file.name):
            try:
                os.unlink(path)
            except OSError:
                pass


def choose_decoder() -> str:
    for candidate in ("afconvert", "ffmpeg", "sox", "mpg123"):
        path = shutil.which(candidate)
        if path:
            return path
    raise RuntimeError("soundfont found, but no decoder found; install afconvert/ffmpeg/sox/mpg123 or pass --no-soundfont")


def run_decoder(decoder: str, source_path: str, wav_path: str, sample_rate: int) -> None:
    name = os.path.basename(decoder)
    if name == "afconvert":
        command = [decoder, "-f", "WAVE", "-d", "LEI16@%d" % sample_rate, source_path, wav_path]
    elif name == "ffmpeg":
        command = [decoder, "-y", "-loglevel", "error", "-i", source_path, "-ac", "1", "-ar", str(sample_rate), wav_path]
    elif name == "sox":
        command = [decoder, source_path, "-c", "1", "-r", str(sample_rate), wav_path]
    elif name == "mpg123":
        command = [decoder, "-q", "-w", wav_path, "-r", str(sample_rate), "-m", source_path]
    else:
        raise RuntimeError("unsupported decoder: %s" % decoder)
    subprocess.check_call(command, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def read_wav_mono(path: str) -> Tuple[int, List[float]]:
    with wave.open(path, "rb") as infile:
        channels = infile.getnchannels()
        sample_width = infile.getsampwidth()
        sample_rate = infile.getframerate()
        raw = infile.readframes(infile.getnframes())

    if sample_width == 1:
        values = [byte - 128 for byte in raw]
        scale = 128.0
    elif sample_width == 2:
        values = list(struct.unpack("<%dh" % (len(raw) // 2), raw))
        scale = 32768.0
    elif sample_width == 3:
        values = []
        for i in range(0, len(raw), 3):
            value = raw[i] | (raw[i + 1] << 8) | (raw[i + 2] << 16)
            if value & 0x800000:
                value -= 0x1000000
            values.append(value)
        scale = 8388608.0
    elif sample_width == 4:
        values = list(struct.unpack("<%di" % (len(raw) // 4), raw))
        scale = 2147483648.0
    else:
        raise RuntimeError("unsupported decoded sample width: %d" % sample_width)

    if channels == 1:
        return sample_rate, [value / scale for value in values]

    mono: List[float] = []
    for index in range(0, len(values), channels):
        mono.append(sum(values[index : index + channels]) / channels / scale)
    return sample_rate, mono


def workflow(enabled: bool, step: int, total: int, message: str) -> None:
    if enabled:
        print("[prep %d/%d] %s" % (step, total, message), file=sys.stderr, flush=True)


def progress(enabled: bool, message: str) -> None:
    if enabled:
        print("          %s" % message, file=sys.stderr, flush=True)


def load_soundfont(path: Optional[str], sample_rate: int, progress_enabled: bool) -> Optional[Dict[int, SoundSample]]:
    if not path:
        return None
    data_uris = extract_soundfont_data_uris(path)
    if not data_uris:
        raise RuntimeError("soundfont file has no recognizable samples: %s" % path)

    samples: Dict[int, SoundSample] = {}
    total = len(data_uris)
    for index, name in enumerate(sorted(data_uris, key=lambda value: note_name_to_pitch(value) or 0), 1):
        extension, data = data_uris[name]
        sample = decode_audio_data_uri(name, extension, data, sample_rate)
        samples[sample.pitch] = sample
        if progress_enabled and (index == total or index % 12 == 0):
            progress(True, "loaded soundfont samples %d/%d" % (index, total))

    return samples


def parse_midx(path: str) -> Tuple[int, List[TempoEvent], List[RawNoteEvent], Dict[int, TrackInfo]]:
    with open(path, "rb") as infile:
        reader = ByteReader(infile.read(), path)

    if reader.read(4) != b"MThd":
        raise MidxParseError("%s: missing MThd header" % path)
    header_len = reader.read_u32()
    header = ByteReader(reader.read(header_len), path + ":MThd")
    midi_format = header.read_u16()
    track_count = header.read_u16()
    division = header.read_u16()

    if division & 0x8000:
        raise MidxParseError("SMPTE time division is not supported: 0x%04x" % division)
    ticks_per_quarter = division
    if midi_format not in (0, 1):
        raise MidxParseError("unsupported MIDI format %d" % midi_format)

    tempos: List[TempoEvent] = [TempoEvent(0, DEFAULT_TEMPO_US_PER_QUARTER)]
    raw_notes: List[RawNoteEvent] = []
    track_info: Dict[int, TrackInfo] = {}
    order = 0

    for track_index in range(track_count):
        if reader.remaining() <= 0:
            raise MidxParseError("expected %d tracks, found only %d" % (track_count, track_index))
        chunk_type = reader.read(4)
        chunk_len = reader.read_u32()
        chunk_data = reader.read(chunk_len)
        if chunk_type != b"MTrk":
            continue
        track_reader = ByteReader(chunk_data, "%s:MTrk[%d]" % (path, track_index))
        tick = 0
        running_status: Optional[int] = None
        channel_programs: Dict[int, int] = {}
        channel_bank_msb: Dict[int, int] = {}
        channel_bank_lsb: Dict[int, int] = {}
        inline_pitched_offsets: List[Tuple[int, int, float]] = []
        track_info.setdefault(track_index, TrackInfo(track_index))

        while track_reader.remaining() > 0:
            delta = track_reader.read_vlq()
            tick += delta
            status_or_data = track_reader.read(1)[0]

            if status_or_data == 0xFF:
                meta_type = track_reader.read(1)[0]
                payload_len = track_reader.read_vlq()
                payload = track_reader.read(payload_len)
                if meta_type == 0x2F:
                    break
                if meta_type == 0x51 and payload_len == 3:
                    tempos.append(TempoEvent(tick, (payload[0] << 16) | (payload[1] << 8) | payload[2]))
                elif meta_type == 0x03:
                    track_info[track_index].name = payload.decode("utf-8", "replace")
                elif meta_type == 0x04:
                    track_info[track_index].instrument = payload.decode("utf-8", "replace")
                elif meta_type == MIDX_META_TYPE and payload_len == MIDX_PITCHED_OFFSET_PAYLOAD_LEN:
                    decoded_pitched_offset = decode_pitched_offset_payload(payload)
                    if decoded_pitched_offset is None:
                        inline_pitched_offsets = []
                        continue
                    pitch, cents = decoded_pitched_offset
                    if inline_pitched_offsets and inline_pitched_offsets[-1][0] != tick:
                        inline_pitched_offsets = []
                    inline_pitched_offsets.append((tick, pitch, cents))
                else:
                    inline_pitched_offsets = []
                continue

            if status_or_data in (0xF0, 0xF7):
                payload_len = track_reader.read_vlq()
                track_reader.read(payload_len)
                running_status = None
                inline_pitched_offsets = []
                continue

            if status_or_data & 0x80:
                status = status_or_data
                running_status = status
                first_data: Optional[int] = None
            else:
                if running_status is None:
                    raise MidxParseError("%s: running status without prior status" % track_reader.source)
                status = running_status
                first_data = status_or_data

            event_type = status & 0xF0
            channel = status & 0x0F
            if event_type in (0xC0, 0xD0):
                if first_data is None:
                    data1 = track_reader.read(1)[0]
                else:
                    data1 = first_data
                if event_type == 0xC0:
                    channel_programs[channel] = data1
                inline_pitched_offsets = []
                continue

            if first_data is None:
                data1 = track_reader.read(1)[0]
            else:
                data1 = first_data
            data2 = track_reader.read(1)[0]

            if event_type == 0xB0:
                if data1 == 0:
                    channel_bank_msb[channel] = data2
                elif data1 == 32:
                    channel_bank_lsb[channel] = data2

            if event_type in (0x80, 0x90):
                velocity = data2 if event_type == 0x90 else 0
                effective_pitch = data1
                if velocity > 0:
                    cents = 0.0
                    if inline_pitched_offsets and inline_pitched_offsets[-1][0] != tick:
                        inline_pitched_offsets = []
                    inline_match = pop_inline_pitched_offset(inline_pitched_offsets, data1, tick)
                    if inline_match is not None:
                        effective_pitch, cents = inline_match
                else:
                    inline_pitched_offsets = []
                    cents = 0.0
                raw_notes.append(
                    RawNoteEvent(
                        tick=tick,
                        pitch=effective_pitch,
                        midi_pitch=data1,
                        cents=cents,
                        velocity=velocity,
                        track=track_index,
                        channel=channel,
                        program=channel_programs.get(channel, 0),
                        bank_msb=channel_bank_msb.get(channel, 0),
                        bank_lsb=channel_bank_lsb.get(channel, 0),
                        order=order,
                    )
                )
                order += 1
            else:
                inline_pitched_offsets = []

    if not raw_notes:
        raise MidxParseError("no MIDX or MIDI note events found")

    return ticks_per_quarter, normalize_tempos(tempos), raw_notes, track_info


def ump_packet_size(message_type: int) -> int:
    if message_type in (0x0, 0x1, 0x2):
        return 4
    if message_type in (0x3, 0x4):
        return 8
    if message_type in (0x5, 0xD, 0xF):
        return 16
    return 4


def read_u32_from_bytes(data: bytes, offset: int) -> int:
    return (
        (data[offset] << 24)
        | (data[offset + 1] << 16)
        | (data[offset + 2] << 8)
        | data[offset + 3]
    )


def scale_down_32_to_7(value: int) -> int:
    return max(0, min(127, int(round((value & 0xFFFFFFFF) * 127.0 / 0xFFFFFFFF))))


def parse_midi2_clip(path: str) -> Tuple[int, List[TempoEvent], List[RawNoteEvent], Dict[int, TrackInfo]]:
    with open(path, "rb") as infile:
        data = infile.read()

    if data[: len(MIDI2_CLIP_HEADER)] != MIDI2_CLIP_HEADER:
        raise MidxParseError("%s: missing SMF2CLIP header" % path)

    pos = len(MIDI2_CLIP_HEADER)
    ticks_per_quarter = MIDI2_DEFAULT_TICKS_PER_QUARTER
    tick = 0
    order = 0
    tempos: List[TempoEvent] = [TempoEvent(0, DEFAULT_TEMPO_US_PER_QUARTER)]
    raw_notes: List[RawNoteEvent] = []
    track_info: Dict[int, TrackInfo] = {}
    channel_programs: Dict[Tuple[int, int], int] = {}
    channel_bank_msb: Dict[Tuple[int, int], int] = {}
    channel_bank_lsb: Dict[Tuple[int, int], int] = {}

    while pos < len(data):
        first = data[pos]
        message_type = first >> 4
        packet_len = ump_packet_size(message_type)
        if pos + packet_len > len(data):
            raise MidxParseError("%s: truncated MIDI 2.0 UMP packet at byte %d" % (path, pos))
        packet = data[pos : pos + packet_len]
        pos += packet_len

        if message_type == 0x0:
            utility_status = (packet[1] >> 4) & 0x0F
            if utility_status == 0x3:
                ticks_per_quarter = max(1, (packet[2] << 8) | packet[3])
            elif utility_status == 0x4:
                delta = ((packet[1] & 0x0F) << 16) | (packet[2] << 8) | packet[3]
                tick += delta
            continue

        if message_type == 0xD:
            if packet[1] == 0x10 and packet[2] == 0x00 and packet[3] == 0x00:
                ten_ns_per_quarter = read_u32_from_bytes(packet, 4)
                if ten_ns_per_quarter > 0:
                    tempos.append(TempoEvent(tick, max(1, int(round(ten_ns_per_quarter / 100.0)))))
            continue

        if message_type != 0x4:
            continue

        group = packet[0] & 0x0F
        status = packet[1]
        event_type = status & 0xF0
        channel = status & 0x0F
        key = (group, channel)
        track_info.setdefault(group, TrackInfo(group, "MIDI 2.0 Group %d" % group, None))

        if event_type == 0xB0:
            controller = packet[2] & 0x7F
            value = scale_down_32_to_7(read_u32_from_bytes(packet, 4))
            if controller == 0:
                channel_bank_msb[key] = value
            elif controller == 32:
                channel_bank_lsb[key] = value
            continue

        if event_type == 0xC0:
            options = packet[3]
            channel_programs[key] = packet[4] & 0x7F
            if options & 0x01:
                channel_bank_msb[key] = packet[6] & 0x7F
                channel_bank_lsb[key] = packet[7] & 0x7F
            continue

        if event_type not in (0x80, 0x90):
            continue

        midi_pitch = packet[2] & 0x7F
        attribute_type = packet[3]
        velocity16 = (packet[4] << 8) | packet[5]
        attribute = (packet[6] << 8) | packet[7]
        velocity = 0
        if event_type == 0x90 and velocity16 > 0:
            velocity = max(1, min(127, int(round(velocity16 * 127.0 / 0xFFFF))))

        effective_pitch = midi_pitch
        cents = 0.0
        if velocity > 0 and attribute_type == 0x03:
            pitch_float = attribute / 512.0
            effective_pitch = max(0, min(127, int(math.floor(pitch_float))))
            cents = (pitch_float - effective_pitch) * 100.0

        raw_notes.append(
            RawNoteEvent(
                tick=tick,
                pitch=effective_pitch,
                midi_pitch=midi_pitch,
                cents=cents,
                velocity=velocity,
                track=group,
                channel=channel,
                program=channel_programs.get(key, 0),
                bank_msb=channel_bank_msb.get(key, 0),
                bank_lsb=channel_bank_lsb.get(key, 0),
                order=order,
            )
        )
        order += 1

    if not raw_notes:
        raise MidxParseError("no MIDI 2.0 note events found")

    return ticks_per_quarter, normalize_tempos(tempos), raw_notes, track_info


def parse_input_file(path: str) -> Tuple[int, List[TempoEvent], List[RawNoteEvent], Dict[int, TrackInfo]]:
    with open(path, "rb") as infile:
        header = infile.read(len(MIDI2_CLIP_HEADER))
    if header == MIDI2_CLIP_HEADER:
        return parse_midi2_clip(path)
    return parse_midx(path)


def normalize_tempos(tempos: Iterable[TempoEvent]) -> List[TempoEvent]:
    by_tick: Dict[int, TempoEvent] = {}
    for tempo in tempos:
        if tempo.us_per_quarter > 0:
            by_tick[tempo.tick] = tempo
    out = [by_tick[tick] for tick in sorted(by_tick)]
    if not out or out[0].tick != 0:
        out.insert(0, TempoEvent(0, DEFAULT_TEMPO_US_PER_QUARTER))
    return out


def make_tempo_map(tempos: List[TempoEvent], ticks_per_quarter: int) -> Tuple[List[int], List[float], List[int]]:
    ticks: List[int] = []
    seconds: List[float] = []
    us_per_quarter: List[int] = []
    current_sec = 0.0
    previous_tick = 0
    previous_us = DEFAULT_TEMPO_US_PER_QUARTER

    for tempo in tempos:
        if tempo.tick < previous_tick:
            continue
        current_sec += (tempo.tick - previous_tick) * previous_us / 1000000.0 / ticks_per_quarter
        ticks.append(tempo.tick)
        seconds.append(current_sec)
        us_per_quarter.append(tempo.us_per_quarter)
        previous_tick = tempo.tick
        previous_us = tempo.us_per_quarter

    return ticks, seconds, us_per_quarter


def tick_to_seconds(tick: int, tempo_map: Tuple[List[int], List[float], List[int]], ticks_per_quarter: int) -> float:
    ticks, seconds, us_per_quarter = tempo_map
    index = bisect.bisect_right(ticks, tick) - 1
    if index < 0:
        index = 0
    return seconds[index] + (tick - ticks[index]) * us_per_quarter[index] / 1000000.0 / ticks_per_quarter


def pair_notes(
    raw_events: List[RawNoteEvent],
    tempo_map: Tuple[List[int], List[float], List[int]],
    ticks_per_quarter: int,
    a4_frequency: float,
    default_duration_ticks: int,
) -> List[Note]:
    active: Dict[Tuple[int, int, int, int], List[RawNoteEvent]] = {}
    active_by_midi_pitch: Dict[Tuple[int, int, int], List[RawNoteEvent]] = {}
    notes: List[Note] = []
    sorted_events = sorted(
        raw_events,
        key=lambda e: (e.tick, 0 if e.velocity == 0 else 1, e.track, e.channel, e.midi_pitch, e.pitch, e.order),
    )

    for event in sorted_events:
        key = (event.track, event.channel, event.midi_pitch, int(round(event.cents * 1000.0)))
        pitch_key = (event.track, event.channel, event.midi_pitch)
        if event.velocity > 0:
            active.setdefault(key, []).append(event)
            active_by_midi_pitch.setdefault(pitch_key, []).append(event)
            continue

        queue = active.get(key)
        if not queue:
            queue = active_by_midi_pitch.get(pitch_key)
        if not queue:
            continue
        start = queue.pop(0)
        start_key = (start.track, start.channel, start.midi_pitch, int(round(start.cents * 1000.0)))
        start_pitch_key = (start.track, start.channel, start.midi_pitch)
        if start_key != key:
            precise_queue = active.get(start_key)
            if precise_queue:
                try:
                    precise_queue.remove(start)
                except ValueError:
                    pass
        pitch_queue = active_by_midi_pitch.get(start_pitch_key)
        if pitch_queue:
            try:
                pitch_queue.remove(start)
            except ValueError:
                pass
        end_tick = max(event.tick, start.tick)
        notes.append(make_note(start, end_tick, tempo_map, ticks_per_quarter, a4_frequency))

    for queue in active.values():
        for start in queue:
            notes.append(make_note(start, start.tick + default_duration_ticks, tempo_map, ticks_per_quarter, a4_frequency))

    notes.sort(key=lambda n: (n.start_sec, n.track, n.pitch, n.cents))
    return notes


def make_note(
    start: RawNoteEvent,
    end_tick: int,
    tempo_map: Tuple[List[int], List[float], List[int]],
    ticks_per_quarter: int,
    a4_frequency: float,
) -> Note:
    start_sec = tick_to_seconds(start.tick, tempo_map, ticks_per_quarter)
    end_sec = tick_to_seconds(end_tick, tempo_map, ticks_per_quarter)
    return Note(
        start_tick=start.tick,
        end_tick=end_tick,
        start_sec=start_sec,
        end_sec=end_sec,
        pitch=start.pitch,
        midi_pitch=start.midi_pitch,
        cents=start.cents,
        velocity=start.velocity,
        track=start.track,
        channel=start.channel,
        program=start.program,
        bank_msb=start.bank_msb,
        bank_lsb=start.bank_lsb,
        frequency=midi_pitch_to_frequency(start.pitch, start.cents, a4_frequency),
    )


def velocity_to_gain(velocity: int, master_gain: float) -> float:
    normalized = max(0.0, min(1.0, velocity / 127.0))
    return master_gain * (normalized ** 1.35)


def render_waveform_sample(phase: float, waveform: str) -> float:
    if waveform == "sine":
        return math.sin(phase)
    if waveform == "triangle":
        return (2.0 / math.pi) * math.asin(math.sin(phase))
    if waveform == "square":
        return 1.0 if math.sin(phase) >= 0.0 else -1.0
    if waveform == "saw":
        return 2.0 * ((phase / (2.0 * math.pi)) % 1.0) - 1.0
    raise ValueError("unsupported waveform: %s" % waveform)


def envelope(sample_index: int, note_sample_count: int, sample_rate: int) -> float:
    if note_sample_count <= 0:
        return 0.0
    attack = max(1, int(0.006 * sample_rate))
    release = max(1, int(0.025 * sample_rate))
    if sample_index < attack:
        return sample_index / float(attack)
    remaining = note_sample_count - sample_index
    if remaining < release:
        return max(0.0, remaining / float(release))
    return 1.0


def gm_family(program: int, channel: int) -> str:
    if channel == 9:
        return "percussion"
    if program < 8:
        return "piano"
    if program < 16:
        return "chromatic"
    if program < 24:
        return "organ"
    if program < 32:
        return "guitar"
    if program < 40:
        return "bass"
    if program < 48:
        return "strings"
    if program < 56:
        return "ensemble"
    if program < 64:
        return "brass"
    if program < 80:
        return "reed"
    if program < 88:
        return "lead"
    if program < 104:
        return "pad"
    return "percussion" if program >= 112 else "pluck"


def gm_envelope(sample_index: int, note_sample_count: int, sample_rate: int, family: str) -> float:
    if note_sample_count <= 0:
        return 0.0
    profiles = {
        "piano": (0.002, 0.180, 0.0),
        "chromatic": (0.003, 0.090, 0.30),
        "organ": (0.010, 0.030, 1.0),
        "guitar": (0.003, 0.070, 0.55),
        "bass": (0.004, 0.050, 0.70),
        "strings": (0.060, 0.120, 0.90),
        "ensemble": (0.080, 0.160, 0.85),
        "brass": (0.025, 0.080, 0.85),
        "reed": (0.020, 0.070, 0.80),
        "lead": (0.006, 0.050, 0.85),
        "pad": (0.180, 0.220, 0.75),
        "pluck": (0.003, 0.080, 0.45),
        "percussion": (0.001, 0.180, 0.0),
    }
    attack_s, release_s, sustain = profiles.get(family, profiles["piano"])
    attack = max(1, int(attack_s * sample_rate))
    release = max(1, int(release_s * sample_rate))
    if sample_index < attack:
        return sample_index / float(attack)
    if family == "piano":
        elapsed = (sample_index - attack) / float(sample_rate)
        body = 0.72 * math.exp(-2.8 * elapsed) + 0.28 * math.exp(-0.55 * elapsed)
        return max(0.0, min(1.0, body))
    remaining = note_sample_count - sample_index
    if remaining < release:
        return max(0.0, sustain * remaining / float(release))
    if family in ("piano", "guitar", "pluck", "chromatic"):
        decay_position = min(1.0, sample_index / float(max(1, note_sample_count)))
        return sustain + (1.0 - sustain) * ((1.0 - decay_position) ** 2.0)
    if family == "percussion":
        return math.exp(-8.0 * sample_index / float(max(1, note_sample_count)))
    return sustain


def gm_wave_sample(phase: float, harmonic_phase: float, family: str, program: int) -> float:
    sine = math.sin(phase)
    second = math.sin(2.0 * phase + harmonic_phase)
    third = math.sin(3.0 * phase)
    saw = 2.0 * ((phase / (2.0 * math.pi)) % 1.0) - 1.0
    square = 1.0 if sine >= 0.0 else -1.0
    triangle = (2.0 / math.pi) * math.asin(sine)

    if family == "piano":
        fifth = math.sin(5.0 * phase + harmonic_phase * 0.37)
        strike = math.sin(9.0 * phase + harmonic_phase)
        return 0.58 * sine + 0.22 * second + 0.12 * third + 0.05 * fifth + 0.03 * strike
    if family == "chromatic":
        return 0.62 * sine + 0.26 * second + 0.12 * triangle
    if family == "organ":
        return 0.55 * sine + 0.25 * second + 0.15 * third + 0.05 * math.sin(4.0 * phase)
    if family == "guitar":
        return 0.55 * triangle + 0.28 * sine + 0.17 * third
    if family == "bass":
        return 0.72 * sine + 0.20 * triangle + 0.08 * second
    if family in ("strings", "ensemble", "pad"):
        slow = math.sin(0.07 * phase + program) * 0.025
        return 0.62 * math.sin(phase + slow) + 0.22 * second + 0.16 * saw
    if family == "brass":
        return 0.50 * saw + 0.36 * sine + 0.14 * second
    if family == "reed":
        return 0.58 * square + 0.30 * sine + 0.12 * third
    if family == "lead":
        return 0.52 * saw + 0.32 * square + 0.16 * sine
    if family == "percussion":
        noise = math.sin(phase * 12.9898 + harmonic_phase * 78.233) * 43758.5453
        noise = 2.0 * (noise - math.floor(noise)) - 1.0
        return 0.70 * noise + 0.30 * math.sin(phase * 1.7)
    return 0.70 * sine + 0.20 * triangle + 0.10 * second


def sample_release_envelope(sample_index: int, held_sample_count: int, render_sample_count: int, sample_rate: int) -> float:
    if sample_index < held_sample_count:
        return 1.0
    release = max(1, render_sample_count - held_sample_count)
    release_pos = sample_index - held_sample_count
    if release_pos >= release:
        return 0.0
    # Curved release: natural enough for piano samples without a hard note-off chop.
    return (1.0 - release_pos / float(release)) ** 2.2


def choose_sample(samples: Dict[int, SoundSample], pitch: int) -> SoundSample:
    if pitch in samples:
        return samples[pitch]
    sample_pitches = sorted(samples)
    index = bisect.bisect_left(sample_pitches, pitch)
    if index <= 0:
        return samples[sample_pitches[0]]
    if index >= len(sample_pitches):
        return samples[sample_pitches[-1]]
    lower = sample_pitches[index - 1]
    upper = sample_pitches[index]
    return samples[lower if abs(pitch - lower) <= abs(upper - pitch) else upper]


def annotate_notes_with_samples(notes: List[Note], samples: Optional[Dict[int, SoundSample]]) -> None:
    if not samples:
        for note in notes:
            note.sample_name = None
            note.sample_shift_cents = None
        return

    for note in notes:
        sample = choose_sample(samples, note.pitch)
        note.sample_name = sample.name
        note.sample_shift_cents = 1200.0 * math.log(note.frequency / sample.frequency, 2)


def render_sampled_note(
    mix: List[float],
    note: Note,
    sample: SoundSample,
    sample_rate: int,
    gain: float,
    sustain_seconds: float,
) -> None:
    start_sample = max(0, int(round(note.start_sec * sample_rate)))
    held_end_sample = max(start_sample + 1, int(round(note.end_sec * sample_rate)))
    render_end_sample = min(len(mix), held_end_sample + max(0, int(round(sustain_seconds * sample_rate))))
    held_sample_count = max(1, held_end_sample - start_sample)
    render_sample_count = render_end_sample - start_sample
    if render_sample_count <= 0 or not sample.frames:
        return

    amplitude = velocity_to_gain(note.velocity, gain)
    playback_ratio = note.frequency / sample.frequency
    source_position = 0.0
    last_source_index = len(sample.frames) - 1

    for offset, mix_index in enumerate(range(start_sample, render_end_sample)):
        source_index = int(source_position)
        if source_index >= last_source_index:
            break
        frac = source_position - source_index
        value = sample.frames[source_index] * (1.0 - frac) + sample.frames[source_index + 1] * frac
        mix[mix_index] += amplitude * sample_release_envelope(offset, held_sample_count, render_sample_count, sample_rate) * value
        source_position += playback_ratio


def render_waveform_note(mix: List[float], note: Note, sample_rate: int, waveform: str, gain: float) -> None:
    start_sample = max(0, int(round(note.start_sec * sample_rate)))
    end_sample = min(len(mix), max(start_sample + 1, int(round(note.end_sec * sample_rate))))
    note_sample_count = end_sample - start_sample
    amplitude = velocity_to_gain(note.velocity, gain)
    phase_step = 2.0 * math.pi * note.frequency / sample_rate
    phase = 0.0

    for offset, sample_position in enumerate(range(start_sample, end_sample)):
        mix[sample_position] += amplitude * envelope(offset, note_sample_count, sample_rate) * render_waveform_sample(phase, waveform)
        phase += phase_step


def render_gm_note(
    mix: List[float],
    note: Note,
    sample_rate: int,
    gain: float,
    waveform_override: Optional[str],
    sustain_seconds: float,
) -> None:
    start_sample = max(0, int(round(note.start_sec * sample_rate)))
    held_end_sample = max(start_sample + 1, int(round(note.end_sec * sample_rate)))
    end_sample = min(len(mix), held_end_sample + max(0, int(round(sustain_seconds * sample_rate))))
    held_sample_count = max(1, held_end_sample - start_sample)
    release_samples = max(1, end_sample - held_end_sample)
    amplitude = velocity_to_gain(note.velocity, gain)
    family = gm_family(note.program, note.channel)
    phase_step = 2.0 * math.pi * note.frequency / sample_rate
    phase = 0.0
    harmonic_phase = (note.program + 1) * 0.173
    release_start_level = gm_envelope(held_sample_count - 1, held_sample_count, sample_rate, family)

    for offset, sample_position in enumerate(range(start_sample, end_sample)):
        if offset < held_sample_count:
            env = gm_envelope(offset, held_sample_count, sample_rate, family)
        else:
            release_pos = offset - held_sample_count
            env = release_start_level * max(0.0, 1.0 - release_pos / float(release_samples)) ** 2.0
        if waveform_override:
            value = render_waveform_sample(phase, waveform_override)
        else:
            value = gm_wave_sample(phase, harmonic_phase, family, note.program)
        mix[sample_position] += amplitude * env * value
        phase += phase_step


def apply_reverb(mix: List[float], sample_rate: int, amount: float, reverb_seconds: float, decay: float) -> None:
    amount = max(0.0, min(1.0, amount))
    if amount <= 0.0 or reverb_seconds <= 0.0:
        return

    delays = [0.0297, 0.0371, 0.0411, 0.0533, 0.0719, 0.0893]
    gains = [0.62, 0.54, 0.48, 0.38, 0.30, 0.24]
    max_delay = max(1, int(reverb_seconds * sample_rate))
    wet = [0.0] * len(mix)

    for delay_seconds, gain in zip(delays, gains):
        delay = min(max_delay, max(1, int(delay_seconds * sample_rate)))
        feedback = max(0.0, min(0.95, decay * gain))
        for index in range(delay, len(mix)):
            wet[index] += (mix[index - delay] + wet[index - delay] * feedback) * gain

    dry = 1.0 - amount * 0.35
    wet_gain = amount / len(delays)
    for index in range(len(mix)):
        mix[index] = mix[index] * dry + wet[index] * wet_gain


def render_audio(
    notes: List[Note],
    sample_rate: int,
    waveform: Optional[str],
    gain: float,
    tail_seconds: float,
    sustain_seconds: float,
    reverb_amount: float,
    reverb_seconds: float,
    reverb_decay: float,
    progress_enabled: bool,
    soundfont: Optional[Dict[int, SoundSample]],
) -> Tuple[List[int], float]:
    gm_release_seconds = min(max(0.0, sustain_seconds), DEFAULT_GM_RELEASE_SECONDS)
    render_release_seconds = sustain_seconds if soundfont else gm_release_seconds
    effect_tail = max(tail_seconds, render_release_seconds + (reverb_seconds if reverb_amount > 0 else 0.0))
    duration = max((note.end_sec for note in notes), default=0.0) + effect_tail
    sample_count = max(1, int(math.ceil(duration * sample_rate)))
    mix = [0.0] * sample_count
    total = len(notes)

    for note_index, note in enumerate(notes, 1):
        if soundfont:
            render_sampled_note(mix, note, choose_sample(soundfont, note.pitch), sample_rate, gain, sustain_seconds)
        else:
            render_gm_note(mix, note, sample_rate, gain, waveform, gm_release_seconds)

        if progress_enabled and (note_index == total or note_index % 200 == 0):
            progress(True, "rendered notes %d/%d" % (note_index, total))

    if reverb_amount > 0.0:
        progress(progress_enabled, "applying reverb amount=%.2f seconds=%.2f decay=%.2f" % (reverb_amount, reverb_seconds, reverb_decay))
        apply_reverb(mix, sample_rate, reverb_amount, reverb_seconds, reverb_decay)

    progress(progress_enabled, "normalizing audio")
    peak = max((abs(value) for value in mix), default=1.0)
    normalizer = 0.92 / peak if peak > 0.92 else 1.0
    pcm = [max(-32768, min(32767, int(value * normalizer * 32767.0))) for value in mix]
    return pcm, duration


def write_wav(path: str, pcm: List[int], sample_rate: int) -> None:
    with wave.open(path, "wb") as outfile:
        outfile.setnchannels(1)
        outfile.setsampwidth(2)
        outfile.setframerate(sample_rate)
        data = struct.pack("<%dh" % len(pcm), *pcm)
        outfile.writeframes(data)


def is_acoustic_grand_piano(note: Note) -> bool:
    return note.channel != 9 and note.program == 0 and note.bank_msb == 0 and note.bank_lsb == 0


def split_native_piano_notes(notes: List[Note], enabled: bool) -> Tuple[List[Note], List[Note]]:
    if not enabled:
        return [], notes
    native_notes: List[Note] = []
    rendered_notes: List[Note] = []
    for note in notes:
        if is_acoustic_grand_piano(note):
            native_notes.append(note)
        else:
            rendered_notes.append(note)
    return native_notes, rendered_notes


def can_play_macos_native_midi() -> bool:
    return sys.platform == "darwin" and shutil.which("osascript") is not None and os.path.exists(MACOS_GM_SOUNDBANK)


def write_midi_vlq(value: int) -> bytes:
    value = int(max(0, min(0x0FFFFFFF, value)))
    out = [value & 0x7F]
    value >>= 7
    while value:
        out.insert(0, (value & 0x7F) | 0x80)
        value >>= 7
    return bytes(out)


def append_midi_event(events: List[Tuple[int, int, bytes]], tick: int, order: int, data: bytes) -> None:
    events.append((max(0, int(tick)), order, data))


def pitch_bend_bytes(channel: int, cents: float, bend_range_cents: float) -> bytes:
    bend_range_cents = max(1.0, float(bend_range_cents))
    value = int(round(8192.0 + max(-1.0, min(1.0, cents / bend_range_cents)) * 8191.0))
    value = max(0, min(16383, value))
    return bytes([0xE0 | (channel & 0x0F), value & 0x7F, (value >> 7) & 0x7F])


def build_native_piano_midi(
    notes: List[Note],
    ticks_per_quarter: int,
    tempos: List[TempoEvent],
    bend_range_cents: float = 100.0,
) -> bytes:
    events: List[Tuple[int, int, bytes]] = []
    piano_channels = [channel for channel in range(16) if channel != 9]
    free_channels = piano_channels[:]
    active_heap: List[Tuple[int, int, int]] = []
    active_by_note: Dict[int, int] = {}
    channel_bend: Dict[int, Optional[int]] = {}

    for tempo in tempos:
        mpqn = max(1, int(tempo.us_per_quarter))
        append_midi_event(events, tempo.tick, -30, bytes([0xFF, 0x51, 0x03, (mpqn >> 16) & 0xFF, (mpqn >> 8) & 0xFF, mpqn & 0xFF]))

    for channel in piano_channels:
        append_midi_event(events, 0, -20 + channel, bytes([0xB0 | channel, 101, 0]))
        append_midi_event(events, 0, 0 + channel, bytes([0xB0 | channel, 100, 0]))
        append_midi_event(events, 0, 20 + channel, bytes([0xB0 | channel, 6, max(1, int(round(bend_range_cents / 100.0)))]))
        append_midi_event(events, 0, 40 + channel, bytes([0xB0 | channel, 38, 0]))
        append_midi_event(events, 0, 60 + channel, bytes([0xC0 | channel, 0]))
        channel_bend[channel] = None

    sorted_notes = sorted(enumerate(notes), key=lambda item: (item[1].start_tick, item[1].end_tick, item[1].pitch, item[0]))
    for note_id, note in sorted_notes:
        while active_heap and active_heap[0][0] <= note.start_tick:
            end_tick, channel, ended_note_id = heapq.heappop(active_heap)
            if active_by_note.pop(ended_note_id, None) != channel:
                continue
            ended_note = notes[ended_note_id]
            append_midi_event(events, end_tick, 100000 + ended_note_id, bytes([0x80 | channel, ended_note.pitch & 0x7F, 0]))
            if channel not in free_channels:
                free_channels.append(channel)

        bend_key = int(round(note.cents * 1000.0))
        chosen_channel: Optional[int] = None
        for channel in free_channels:
            if channel_bend.get(channel) == bend_key:
                chosen_channel = channel
                free_channels.remove(channel)
                break
        if chosen_channel is None:
            if free_channels:
                chosen_channel = free_channels.pop(0)
            else:
                while active_heap:
                    _end_tick, candidate_channel, ended_note_id = heapq.heappop(active_heap)
                    if active_by_note.pop(ended_note_id, None) == candidate_channel:
                        chosen_channel = candidate_channel
                        ended_note = notes[ended_note_id]
                        append_midi_event(events, note.start_tick, 100000 + ended_note_id, bytes([0x80 | chosen_channel, ended_note.pitch & 0x7F, 0]))
                        break
                if chosen_channel is None:
                    chosen_channel = piano_channels[0]

        channel_bend[chosen_channel] = bend_key
        append_midi_event(events, note.start_tick, 200000 + note_id, pitch_bend_bytes(chosen_channel, note.cents, bend_range_cents))
        append_midi_event(events, note.start_tick, 300000 + note_id, bytes([0x90 | chosen_channel, note.pitch & 0x7F, max(1, note.velocity & 0x7F)]))
        active_by_note[note_id] = chosen_channel
        heapq.heappush(active_heap, (max(note.end_tick, note.start_tick + 1), chosen_channel, note_id))

    while active_heap:
        end_tick, channel, note_id = heapq.heappop(active_heap)
        if active_by_note.pop(note_id, None) == channel:
            note = notes[note_id]
            append_midi_event(events, end_tick, 100000 + note_id, bytes([0x80 | channel, note.pitch & 0x7F, 0]))

    track = bytearray()
    previous_tick = 0
    for tick, _order, data in sorted(events, key=lambda item: (item[0], item[1])):
        track.extend(write_midi_vlq(tick - previous_tick))
        track.extend(data)
        previous_tick = tick
    track.extend(write_midi_vlq(0))
    track.extend(b"\xFF\x2F\x00")

    out = bytearray()
    out.extend(b"MThd")
    out.extend(struct.pack(">IHHH", 6, 0, 1, ticks_per_quarter))
    out.extend(b"MTrk")
    out.extend(struct.pack(">I", len(track)))
    out.extend(track)
    return bytes(out)


def write_native_piano_midi(path: str, notes: List[Note], ticks_per_quarter: int, tempos: List[TempoEvent]) -> None:
    with open(path, "wb") as outfile:
        outfile.write(build_native_piano_midi(notes, ticks_per_quarter, tempos))


def make_macos_midi_player_script() -> str:
    return "\n".join([
        "ObjC.import('Foundation');",
        "ObjC.import('AVFoundation');",
        "var args = $.NSProcessInfo.processInfo.arguments;",
        "var midiPath = ObjC.unwrap(args.objectAtIndex(args.count - 2));",
        "var bankPath = ObjC.unwrap(args.objectAtIndex(args.count - 1));",
        "var midiURL = $.NSURL.fileURLWithPath($(midiPath));",
        "var bankURL = $.NSURL.fileURLWithPath($(bankPath));",
        "var error = Ref();",
        "var player = $.AVMIDIPlayer.alloc.initWithContentsOfURLSoundBankURLError(midiURL, bankURL, error);",
        "if (!player) {",
        "  var msg = error[0] ? ObjC.unwrap(error[0].localizedDescription) : '<nil error>';",
        "  throw new Error('AVMIDIPlayer init failed: ' + msg);",
        "}",
        "player.prepareToPlay;",
        "player.play(null);",
        "while (player.playing) { $.NSThread.sleepForTimeInterval(0.05); }",
        "",
    ])


def start_macos_native_midi_player(midi_path: str) -> subprocess.Popen:
    if not can_play_macos_native_midi():
        raise RuntimeError(
            "native Acoustic Grand Piano playback needs macOS osascript and the system GM soundbank: %s" % MACOS_GM_SOUNDBANK
        )
    return subprocess.Popen(["osascript", "-l", "JavaScript", "-e", make_macos_midi_player_script(), midi_path, MACOS_GM_SOUNDBANK])


def module_available(name: str) -> bool:
    try:
        __import__(name)
        return True
    except Exception:
        return False


def print_backend_report() -> None:
    players = []
    for candidate in ("afplay", "ffplay", "aplay", "paplay", "play"):
        path = shutil.which(candidate)
        if path:
            players.append("%s=%s" % (candidate, path))
    print("backend_check:", flush=True)
    print("  offline_wav_render=available (built-in Python renderer)", flush=True)
    print("  wav_players=%s" % (", ".join(players) if players else "<none>"), flush=True)
    print("  sounddevice=%s" % ("available" if module_available("sounddevice") else "missing; install with python3 -m pip install sounddevice"), flush=True)
    print("  pyaudio=%s" % ("available" if module_available("pyaudio") else "missing; install with python3 -m pip install pyaudio"), flush=True)
    print(
        "  macos_native_midi=%s"
        % (
            "available (%s)" % MACOS_GM_SOUNDBANK
            if can_play_macos_native_midi()
            else "unavailable; macOS osascript and system GM soundbank required"
        ),
        flush=True,
    )
    print("  default_path=offline WAV render + system WAV player; no external MIDI soundfont required", flush=True)


def choose_player(explicit_player: Optional[str]) -> List[str]:
    if explicit_player:
        return [explicit_player]
    for candidate in ("afplay", "ffplay", "aplay", "paplay", "play"):
        path = shutil.which(candidate)
        if path:
            if candidate == "ffplay":
                return [path, "-nodisp", "-autoexit", "-loglevel", "quiet"]
            return [path]
    raise RuntimeError("no audio player found; pass --wav-out to render only, or install afplay/ffplay/aplay/paplay/play")


def float_block_to_bytes(block: List[float]) -> bytes:
    pcm = [max(-32768, min(32767, int(max(-1.0, min(1.0, value)) * 32767.0))) for value in block]
    return struct.pack("<%dh" % len(pcm), *pcm)


def play_realtime_sounddevice(synth: RealtimeSynth, block_size: int) -> None:
    try:
        import sounddevice as sd  # type: ignore
    except ImportError as exc:
        raise RuntimeError("sounddevice is not installed; run: python3 -m pip install sounddevice") from exc

    finished = threading.Event()

    def callback(outdata, frames, time_info, status):  # type: ignore
        if status:
            print("audio status: %s" % status, file=sys.stderr)
        block = synth.render_block(frames)
        if len(block) < frames:
            block += [0.0] * (frames - len(block))
        for index, value in enumerate(block):
            outdata[index, 0] = max(-1.0, min(1.0, value))
        if synth.done:
            finished.set()
            raise sd.CallbackStop()

    with sd.OutputStream(
        samplerate=synth.sample_rate,
        channels=1,
        dtype="float32",
        blocksize=block_size,
        callback=callback,
    ):
        while not finished.is_set():
            time.sleep(0.05)


def play_realtime_pyaudio(synth: RealtimeSynth, block_size: int) -> None:
    try:
        import pyaudio  # type: ignore
    except ImportError as exc:
        raise RuntimeError("PyAudio is not installed; run: python3 -m pip install pyaudio") from exc

    audio = pyaudio.PyAudio()
    stream = audio.open(
        format=pyaudio.paInt16,
        channels=1,
        rate=synth.sample_rate,
        output=True,
        frames_per_buffer=block_size,
    )
    try:
        while not synth.done:
            block = synth.render_block(block_size)
            stream.write(float_block_to_bytes(block))
    finally:
        stream.stop_stream()
        stream.close()
        audio.terminate()


def play_realtime_audio(
    notes: List[Note],
    sample_rate: int,
    gain: float,
    waveform: Optional[str],
    sustain_seconds: float,
    reverb_amount: float,
    reverb_seconds: float,
    reverb_decay: float,
    backend: str,
    block_size: int,
) -> float:
    synth = RealtimeSynth(
        notes,
        sample_rate,
        gain,
        waveform,
        min(max(0.0, sustain_seconds), DEFAULT_GM_RELEASE_SECONDS),
        reverb_amount,
        reverb_seconds,
        reverb_decay,
    )
    start = time.monotonic()
    if backend == "sounddevice":
        play_realtime_sounddevice(synth, block_size)
    elif backend == "pyaudio":
        play_realtime_pyaudio(synth, block_size)
    else:
        try:
            play_realtime_sounddevice(synth, block_size)
        except RuntimeError as first_error:
            try:
                play_realtime_pyaudio(synth, block_size)
            except RuntimeError as second_error:
                raise RuntimeError("%s; %s" % (first_error, second_error))
    return time.monotonic() - start


def format_note_line(note: Note, index: int, elapsed: float, active_count: int) -> str:
    sign = "+" if note.cents >= 0 else ""
    sample_text = ""
    if note.sample_name is not None and note.sample_shift_cents is not None:
        sample_sign = "+" if note.sample_shift_cents >= 0 else ""
        sample_text = " sample=%s shift=%s%.3fc" % (note.sample_name, sample_sign, note.sample_shift_cents)
    midi_pitch_text = ""
    if note.midi_pitch != note.pitch:
        midi_pitch_text = " midi_pitch=%03d" % note.midi_pitch
    return (
        "[%8.3fs] #%05d track=%02d ch=%02d program=%03d:%s bank=%d/%d "
        "tick=%d..%d pitch=%03d%s cents=%s%.3f freq=%9.3fHz vel=%03d dur=%6.3fs active=%d%s"
        % (
            elapsed,
            index,
            note.track,
            note.channel + 1,
            note.program,
            note.program_name,
            note.bank_msb,
            note.bank_lsb,
            note.start_tick,
            note.end_tick,
            note.pitch,
            midi_pitch_text,
            sign,
            note.cents,
            note.frequency,
            note.velocity,
            note.duration_sec,
            active_count,
            sample_text,
        )
    )


def echo_notes_realtime(notes: List[Note], start_time: float) -> None:
    start_sorted = sorted(enumerate(notes, 1), key=lambda item: (item[1].start_sec, item[1].track, item[1].pitch))
    end_times = sorted(note.end_sec for note in notes)
    end_index = 0

    try:
        for index, note in start_sorted:
            target = start_time + note.start_sec
            while True:
                remaining = target - time.monotonic()
                if remaining <= 0:
                    break
                time.sleep(min(remaining, 0.02))

            while end_index < len(end_times) and end_times[end_index] <= note.start_sec:
                end_index += 1
            active_count = max(0, index - end_index)
            print(format_note_line(note, index, time.monotonic() - start_time, active_count), flush=True)
    except KeyboardInterrupt:
        print("\ninterrupted", file=sys.stderr)


def print_summary(
    path: str,
    ticks_per_quarter: int,
    tempos: List[TempoEvent],
    raw_events: List[RawNoteEvent],
    notes: List[Note],
    track_info: Dict[int, TrackInfo],
    duration: float,
    renderer: str,
) -> None:
    print("input=%s" % path, flush=True)
    print(
        "ticks_per_quarter=%d tempo_events=%d raw_note_events=%d paired_notes=%d duration=%.3fs"
        % (
            ticks_per_quarter,
            len(tempos),
            len(raw_events),
            len(notes),
            duration,
        ),
        flush=True,
    )
    if tempos:
        bpm = 60000000.0 / tempos[0].us_per_quarter
        print("initial_tempo=%.3f bpm" % bpm, flush=True)
    print("renderer=%s" % renderer, flush=True)
    programs = sorted(set((note.channel, note.program, note.bank_msb, note.bank_lsb) for note in notes))
    if programs:
        program_text = ", ".join(
            "ch%d bank=%d/%d program=%d:%s" % (
                channel + 1,
                bank_msb,
                bank_lsb,
                program,
                GM_PROGRAM_NAMES[program] if 0 <= program < len(GM_PROGRAM_NAMES) else "Program %d" % program,
            )
            for channel, program, bank_msb, bank_lsb in programs[:12]
        )
        if len(programs) > 12:
            program_text += ", ... %d more" % (len(programs) - 12)
        print("programs=%s" % program_text, flush=True)
    named_tracks = [
        info for _, info in sorted(track_info.items())
        if info.name or info.instrument
    ]
    for info in named_tracks[:12]:
        print(
            "track_info track=%02d name=%r instrument=%r" % (info.track, info.name or "", info.instrument or ""),
            flush=True,
        )


def list_notes(notes: List[Note], limit: int) -> None:
    if limit < 0:
        limit = len(notes)
    for index, note in enumerate(notes[:limit], 1):
        print(format_note_line(note, index, note.start_sec, 0), flush=True)
    if limit < len(notes):
        print("... %d more notes" % (len(notes) - limit), flush=True)


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(
        description="Play a current-format MIDX or MIDI 2.0 Clip file in the terminal and echo rendered note data in real time."
    )
    parser.add_argument("file", nargs="?", help="Path to a .midx/.midix or .midi2 file")
    parser.add_argument("--check-backends", action="store_true", help="Print playback backend availability and exit")
    parser.add_argument("--wav-out", help="Write the rendered WAV here instead of a temporary file")
    parser.add_argument("--no-play", action="store_true", help="Render/inspect only; do not start an audio player")
    parser.add_argument("--no-echo", action="store_true", help="Do not echo notes in real time")
    parser.add_argument("--realtime", action="store_true", help="Play GM/wavetable synthesis directly through sounddevice/PyAudio without pre-rendering a WAV")
    parser.add_argument("--audio-backend", choices=("auto", "sounddevice", "pyaudio"), default="auto", help="Realtime audio backend, default %(default)s")
    parser.add_argument("--block-size", type=int, default=512, help="Realtime audio callback block size, default %(default)s")
    parser.add_argument("--sample-rate", type=int, default=DEFAULT_SAMPLE_RATE, help="Audio sample rate, default %(default)s")
    parser.add_argument("--waveform", choices=("sine", "triangle", "square", "saw"), help="Override the default GM-style native MIDI instrument renderer with one waveform")
    parser.add_argument(
        "--piano-renderer",
        choices=("auto", "native", "internal"),
        default="internal",
        help="Renderer for GM program 0 Acoustic Grand Piano. internal is cross-platform; native requires the macOS GM MIDI soundbank.",
    )
    parser.add_argument("--gain", type=float, default=0.8, help="Master gain before normalization, default %(default)s")
    parser.add_argument("--a4", type=float, default=440.0, help="A4 frequency, default %(default)s")
    parser.add_argument("--tail", type=float, default=DEFAULT_TAIL_SECONDS, help="Rendered tail seconds, default %(default)s")
    parser.add_argument("--sustain", type=float, default=DEFAULT_SUSTAIN_SECONDS, help="Seconds of post-note release for sampled notes, default %(default)s")
    parser.add_argument("--reverb", type=float, default=DEFAULT_REVERB_AMOUNT, help="Reverb wet amount 0..1, default %(default)s")
    parser.add_argument("--reverb-seconds", type=float, default=DEFAULT_REVERB_SECONDS, help="Reverb tail length, default %(default)s")
    parser.add_argument("--reverb-decay", type=float, default=DEFAULT_REVERB_DECAY, help="Reverb feedback decay 0..1, default %(default)s")
    parser.add_argument("--quiet-prep", action="store_true", help="Hide preprocessing workflow/progress messages")
    parser.add_argument("--player", help="Audio player executable. Defaults to afplay/ffplay/aplay/paplay/play")
    parser.add_argument("--render-progress", action="store_true", help="Print offline rendering progress")
    parser.add_argument(
        "--soundfont",
        help="Path to a MIDI.js *-sounds.js file. When set, sampled playback overrides the default native MIDI instrument renderer.",
    )
    parser.add_argument("--auto-soundfont", action="store_true", help="Use acoustic_grand_piano-sounds.js beside the MIDX file or this script if present")
    parser.add_argument("--no-soundfont", action="store_true", help="Disable soundfont sampling even when --auto-soundfont is set")
    parser.add_argument(
        "--list-notes",
        type=int,
        metavar="N",
        help="List the first N paired notes and exit before rendering. Use -1 for all notes.",
    )
    args = parser.parse_args(argv)
    if args.check_backends:
        print_backend_report()
        return 0
    if not args.file:
        parser.error("file is required unless --check-backends is used")

    prep_enabled = not args.quiet_prep
    piano_native_requested = args.piano_renderer == "native"
    piano_native_enabled = (
        not args.no_play
        and not args.wav_out
        and not args.soundfont
        and not args.auto_soundfont
        and not args.waveform
        and args.piano_renderer in ("auto", "native")
        and can_play_macos_native_midi()
    )
    if piano_native_requested and not piano_native_enabled:
        raise RuntimeError(
            "--piano-renderer native requires playback without --wav-out/--soundfont/--auto-soundfont/--waveform on macOS with osascript and %s"
            % MACOS_GM_SOUNDBANK
        )
    realtime_enabled = bool(
        args.realtime
        and not args.no_play
        and not args.wav_out
        and not args.soundfont
        and not args.auto_soundfont
        and not piano_native_enabled
    )
    prep_steps = 7 if args.list_notes is not None else (8 if realtime_enabled else 9)

    workflow(prep_enabled, 1, prep_steps, "parsing MIDX or MIDI 2.0 note events")
    ticks_per_quarter, tempos, raw_events, track_info = parse_input_file(args.file)
    progress(prep_enabled, "ticks_per_quarter=%d tempo_events=%d raw_note_events=%d" % (ticks_per_quarter, len(tempos), len(raw_events)))

    workflow(prep_enabled, 2, prep_steps, "building tempo map")
    tempo_map = make_tempo_map(tempos, ticks_per_quarter)

    workflow(prep_enabled, 3, prep_steps, "pairing note-on/note-off events")
    notes = pair_notes(
        raw_events,
        tempo_map,
        ticks_per_quarter,
        args.a4,
        default_duration_ticks=ticks_per_quarter,
    )
    if not notes:
        raise MidxParseError("note events were found, but no note-on/note-off pairs could be made")
    progress(prep_enabled, "paired_notes=%d" % len(notes))

    workflow(prep_enabled, 4, prep_steps, "locating soundfont")
    soundfont_path = None
    if not args.no_soundfont:
        if args.soundfont:
            soundfont_path = args.soundfont
        elif args.auto_soundfont:
            soundfont_path = find_default_soundfont(args.file)
    progress(prep_enabled, "soundfont=%s" % (soundfont_path if soundfont_path else "<disabled or not found>"))

    workflow(prep_enabled, 5, prep_steps, "loading soundfont samples" if soundfont_path else "selecting native MIDI instrument renderer")
    soundfont = load_soundfont(soundfont_path, args.sample_rate, prep_enabled or args.render_progress) if soundfont_path else None
    if soundfont:
        renderer = "soundfont:%s samples=%d" % (soundfont_path, len(soundfont))
    elif args.waveform:
        renderer = "waveform:%s" % args.waveform
    elif piano_native_enabled:
        renderer = "hybrid:native-macos-gm-piano+native-midi-gm"
    else:
        renderer = "native-midi-gm"

    workflow(prep_enabled, 6, prep_steps, "annotating notes with rendered sample/pitch-shift data")
    annotate_notes_with_samples(notes, soundfont)

    if args.list_notes is not None:
        workflow(prep_enabled, 7, prep_steps, "printing inspected note data")
        last_end = max((note.end_sec for note in notes), default=0.0)
        inspect_tail = max(args.tail, args.sustain + (args.reverb_seconds if args.reverb > 0 else 0.0))
        print_summary(args.file, ticks_per_quarter, tempos, raw_events, notes, track_info, last_end + inspect_tail, renderer + " inspect-only")
        list_notes(notes, args.list_notes)
        return 0

    if args.realtime and not realtime_enabled:
        progress(
            prep_enabled,
            "realtime disabled because --no-play, --wav-out, --soundfont, --auto-soundfont, or native piano playback requires the offline WAV path",
        )

    if realtime_enabled:
        workflow(prep_enabled, 7, prep_steps, "summarizing realtime audio")
        duration = max((note.end_sec for note in notes), default=0.0) + max(args.tail, args.sustain + (args.reverb_seconds if args.reverb > 0 else 0.0))
        renderer = renderer + ":realtime:%s" % args.audio_backend
        print_summary(args.file, ticks_per_quarter, tempos, raw_events, notes, track_info, duration, renderer)
        print("realtime sample_rate=%d block_size=%d backend=%s" % (args.sample_rate, args.block_size, args.audio_backend), flush=True)

        start_time = time.monotonic()
        echo_thread: Optional[threading.Thread] = None
        if not args.no_echo:
            echo_thread = threading.Thread(target=echo_notes_realtime, args=(notes, start_time))
            echo_thread.daemon = True
            echo_thread.start()

        workflow(prep_enabled, 8, prep_steps, "streaming realtime audio")
        play_realtime_audio(
            notes,
            args.sample_rate,
            args.gain,
            args.waveform,
            max(0.0, args.sustain),
            max(0.0, min(1.0, args.reverb)),
            max(0.0, args.reverb_seconds),
            max(0.0, min(0.95, args.reverb_decay)),
            args.audio_backend,
            max(64, args.block_size),
        )
        if echo_thread is not None:
            echo_thread.join(timeout=0.2)
        return 0

    native_piano_notes, rendered_notes = split_native_piano_notes(notes, piano_native_enabled)
    native_piano_path = None
    native_piano_temp: Optional[tempfile.NamedTemporaryFile] = None
    if native_piano_notes:
        workflow(prep_enabled, 7, prep_steps, "preparing native macOS GM piano MIDI")
        native_piano_temp = tempfile.NamedTemporaryFile(prefix="midx-native-piano-", suffix=".mid", delete=False)
        native_piano_path = native_piano_temp.name
        native_piano_temp.close()
        write_native_piano_midi(native_piano_path, native_piano_notes, ticks_per_quarter, tempos)
        progress(prep_enabled, "native piano notes=%d midi=%s" % (len(native_piano_notes), native_piano_path))
    else:
        workflow(prep_enabled, 7, prep_steps, "rendering notes")

    pcm, duration = render_audio(
        rendered_notes,
        args.sample_rate,
        args.waveform,
        args.gain,
        args.tail,
        max(0.0, args.sustain),
        max(0.0, min(1.0, args.reverb)),
        max(0.0, args.reverb_seconds),
        max(0.0, min(0.95, args.reverb_decay)),
        prep_enabled or args.render_progress,
        soundfont,
    )
    if native_piano_notes:
        native_tail = max((note.end_sec for note in native_piano_notes), default=0.0) + args.tail
        duration = max(duration, native_tail)

    workflow(prep_enabled, 8, prep_steps, "summarizing rendered audio")
    print_summary(args.file, ticks_per_quarter, tempos, raw_events, notes, track_info, duration, renderer)

    temp_file: Optional[tempfile.NamedTemporaryFile] = None
    if args.wav_out:
        wav_path = args.wav_out
    else:
        temp_file = tempfile.NamedTemporaryFile(prefix="midx-render-", suffix=".wav", delete=False)
        wav_path = temp_file.name
        temp_file.close()

    try:
        workflow(prep_enabled, 9, prep_steps, "writing WAV and preparing playback")
        write_wav(wav_path, pcm, args.sample_rate)
        print("wav=%s sample_rate=%d samples=%d" % (wav_path, args.sample_rate, len(pcm)), flush=True)

        player_proc: Optional[subprocess.Popen] = None
        native_piano_proc: Optional[subprocess.Popen] = None
        start_time = time.monotonic()
        if not args.no_play:
            command = None
            if rendered_notes or not native_piano_notes:
                command = choose_player(args.player) + [wav_path]
                print("player=%s" % " ".join(command), flush=True)
            if native_piano_path:
                print("native_piano_player=osascript AVMIDIPlayer soundbank=%s" % MACOS_GM_SOUNDBANK, flush=True)
            start_time = time.monotonic()
            if command:
                player_proc = subprocess.Popen(command)
            if native_piano_path:
                native_piano_proc = start_macos_native_midi_player(native_piano_path)

        if not args.no_echo:
            echo_notes_realtime(notes, start_time)

        if player_proc is not None:
            player_proc.wait()
        if native_piano_proc is not None:
            native_piano_proc.wait()

        return 0
    finally:
        if temp_file is not None:
            try:
                os.unlink(wav_path)
            except OSError:
                pass
        if native_piano_temp is not None and native_piano_path is not None:
            try:
                os.unlink(native_piano_path)
            except OSError:
                pass


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (MidxParseError, RuntimeError, OSError, ValueError) as exc:
        print("error: %s" % exc, file=sys.stderr)
        raise SystemExit(1)
