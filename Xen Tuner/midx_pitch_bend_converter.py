#!/usr/bin/env python3
"""Convert Xen Tuner MIDX or SMF2CLIP MIDI 2.0 files to pitch-bend MIDI."""

from __future__ import print_function

import argparse
import heapq
import math
import os
import struct
import tempfile


MIDX_META_TYPE = 0x7F
MIDX_PITCHED_OFFSET_PAYLOAD_LEN = 7
MIDX_EXPERIMENTAL_MANUFACTURER_ID = 0x7D
MIDX_NAMESPACE = b"XT"
MIDX_PITCHED_OFFSET_RECORD_TYPE = 0x03
MIDX_CENT_RANGE = 64.0
MIDX_MAGNITUDE_STEPS = 32768.0
MIDI2_CLIP_HEADER = b"SMF2CLIP"
MIDI2_DEFAULT_TICKS_PER_QUARTER = 480
DEFAULT_TEMPO_US_PER_QUARTER = 500000
MELODIC_CHANNELS = tuple(channel for channel in range(16) if channel != 9)
SYSTEM_EVENT_DATA_LENGTHS = {
    0xF1: 1,
    0xF2: 2,
    0xF3: 1,
    0xF6: 0,
    0xF8: 0,
    0xFA: 0,
    0xFB: 0,
    0xFC: 0,
    0xFE: 0,
}


class ConversionError(ValueError):
    pass


class ByteReader(object):
    def __init__(self, data, source):
        self.data = data
        self.source = source
        self.pos = 0

    def remaining(self):
        return len(self.data) - self.pos

    def read(self, count):
        end = self.pos + count
        if end > len(self.data):
            raise ConversionError(
                "%s: expected %d bytes at byte %d" % (self.source, count, self.pos)
            )
        value = self.data[self.pos:end]
        self.pos = end
        return value

    def read_u16(self):
        return struct.unpack(">H", self.read(2))[0]

    def read_u32(self):
        return struct.unpack(">I", self.read(4))[0]

    def read_vlq(self):
        value = 0
        start = self.pos
        for _unused in range(4):
            byte = self.read(1)[0]
            value = (value << 7) | (byte & 0x7F)
            if byte < 0x80:
                return value
        raise ConversionError("%s: invalid VLQ at byte %d" % (self.source, start))


class TempoEvent(object):
    def __init__(self, tick, us_per_quarter):
        self.tick = int(tick)
        self.us_per_quarter = int(us_per_quarter)


class RawNoteEvent(object):
    def __init__(
        self,
        tick,
        pitch,
        source_pitch,
        cents,
        velocity,
        track,
        channel,
        program,
        bank_msb,
        bank_lsb,
        order,
    ):
        self.tick = int(tick)
        self.pitch = int(pitch)
        self.source_pitch = int(source_pitch)
        self.cents = float(cents)
        self.velocity = int(velocity)
        self.track = int(track)
        self.channel = int(channel)
        self.program = int(program)
        self.bank_msb = int(bank_msb)
        self.bank_lsb = int(bank_lsb)
        self.order = int(order)


class Note(object):
    def __init__(self, start, end_tick):
        self.start_tick = start.tick
        self.end_tick = max(int(end_tick), start.tick + 1)
        self.pitch = start.pitch
        self.source_pitch = start.source_pitch
        self.cents = start.cents
        self.velocity = start.velocity
        self.track = start.track
        self.channel = start.channel
        self.program = start.program
        self.bank_msb = start.bank_msb
        self.bank_lsb = start.bank_lsb


def clamp(value, minimum, maximum):
    return max(minimum, min(maximum, value))


def decode_midx_offset(payload):
    if not (
        len(payload) == MIDX_PITCHED_OFFSET_PAYLOAD_LEN
        and payload[0] == MIDX_EXPERIMENTAL_MANUFACTURER_ID
        and payload[1:3] == MIDX_NAMESPACE
        and payload[3] == MIDX_PITCHED_OFFSET_RECORD_TYPE
    ):
        return None
    word = (payload[5] << 8) | payload[6]
    magnitude = word & 0x7FFF
    cents = magnitude * MIDX_CENT_RANGE / MIDX_MAGNITUDE_STEPS
    if word & 0x8000:
        cents = -cents
    return payload[4] & 0x7F, cents


def pop_inline_offset(offsets, pitch, tick):
    for index, item in enumerate(offsets):
        if item[0] == tick and item[1] == pitch:
            return offsets.pop(index)[1:]
    if len(offsets) == 1 and offsets[0][0] == tick:
        item = offsets.pop(0)
        return item[1], item[2]
    return None


def normalize_tempos(tempos):
    by_tick = {}
    for tempo in tempos:
        if tempo.tick >= 0 and tempo.us_per_quarter > 0:
            by_tick[tempo.tick] = tempo
    if 0 not in by_tick:
        by_tick[0] = TempoEvent(0, DEFAULT_TEMPO_US_PER_QUARTER)
    return [by_tick[tick] for tick in sorted(by_tick)]


def parse_midx(path):
    with open(path, "rb") as infile:
        reader = ByteReader(infile.read(), path)

    if reader.read(4) != b"MThd":
        raise ConversionError("%s: missing MThd header" % path)
    header_length = reader.read_u32()
    header = ByteReader(reader.read(header_length), path + ":MThd")
    midi_format = header.read_u16()
    track_count = header.read_u16()
    division = header.read_u16()
    if midi_format not in (0, 1):
        raise ConversionError("%s: unsupported MIDI format %d" % (path, midi_format))
    if division & 0x8000:
        raise ConversionError("%s: SMPTE time division is not supported" % path)

    tempos = [TempoEvent(0, DEFAULT_TEMPO_US_PER_QUARTER)]
    raw_notes = []
    order = 0
    tracks_seen = 0

    while tracks_seen < track_count:
        if reader.remaining() < 8:
            raise ConversionError(
                "%s: expected %d tracks, found %d" % (path, track_count, tracks_seen)
            )
        chunk_type = reader.read(4)
        chunk_length = reader.read_u32()
        chunk_data = reader.read(chunk_length)
        if chunk_type != b"MTrk":
            continue

        track_index = tracks_seen
        tracks_seen += 1
        track = ByteReader(chunk_data, "%s:MTrk[%d]" % (path, track_index))
        tick = 0
        running_status = None
        channel_programs = {}
        channel_bank_msb = {}
        channel_bank_lsb = {}
        inline_offsets = []

        while track.remaining() > 0:
            tick += track.read_vlq()
            status_or_data = track.read(1)[0]

            if status_or_data == 0xFF:
                meta_type = track.read(1)[0]
                payload_length = track.read_vlq()
                payload = track.read(payload_length)
                running_status = None
                if meta_type == 0x2F:
                    break
                if meta_type == 0x51 and payload_length == 3:
                    tempos.append(
                        TempoEvent(tick, (payload[0] << 16) | (payload[1] << 8) | payload[2])
                    )
                elif meta_type == MIDX_META_TYPE:
                    decoded = decode_midx_offset(payload)
                    if decoded is None:
                        inline_offsets = []
                    else:
                        pitch, cents = decoded
                        if inline_offsets and inline_offsets[-1][0] != tick:
                            inline_offsets = []
                        inline_offsets.append((tick, pitch, cents))
                else:
                    inline_offsets = []
                continue

            if status_or_data in (0xF0, 0xF7):
                payload_length = track.read_vlq()
                track.read(payload_length)
                running_status = None
                inline_offsets = []
                continue

            if status_or_data >= 0xF0:
                track.read(SYSTEM_EVENT_DATA_LENGTHS.get(status_or_data, 0))
                running_status = None
                inline_offsets = []
                continue

            if status_or_data & 0x80:
                status = status_or_data
                running_status = status
                first_data = None
            else:
                if running_status is None:
                    raise ConversionError(
                        "%s: running status without prior channel status" % track.source
                    )
                status = running_status
                first_data = status_or_data

            event_type = status & 0xF0
            channel = status & 0x0F
            if event_type in (0xC0, 0xD0):
                data1 = track.read(1)[0] if first_data is None else first_data
                if event_type == 0xC0:
                    channel_programs[channel] = data1 & 0x7F
                inline_offsets = []
                continue

            data1 = track.read(1)[0] if first_data is None else first_data
            data2 = track.read(1)[0]
            if event_type == 0xB0:
                if data1 == 0:
                    channel_bank_msb[channel] = data2
                elif data1 == 32:
                    channel_bank_lsb[channel] = data2

            if event_type not in (0x80, 0x90):
                inline_offsets = []
                continue

            velocity = data2 if event_type == 0x90 and data2 > 0 else 0
            effective_pitch = data1
            cents = 0.0
            if velocity > 0:
                if inline_offsets and inline_offsets[-1][0] != tick:
                    inline_offsets = []
                matched = pop_inline_offset(inline_offsets, data1, tick)
                if matched is not None:
                    effective_pitch, cents = matched
            else:
                inline_offsets = []

            raw_notes.append(
                RawNoteEvent(
                    tick,
                    effective_pitch,
                    data1,
                    cents,
                    velocity,
                    track_index,
                    channel,
                    channel_programs.get(channel, 0),
                    channel_bank_msb.get(channel, 0),
                    channel_bank_lsb.get(channel, 0),
                    order,
                )
            )
            order += 1

    return division, normalize_tempos(tempos), raw_notes, "MIDX"


def ump_packet_size(message_type):
    if message_type in (0x0, 0x1, 0x2):
        return 4
    if message_type in (0x3, 0x4):
        return 8
    if message_type in (0x5, 0xD, 0xF):
        return 16
    return 4


def read_u32_at(data, offset):
    return struct.unpack(">I", data[offset:offset + 4])[0]


def scale_16_to_7(value):
    return int(clamp(round((value & 0xFFFF) * 127.0 / 0xFFFF), 0, 127))


def scale_32_to_7(value):
    return int(clamp(round((value & 0xFFFFFFFF) * 127.0 / 0xFFFFFFFF), 0, 127))


def parse_midi2_clip(path):
    with open(path, "rb") as infile:
        data = infile.read()
    if data[:len(MIDI2_CLIP_HEADER)] != MIDI2_CLIP_HEADER:
        raise ConversionError("%s: missing SMF2CLIP header" % path)

    pos = len(MIDI2_CLIP_HEADER)
    tick = 0
    ticks_per_quarter = MIDI2_DEFAULT_TICKS_PER_QUARTER
    tempos = [TempoEvent(0, DEFAULT_TEMPO_US_PER_QUARTER)]
    raw_notes = []
    order = 0
    programs = {}
    bank_msb = {}
    bank_lsb = {}

    while pos < len(data):
        message_type = data[pos] >> 4
        packet_length = ump_packet_size(message_type)
        if pos + packet_length > len(data):
            raise ConversionError("%s: truncated UMP packet at byte %d" % (path, pos))
        packet = data[pos:pos + packet_length]
        pos += packet_length

        if message_type == 0x0:
            utility_status = (packet[1] >> 4) & 0x0F
            if utility_status == 0x3:
                ticks_per_quarter = max(1, (packet[2] << 8) | packet[3])
            elif utility_status == 0x4:
                tick += ((packet[1] & 0x0F) << 16) | (packet[2] << 8) | packet[3]
            continue

        if message_type == 0xD:
            if packet[1:4] == b"\x10\x00\x00":
                ten_ns_per_quarter = read_u32_at(packet, 4)
                if ten_ns_per_quarter:
                    tempos.append(
                        TempoEvent(tick, max(1, int(round(ten_ns_per_quarter / 100.0))))
                    )
            continue

        if message_type != 0x4:
            continue

        group = packet[0] & 0x0F
        status = packet[1]
        event_type = status & 0xF0
        channel = status & 0x0F
        key = (group, channel)

        if event_type == 0xB0:
            controller = packet[2] & 0x7F
            value = scale_32_to_7(read_u32_at(packet, 4))
            if controller == 0:
                bank_msb[key] = value
            elif controller == 32:
                bank_lsb[key] = value
            continue

        if event_type == 0xC0:
            programs[key] = packet[4] & 0x7F
            if packet[3] & 0x01:
                bank_msb[key] = packet[6] & 0x7F
                bank_lsb[key] = packet[7] & 0x7F
            continue

        if event_type not in (0x80, 0x90):
            continue

        source_pitch = packet[2] & 0x7F
        attribute_type = packet[3]
        velocity16 = (packet[4] << 8) | packet[5]
        velocity = scale_16_to_7(velocity16) if event_type == 0x90 and velocity16 else 0
        effective_pitch = source_pitch
        cents = 0.0
        if velocity > 0 and attribute_type == 0x03:
            pitch_value = ((packet[6] << 8) | packet[7]) / 512.0
            effective_pitch = int(clamp(math.floor(pitch_value), 0, 127))
            cents = (pitch_value - effective_pitch) * 100.0

        raw_notes.append(
            RawNoteEvent(
                tick,
                effective_pitch,
                source_pitch,
                cents,
                velocity,
                group,
                channel,
                programs.get(key, 0),
                bank_msb.get(key, 0),
                bank_lsb.get(key, 0),
                order,
            )
        )
        order += 1

    return ticks_per_quarter, normalize_tempos(tempos), raw_notes, "MIDI2"


def parse_input(path):
    with open(path, "rb") as infile:
        header = infile.read(len(MIDI2_CLIP_HEADER))
    if header == MIDI2_CLIP_HEADER:
        return parse_midi2_clip(path)
    return parse_midx(path)


def pair_notes(raw_events, default_duration_ticks):
    active = {}
    notes = []
    events = sorted(
        raw_events,
        key=lambda event: (
            event.tick,
            0 if event.velocity == 0 else 1,
            event.track,
            event.channel,
            event.source_pitch,
            event.order,
        ),
    )
    for event in events:
        key = (event.track, event.channel, event.source_pitch)
        if event.velocity > 0:
            active.setdefault(key, []).append(event)
            continue
        queue = active.get(key)
        if not queue:
            continue
        start = queue.pop(0)
        notes.append(Note(start, event.tick))
        if not queue:
            del active[key]

    for queue in active.values():
        for start in queue:
            notes.append(Note(start, start.tick + default_duration_ticks))
    notes.sort(key=lambda note: (note.start_tick, note.end_tick, note.track, note.pitch))
    return notes


def write_vlq(value):
    value = int(clamp(value, 0, 0x0FFFFFFF))
    out = [value & 0x7F]
    value >>= 7
    while value:
        out.insert(0, (value & 0x7F) | 0x80)
        value >>= 7
    return bytes(out)


def make_track(events):
    track = bytearray()
    previous_tick = 0
    for tick, _order, data in sorted(events, key=lambda event: (event[0], event[1])):
        tick = max(previous_tick, int(tick))
        track.extend(write_vlq(tick - previous_tick))
        track.extend(data)
        previous_tick = tick
    track.extend(b"\x00\xFF\x2F\x00")
    return b"MTrk" + struct.pack(">I", len(track)) + bytes(track)


def pitch_bend_value(cents, bend_range_cents):
    normalized = clamp(float(cents) / float(bend_range_cents), -1.0, 1.0)
    if normalized >= 0:
        value = 8192 + int(round(normalized * 8191.0))
    else:
        value = 8192 + int(round(normalized * 8192.0))
    return int(clamp(value, 0, 16383))


def pitch_bend_message(channel, value):
    return bytes([0xE0 | channel, value & 0x7F, (value >> 7) & 0x7F])


def normalize_note_pitch(pitch, cents, bend_range_cents):
    pitch = int(clamp(pitch, 0, 127))
    cents = float(cents)
    while cents > bend_range_cents and pitch < 127:
        pitch += 1
        cents -= 100.0
    while cents < -bend_range_cents and pitch > 0:
        pitch -= 1
        cents += 100.0
    return pitch, cents


def bend_range_rpn_events(channel, bend_range_semitones):
    whole = int(math.floor(bend_range_semitones))
    cents = int(round((bend_range_semitones - whole) * 100.0))
    if cents >= 100:
        whole += 1
        cents = 0
    whole = int(clamp(whole, 0, 127))
    cents = int(clamp(cents, 0, 99))
    status = 0xB0 | channel
    return (
        bytes([status, 101, 0]),
        bytes([status, 100, 0]),
        bytes([status, 6, whole]),
        bytes([status, 38, cents]),
        bytes([status, 101, 127]),
        bytes([status, 100, 127]),
    )


def build_pitch_bend_midi(notes, ticks_per_quarter, tempos, bend_range_semitones):
    bend_range_semitones = float(bend_range_semitones)
    if not math.isfinite(bend_range_semitones) or not 0.01 <= bend_range_semitones <= 127.99:
        raise ConversionError("pitch-bend range must be between 0.01 and 127.99 semitones")
    bend_range_cents = bend_range_semitones * 100.0

    tempo_events = []
    for index, tempo in enumerate(normalize_tempos(tempos)):
        mpqn = int(clamp(tempo.us_per_quarter, 1, 0xFFFFFF))
        tempo_events.append(
            (
                tempo.tick,
                index,
                bytes([0xFF, 0x51, 0x03, (mpqn >> 16) & 0xFF, (mpqn >> 8) & 0xFF, mpqn & 0xFF]),
            )
        )

    track_name = b"Xen Tuner pitch-bend MIDI"
    note_events = [(0, -1000, bytes([0xFF, 0x03, len(track_name)]) + track_name)]
    for channel in MELODIC_CHANNELS:
        for rpn_order, message in enumerate(bend_range_rpn_events(channel, bend_range_semitones)):
            note_events.append((0, -900 + channel * 10 + rpn_order, message))

    channel_state = {}
    active_by_channel = dict((channel, {}) for channel in MELODIC_CHANNELS)
    active_by_note = {}
    active_heap = []
    used_channels = set()
    channel_steals = 0
    clipped_bends = 0
    percussion_notes = 0
    percussion_offsets_ignored = 0
    event_stride = max(1000, len(notes) * 10 + 100)

    def event_order(phase, note_id=0, suborder=0):
        return phase * event_stride + note_id * 10 + suborder

    def end_note(note_id, channel, tick, order):
        active = active_by_note.pop(note_id, None)
        if active is None or active[0] != channel:
            return
        emitted_pitch = active[1]
        active_note = active_by_channel[channel].get(note_id)
        active_by_channel[channel].pop(note_id, None)
        if active_note is not None and tick <= active_note.start_tick:
            note_on_order = event_order(3, note_id)
            note_events[:] = [
                event
                for event in note_events
                if not (
                    event[0] == active_note.start_tick
                    and event[1] == note_on_order
                    and event[2][0] == (0x90 | channel)
                    and event[2][1] == emitted_pitch
                )
            ]
        else:
            note_events.append((tick, order, bytes([0x80 | channel, emitted_pitch & 0x7F, 0])))

    def channel_has_pitch(channel, emitted_pitch):
        for active_note_id in active_by_channel[channel]:
            active = active_by_note.get(active_note_id)
            if active is not None and active[1] == emitted_pitch:
                return True
        return False

    for note_id, note in enumerate(notes):
        if note.channel == 9:
            emitted_pitch = int(clamp(note.source_pitch, 0, 127))
            note_events.append(
                (
                    note.start_tick,
                    event_order(3, note_id),
                    bytes([0x99, emitted_pitch, int(clamp(note.velocity, 1, 127))]),
                )
            )
            note_events.append(
                (note.end_tick, event_order(0, note_id), bytes([0x89, emitted_pitch, 0]))
            )
            used_channels.add(9)
            percussion_notes += 1
            if note.pitch != note.source_pitch or abs(note.cents) > 0.000001:
                percussion_offsets_ignored += 1
            continue

        while active_heap and active_heap[0][0] <= note.start_tick:
            end_tick, ended_id, channel = heapq.heappop(active_heap)
            end_note(ended_id, channel, end_tick, event_order(0, ended_id))

        emitted_pitch, emitted_cents = normalize_note_pitch(
            note.pitch, note.cents, bend_range_cents
        )
        bend_value = pitch_bend_value(emitted_cents, bend_range_cents)
        if abs(emitted_cents) > bend_range_cents + 0.000001:
            clipped_bends += 1
        state_key = (
            int(clamp(note.bank_msb, 0, 127)),
            int(clamp(note.bank_lsb, 0, 127)),
            int(clamp(note.program, 0, 127)),
            bend_value,
        )

        chosen_channel = None
        for channel in MELODIC_CHANNELS:
            if (
                active_by_channel[channel]
                and channel_state.get(channel) == state_key
                and not channel_has_pitch(channel, emitted_pitch)
            ):
                chosen_channel = channel
                break
        if chosen_channel is None:
            for channel in MELODIC_CHANNELS:
                if not active_by_channel[channel] and channel_state.get(channel) == state_key:
                    chosen_channel = channel
                    break
        if chosen_channel is None:
            for channel in MELODIC_CHANNELS:
                if not active_by_channel[channel]:
                    chosen_channel = channel
                    break

        if chosen_channel is None:
            chosen_channel = min(
                MELODIC_CHANNELS,
                key=lambda channel: max(
                    active_note.end_tick for active_note in active_by_channel[channel].values()
                ),
            )
            for stolen_id in list(active_by_channel[chosen_channel]):
                end_note(stolen_id, chosen_channel, note.start_tick, event_order(0, stolen_id))
                channel_steals += 1

        if channel_state.get(chosen_channel) != state_key:
            bank_msb, bank_lsb, program, unused_bend = state_key
            del unused_bend
            status = 0xB0 | chosen_channel
            base_order = event_order(1, note_id)
            note_events.append((note.start_tick, base_order, bytes([status, 0, bank_msb])))
            note_events.append((note.start_tick, base_order + 1, bytes([status, 32, bank_lsb])))
            note_events.append(
                (note.start_tick, base_order + 2, bytes([0xC0 | chosen_channel, program]))
            )
            channel_state[chosen_channel] = state_key

        note_events.append(
            (
                note.start_tick,
                event_order(2, note_id),
                pitch_bend_message(chosen_channel, bend_value),
            )
        )
        note_events.append(
            (
                note.start_tick,
                event_order(3, note_id),
                bytes(
                    [
                        0x90 | chosen_channel,
                        emitted_pitch & 0x7F,
                        int(clamp(note.velocity, 1, 127)),
                    ]
                ),
            )
        )
        active_by_channel[chosen_channel][note_id] = note
        active_by_note[note_id] = (chosen_channel, emitted_pitch)
        heapq.heappush(active_heap, (note.end_tick, note_id, chosen_channel))
        used_channels.add(chosen_channel)

    while active_heap:
        end_tick, note_id, channel = heapq.heappop(active_heap)
        end_note(note_id, channel, end_tick, event_order(0, note_id))

    last_tick = max([note.end_tick for note in notes] or [0])
    for channel in sorted(used_channels):
        if channel != 9:
            note_events.append((last_tick, event_order(4, channel), pitch_bend_message(channel, 8192)))

    out = bytearray()
    out.extend(b"MThd")
    out.extend(struct.pack(">IHHH", 6, 1, 2, int(clamp(ticks_per_quarter, 1, 0x7FFF))))
    out.extend(make_track(tempo_events))
    out.extend(make_track(note_events))
    return bytes(out), {
        "channels_used": len(used_channels),
        "channel_steals": channel_steals,
        "clipped_bends": clipped_bends,
        "percussion_notes": percussion_notes,
        "percussion_offsets_ignored": percussion_offsets_ignored,
    }


def convert_file(input_path, output_path, bend_range_semitones=2.0):
    ticks_per_quarter, tempos, raw_notes, input_format = parse_input(input_path)
    notes = pair_notes(raw_notes, ticks_per_quarter)
    data, writer_stats = build_pitch_bend_midi(
        notes, ticks_per_quarter, tempos, bend_range_semitones
    )
    output_directory = os.path.dirname(os.path.abspath(output_path))
    temporary = tempfile.NamedTemporaryFile(
        prefix=".%s." % os.path.basename(output_path),
        suffix=".tmp",
        dir=output_directory,
        delete=False,
    )
    temporary_path = temporary.name
    try:
        temporary.write(data)
        temporary.close()
        os.replace(temporary_path, output_path)
    except Exception:
        temporary.close()
        try:
            os.unlink(temporary_path)
        except OSError:
            pass
        raise
    stats = {
        "input_format": input_format,
        "ticks_per_quarter": ticks_per_quarter,
        "raw_note_events": len(raw_notes),
        "notes": len(notes),
        "output_bytes": len(data),
        "output_path": output_path,
        "bend_range_semitones": float(bend_range_semitones),
    }
    stats.update(writer_stats)
    return stats


def default_output_path(input_path):
    stem, _extension = os.path.splitext(input_path)
    return stem + ".pitch-bend.mid"


def main(argv=None):
    parser = argparse.ArgumentParser(
        description="Convert Xen Tuner MIDX or SMF2CLIP MIDI 2.0 to MIDI 1.0 pitch-bend events."
    )
    parser.add_argument("input", help="Input .midx/.midix or .midi2 file")
    parser.add_argument(
        "output",
        nargs="?",
        help="Output .mid file (default: input stem + .pitch-bend.mid)",
    )
    parser.add_argument(
        "--bend-range",
        type=float,
        default=2.0,
        metavar="SEMITONES",
        help="Pitch-bend range configured through RPN 0, default %(default)s",
    )
    args = parser.parse_args(argv)
    output_path = args.output or default_output_path(args.input)
    try:
        stats = convert_file(args.input, output_path, args.bend_range)
    except (ConversionError, OSError, ValueError) as exc:
        parser.exit(1, "error: %s\n" % exc)
    print(
        "converted %s -> %s (%s, notes=%d, channels=%d, steals=%d)"
        % (
            args.input,
            output_path,
            stats["input_format"],
            stats["notes"],
            stats["channels_used"],
            stats["channel_steals"],
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
