#!/usr/bin/env python3
from __future__ import print_function

import binascii
import os
import sys


MIDX_META_TYPE = 0x7F
MIDX_PITCHED_OFFSET_PAYLOAD_LEN = 7
MIDX_EXPERIMENTAL_MANUFACTURER_ID = 0x7D
MIDX_NAMESPACE = b"XT"
MIDX_PITCHED_OFFSET_RECORD_TYPE = 0x03
OFFSET_TICK_TOLERANCE = 2
OFFSET_PITCH_TOLERANCE = 1
OFFSET_GRACE_TICK_TOLERANCE = 64
OFFSET_CENT_RANGE = 64.0
OFFSET_MAGNITUDE_STEPS = 32768.0
DEFAULT_TICKS_PER_QUARTER = 480
DEFAULT_TEMPO_US_PER_QUARTER = 500000
DEFAULT_PITCH_BEND_RANGE_SEMITONES = 2.0
MIDI2_CLIP_HEADER = b"SMF2CLIP"
MIDI2_MAX_DELTA_CLOCKSTAMP = 0xFFFFF
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


def read_job(job_path):
    job = {}
    with open(job_path, "r", encoding="utf-8-sig") as infile:
        for raw_line in infile:
            line = raw_line.rstrip("\n")
            if not line or "=" not in line:
                continue
            key, value = line.split("=", 1)
            job[key] = value
    return job


def log(debug_path, message):
    print(message)
    try:
        with open(debug_path, "ab") as debug_file:
            debug_file.write((message + "\n").encode("utf-8"))
    except Exception:
        pass


def read_vlq(data, index):
    value = 0
    start = index
    for _ in range(4):
        if index >= len(data):
            raise ValueError("unexpected end of track while reading VLQ at %d" % start)
        byte = data[index]
        index += 1
        value = (value << 7) | (byte & 0x7F)
        if byte < 0x80:
            return value, index
    raise ValueError("invalid VLQ at %d" % start)


def write_vlq(value):
    value = int(max(0, min(0x0FFFFFFF, value)))
    out = [value & 0x7F]
    value >>= 7
    while value:
        out.insert(0, (value & 0x7F) | 0x80)
        value >>= 7
    return bytes(out)


def write_u32(value):
    return int(value).to_bytes(4, "big")


def append_u32(out, value):
    out.extend(int(value & 0xFFFFFFFF).to_bytes(4, "big"))


def append_u64_words(out, word1, word2):
    append_u32(out, word1)
    append_u32(out, word2)


def append_u128_words(out, word1, word2, word3, word4):
    append_u32(out, word1)
    append_u32(out, word2)
    append_u32(out, word3)
    append_u32(out, word4)


def parse_int(value, fallback):
    try:
        return int(value)
    except Exception:
        return fallback


def parse_offsets(path):
    offsets = {}
    count = 0
    if not path:
        return offsets, count

    with open(path, "r") as infile:
        for line_number, raw_line in enumerate(infile, 1):
            line = raw_line.strip()
            if not line or line.startswith("#"):
                continue
            parts = line.split(",")
            if len(parts) != 4:
                raise ValueError("%s:%d: expected track,tick,pitch,offset" % (path, line_number))
            track = int(parts[0])
            tick = int(parts[1])
            pitch = int(parts[2])
            offset = int(parts[3])
            offsets.setdefault((track, tick, pitch), []).append(offset)
            count += 1
    return offsets, count


def read_one_byte_event_data(data, index, first_data):
    if first_data is not None:
        return [first_data], index
    if index >= len(data):
        raise ValueError("unexpected end of track while reading 1-byte channel event")
    return [data[index]], index + 1


def read_two_byte_event_data(data, index, first_data):
    if first_data is not None:
        if index >= len(data):
            raise ValueError("unexpected end of track while reading running-status channel event")
        return [first_data, data[index]], index + 1
    if index + 2 > len(data):
        raise ValueError("unexpected end of track while reading 2-byte channel event")
    return [data[index], data[index + 1]], index + 2


def read_system_event_data(data, index, status):
    data_len = SYSTEM_EVENT_DATA_LENGTHS.get(status, 0)
    if index + data_len > len(data):
        raise ValueError("unexpected end of track while reading system event")
    return list(data[index:index + data_len]), index + data_len


def pop_offset(offsets, track_index, tick, pitch):
    exact_key = (track_index, tick, pitch)
    queue = offsets.get(exact_key)
    if queue:
        key = exact_key
        match_kind = "exact"
    else:
        key, match_kind = find_nearby_offset_key(offsets, track_index, tick, pitch)
        queue = offsets.get(key) if key is not None else None
    if not queue:
        return None, None, None
    value = queue.pop(0)
    if not queue:
        del offsets[key]
    return value, match_kind, key


def find_unique_candidate(offsets, predicate):
    found_key = None
    for key, values in offsets.items():
        if not values:
            continue
        if predicate(key):
            if found_key is not None:
                return None
            found_key = key
    return found_key


def find_nearby_offset_key(offsets, track_index, tick, pitch):
    key = find_unique_candidate(
        offsets,
        lambda item: item[0] == track_index
        and item[2] == pitch
        and abs(item[1] - tick) <= OFFSET_TICK_TOLERANCE,
    )
    if key is not None:
        return key, "near_tick"

    key = find_unique_candidate(
        offsets,
        lambda item: item[0] == track_index
        and item[1] == tick
        and abs(item[2] - pitch) <= OFFSET_PITCH_TOLERANCE,
    )
    if key is not None:
        return key, "near_pitch"

    key = find_unique_candidate(
        offsets,
        lambda item: item[0] == track_index
        and abs(item[1] - tick) <= OFFSET_GRACE_TICK_TOLERANCE
        and abs(item[2] - pitch) <= OFFSET_PITCH_TOLERANCE,
    )
    if key is not None:
        return key, "near_tick_pitch"

    return None, None


def read_channel_event(data, index, running_status, status_or_data):
    if status_or_data & 0x80:
        status = status_or_data
        running_status = status
        first_data = None
    else:
        if running_status is None:
            raise ValueError("running status without prior status while scanning track")
        status = running_status
        first_data = status_or_data

    event_type = status & 0xF0
    if event_type in (0xC0, 0xD0):
        event_data, index = read_one_byte_event_data(data, index, first_data)
    else:
        event_data, index = read_two_byte_event_data(data, index, first_data)
    return status, event_type, event_data, index, running_status


def collect_note_on_index(track_data_by_index):
    note_index = {}
    track_note_counts = {}
    for track_index, track_data in track_data_by_index.items():
        index = 0
        tick = 0
        running_status = None
        counts = {}
        while index < len(track_data):
            delta, index = read_vlq(track_data, index)
            tick += delta
            if index >= len(track_data):
                break
            status_or_data = track_data[index]
            index += 1

            if status_or_data == 0xFF:
                meta_type = track_data[index]
                index += 1
                payload_len, index = read_vlq(track_data, index)
                index += payload_len
                if meta_type == 0x2F:
                    break
                continue

            if status_or_data in (0xF0, 0xF7):
                payload_len, index = read_vlq(track_data, index)
                index += payload_len
                running_status = None
                continue

            if status_or_data >= 0xF0:
                _event_data, index = read_system_event_data(track_data, index, status_or_data)
                running_status = None
                continue

            _status, event_type, event_data, index, running_status = read_channel_event(
                track_data,
                index,
                running_status,
                status_or_data,
            )
            if event_type == 0x90 and event_data[1] > 0:
                key = (tick, event_data[0])
                counts[key] = counts.get(key, 0) + 1
                note_index[(track_index, tick, event_data[0])] = note_index.get((track_index, tick, event_data[0]), 0) + 1
        track_note_counts[track_index] = counts
    return note_index, track_note_counts


def remap_offsets_to_native_tracks(offsets, track_note_counts, stats):
    if not offsets:
        stats["track_map"] = {}
        return offsets

    offset_counts_by_track = {}
    for (track, tick, pitch), values in offsets.items():
        offset_counts_by_track.setdefault(track, {})
        key = (tick, pitch)
        offset_counts_by_track[track][key] = offset_counts_by_track[track].get(key, 0) + len(values)

    track_map = {}
    for offset_track, offset_counts in offset_counts_by_track.items():
        best_track = offset_track
        best_score = -1
        best_total = 0
        for native_track, native_counts in track_note_counts.items():
            score = 0
            total = 0
            for key, count in offset_counts.items():
                total += count
                score += min(count, native_counts.get(key, 0))
            if score > best_score:
                best_score = score
                best_track = native_track
                best_total = total
        direct_score = 0
        direct_counts = track_note_counts.get(offset_track, {})
        for key, count in offset_counts.items():
            direct_score += min(count, direct_counts.get(key, 0))
        if best_score > direct_score and best_score > 0:
            track_map[offset_track] = best_track
        else:
            track_map[offset_track] = offset_track
        stats.setdefault("track_map_scores", []).append((offset_track, track_map[offset_track], best_score, best_total, direct_score))

    remapped = {}
    for (track, tick, pitch), values in offsets.items():
        mapped_track = track_map.get(track, track)
        remapped.setdefault((mapped_track, tick, pitch), []).extend(values)
    stats["track_map"] = track_map
    return remapped


def decode_cent_offset(offset_word):
    sign = -1.0 if (int(offset_word) & 0x8000) else 1.0
    magnitude = int(offset_word) & 0x7FFF
    return sign * (float(magnitude) / OFFSET_MAGNITUDE_STEPS) * OFFSET_CENT_RANGE


def scale_up_7_to_16(value):
    value = int(max(0, min(127, value)))
    shifted = value << 9
    if value <= 64:
        return shifted
    repeat = value & 0x3F
    return shifted | (repeat << 3) | (repeat >> 3)


def scale_up_7_to_32(value):
    return int(round(scale_up_7_to_16(value) * (0xFFFFFFFF / 0xFFFF))) & 0xFFFFFFFF


def scale_pitch_bend_14_to_32(lsb, msb):
    value = ((int(msb) & 0x7F) << 7) | (int(lsb) & 0x7F)
    return int(round(value * (0xFFFFFFFF / 0x3FFF))) & 0xFFFFFFFF


def pitch_to_q7_9(pitch, cents):
    value = float(pitch) + (float(cents) / 100.0)
    if value < 0.0:
        value = 0.0
    if value > 127.998:
        value = 127.998
    encoded = int(round(value * 512.0))
    return max(0, min(0xFFFF, encoded))


def append_dctpq(out, ticks_per_quarter):
    ticks_per_quarter = int(max(1, min(0xFFFF, ticks_per_quarter)))
    append_u32(out, 0x00300000 | ticks_per_quarter)


def append_delta_clockstamp(out, delta):
    delta = int(max(0, delta))
    while delta > MIDI2_MAX_DELTA_CLOCKSTAMP:
        append_u32(out, 0x00400000 | MIDI2_MAX_DELTA_CLOCKSTAMP)
        append_u32(out, 0x00000000)
        delta -= MIDI2_MAX_DELTA_CLOCKSTAMP
    append_u32(out, 0x00400000 | delta)


def append_start_of_clip(out):
    append_u128_words(out, 0xF0200000, 0x00000000, 0x00000000, 0x00000000)


def append_end_of_clip(out):
    append_u128_words(out, 0xF0210000, 0x00000000, 0x00000000, 0x00000000)


def append_midi2_note(out, group, channel, status_nibble, note, velocity7, attribute_type, attribute_value):
    word1 = (
        (0x4 << 28)
        | ((group & 0x0F) << 24)
        | (((status_nibble & 0x0F) << 4 | (channel & 0x0F)) << 16)
        | ((note & 0x7F) << 8)
        | (attribute_type & 0xFF)
    )
    word2 = ((scale_up_7_to_16(velocity7) & 0xFFFF) << 16) | (attribute_value & 0xFFFF)
    append_u64_words(out, word1, word2)


def append_midi2_control_change(out, group, channel, controller, value7):
    word1 = (
        (0x4 << 28)
        | ((group & 0x0F) << 24)
        | ((0xB0 | (channel & 0x0F)) << 16)
        | ((controller & 0x7F) << 8)
    )
    append_u64_words(out, word1, scale_up_7_to_32(value7))


def append_midi2_program_change(out, group, channel, program, bank_msb, bank_lsb, bank_valid):
    options = 0x01 if bank_valid else 0x00
    word1 = (
        (0x4 << 28)
        | ((group & 0x0F) << 24)
        | ((0xC0 | (channel & 0x0F)) << 16)
        | (options & 0xFF)
    )
    word2 = ((program & 0x7F) << 24) | ((bank_msb & 0x7F) << 8) | (bank_lsb & 0x7F)
    append_u64_words(out, word1, word2)


def append_midi2_channel_pressure(out, group, channel, value7):
    word1 = (0x4 << 28) | ((group & 0x0F) << 24) | ((0xD0 | (channel & 0x0F)) << 16)
    append_u64_words(out, word1, scale_up_7_to_32(value7))


def append_midi2_pitch_bend(out, group, channel, lsb, msb):
    word1 = (0x4 << 28) | ((group & 0x0F) << 24) | ((0xE0 | (channel & 0x0F)) << 16)
    append_u64_words(out, word1, scale_pitch_bend_14_to_32(lsb, msb))


def append_midi2_poly_pressure(out, group, channel, note, value7):
    word1 = (
        (0x4 << 28)
        | ((group & 0x0F) << 24)
        | ((0xA0 | (channel & 0x0F)) << 16)
        | ((note & 0x7F) << 8)
    )
    append_u64_words(out, word1, scale_up_7_to_32(value7))


def append_flex_set_tempo(out, group, us_per_quarter):
    ten_ns_per_quarter = int(round(float(us_per_quarter) * 100.0))
    word1 = (0xD << 28) | ((group & 0x0F) << 24) | (0x10 << 16)
    append_u128_words(out, word1, ten_ns_per_quarter & 0xFFFFFFFF, 0x00000000, 0x00000000)


def append_midi2_system_common(out, group, status, event_data):
    b2 = event_data[0] if len(event_data) > 0 else 0
    b3 = event_data[1] if len(event_data) > 1 else 0
    word = (0x1 << 28) | ((group & 0x0F) << 24) | ((status & 0xFF) << 16) | ((b2 & 0x7F) << 8) | (b3 & 0x7F)
    append_u32(out, word)


def append_offset_extension(out, delta, pitch, offset_word):
    out.extend(write_vlq(delta))
    out.extend(bytes([0xFF, MIDX_META_TYPE, MIDX_PITCHED_OFFSET_PAYLOAD_LEN]))
    out.append(MIDX_EXPERIMENTAL_MANUFACTURER_ID)
    out.extend(MIDX_NAMESPACE)
    out.append(MIDX_PITCHED_OFFSET_RECORD_TYPE)
    out.append(int(pitch) & 0x7F)
    out.extend(int(offset_word).to_bytes(2, "big"))


def collect_midi2_events(track_data_by_index, offsets, stats):
    events = []
    order = 0
    tempo_count = 0

    for track_index in sorted(track_data_by_index):
        track_data = track_data_by_index[track_index]
        index = 0
        tick = 0
        running_status = None
        bank_msb = [None] * 16
        bank_lsb = [None] * 16

        while index < len(track_data):
            delta, index = read_vlq(track_data, index)
            tick += delta
            if index >= len(track_data):
                break
            status_or_data = track_data[index]
            index += 1

            if status_or_data == 0xFF:
                if index >= len(track_data):
                    raise ValueError("unexpected end of track after meta status while making MIDI2")
                meta_type = track_data[index]
                index += 1
                payload_len, index = read_vlq(track_data, index)
                payload = track_data[index:index + payload_len]
                if len(payload) != payload_len:
                    raise ValueError("unexpected end of track in meta payload while making MIDI2")
                index += payload_len
                if meta_type == 0x51 and payload_len == 3:
                    us_per_quarter = (payload[0] << 16) | (payload[1] << 8) | payload[2]
                    events.append((tick, order, "tempo", (us_per_quarter,)))
                    order += 1
                    tempo_count += 1
                if meta_type == 0x2F:
                    break
                continue

            if status_or_data in (0xF0, 0xF7):
                payload_len, index = read_vlq(track_data, index)
                payload = track_data[index:index + payload_len]
                if len(payload) != payload_len:
                    raise ValueError("unexpected end of track in sysex payload while making MIDI2")
                index += payload_len
                running_status = None
                stats["midi2_sysex_skipped"] = stats.get("midi2_sysex_skipped", 0) + 1
                continue

            if status_or_data >= 0xF0:
                event_data, index = read_system_event_data(track_data, index, status_or_data)
                events.append((tick, order, "system_common", (0, status_or_data, event_data)))
                order += 1
                running_status = None
                stats["midi2_system_common"] = stats.get("midi2_system_common", 0) + 1
                continue

            status, event_type, event_data, index, running_status = read_channel_event(
                track_data,
                index,
                running_status,
                status_or_data,
            )

            channel = status & 0x0F
            group = 0

            if event_type == 0x80 or event_type == 0x90:
                note = event_data[0]
                velocity = event_data[1]
                if event_type == 0x90 and velocity > 0:
                    offset, match_kind, offset_key = pop_offset(offsets, track_index, tick, note)
                    if match_kind:
                        stats["midi2_offset_match_" + match_kind] = stats.get("midi2_offset_match_" + match_kind, 0) + 1
                    if offset is not None:
                        effective_note = offset_key[2] if offset_key is not None else note
                        cents = decode_cent_offset(offset)
                        events.append((tick, order, "note_on_pitch", (group, channel, note, velocity, effective_note, cents)))
                        stats["midi2_pitch_attributes"] = stats.get("midi2_pitch_attributes", 0) + 1
                    else:
                        events.append((tick, order, "note_on", (group, channel, note, velocity)))
                    stats["midi2_note_on"] = stats.get("midi2_note_on", 0) + 1
                else:
                    events.append((tick, order, "note_off", (group, channel, note, velocity)))
                    stats["midi2_note_off"] = stats.get("midi2_note_off", 0) + 1
                order += 1
                continue

            if event_type == 0xB0:
                controller = event_data[0]
                value = event_data[1]
                if controller == 0:
                    bank_msb[channel] = value
                    stats["midi2_bank_select_msb"] = stats.get("midi2_bank_select_msb", 0) + 1
                elif controller == 32:
                    bank_lsb[channel] = value
                    stats["midi2_bank_select_lsb"] = stats.get("midi2_bank_select_lsb", 0) + 1
                else:
                    events.append((tick, order, "control_change", (group, channel, controller, value)))
                    order += 1
                    stats["midi2_control_change"] = stats.get("midi2_control_change", 0) + 1
                continue

            if event_type == 0xC0:
                program = event_data[0]
                has_bank = bank_msb[channel] is not None or bank_lsb[channel] is not None
                events.append((
                    tick,
                    order,
                    "program_change",
                    (
                        group,
                        channel,
                        program,
                        bank_msb[channel] if bank_msb[channel] is not None else 0,
                        bank_lsb[channel] if bank_lsb[channel] is not None else 0,
                        has_bank,
                    ),
                ))
                order += 1
                stats["midi2_program_change"] = stats.get("midi2_program_change", 0) + 1
                continue

            if event_type == 0xA0:
                events.append((tick, order, "poly_pressure", (group, channel, event_data[0], event_data[1])))
                order += 1
                stats["midi2_poly_pressure"] = stats.get("midi2_poly_pressure", 0) + 1
                continue

            if event_type == 0xD0:
                events.append((tick, order, "channel_pressure", (group, channel, event_data[0])))
                order += 1
                stats["midi2_channel_pressure"] = stats.get("midi2_channel_pressure", 0) + 1
                continue

            if event_type == 0xE0:
                events.append((tick, order, "pitch_bend", (group, channel, event_data[0], event_data[1])))
                order += 1
                stats["midi2_pitch_bend"] = stats.get("midi2_pitch_bend", 0) + 1
                continue

            stats["midi2_channel_skipped"] = stats.get("midi2_channel_skipped", 0) + 1

    if tempo_count == 0:
        events.insert(0, (0, -1, "tempo", (DEFAULT_TEMPO_US_PER_QUARTER,)))
    return sorted(events, key=lambda item: (item[0], item[1]))


def append_midi2_event(out, event_kind, payload):
    if event_kind == "tempo":
        append_flex_set_tempo(out, 0, payload[0])
    elif event_kind == "note_on_pitch":
        group, channel, note, velocity, effective_note, cents = payload
        append_midi2_note(out, group, channel, 0x9, note, velocity, 0x03, pitch_to_q7_9(effective_note, cents))
    elif event_kind == "note_on":
        group, channel, note, velocity = payload
        append_midi2_note(out, group, channel, 0x9, note, velocity, 0x00, 0x0000)
    elif event_kind == "note_off":
        group, channel, note, velocity = payload
        append_midi2_note(out, group, channel, 0x8, note, velocity, 0x00, 0x0000)
    elif event_kind == "control_change":
        append_midi2_control_change(out, payload[0], payload[1], payload[2], payload[3])
    elif event_kind == "program_change":
        append_midi2_program_change(out, payload[0], payload[1], payload[2], payload[3], payload[4], payload[5])
    elif event_kind == "poly_pressure":
        append_midi2_poly_pressure(out, payload[0], payload[1], payload[2], payload[3])
    elif event_kind == "channel_pressure":
        append_midi2_channel_pressure(out, payload[0], payload[1], payload[2])
    elif event_kind == "pitch_bend":
        append_midi2_pitch_bend(out, payload[0], payload[1], payload[2], payload[3])
    elif event_kind == "system_common":
        append_midi2_system_common(out, payload[0], payload[1], payload[2])


def write_midi2_from_native(native_midi_path, offset_path, midi2_output_path, ticks_per_quarter, debug_path):
    offsets, offset_count = parse_offsets(offset_path)
    with open(native_midi_path, "rb") as infile:
        data = infile.read()

    if data[0:4] != b"MThd":
        raise ValueError("native MIDI input is missing MThd while making MIDI2: %s" % native_midi_path)

    pos = 4
    header_len = int.from_bytes(data[pos:pos + 4], "big")
    pos += 4
    header = data[pos:pos + header_len]
    pos += header_len
    if len(header) < 6:
        raise ValueError("invalid MIDI header length while making MIDI2: %d" % header_len)

    if not ticks_per_quarter:
        division = int.from_bytes(header[4:6], "big")
        if division & 0x8000:
            ticks_per_quarter = DEFAULT_TICKS_PER_QUARTER
        else:
            ticks_per_quarter = division
    ticks_per_quarter = int(max(1, min(0xFFFF, ticks_per_quarter)))

    tracks_seen = 0
    track_data_by_index = {}
    while pos < len(data):
        if pos + 8 > len(data):
            raise ValueError("trailing bytes after MIDI chunks at %d while making MIDI2" % pos)
        chunk_type = data[pos:pos + 4]
        pos += 4
        chunk_len = int.from_bytes(data[pos:pos + 4], "big")
        pos += 4
        chunk_data = data[pos:pos + chunk_len]
        pos += chunk_len
        if len(chunk_data) != chunk_len:
            raise ValueError("unexpected end of file in chunk %r while making MIDI2" % chunk_type)
        if chunk_type == b"MTrk":
            track_data_by_index[tracks_seen] = chunk_data
            tracks_seen += 1

    stats = {
        "midi2_note_on": 0,
        "midi2_note_off": 0,
        "midi2_pitch_attributes": 0,
        "midi2_program_change": 0,
        "midi2_control_change": 0,
        "midi2_pitch_bend": 0,
        "midi2_channel_pressure": 0,
        "midi2_poly_pressure": 0,
        "midi2_system_common": 0,
        "midi2_sysex_skipped": 0,
        "midi2_channel_skipped": 0,
    }
    _note_index, track_note_counts = collect_note_on_index(track_data_by_index)
    offsets = remap_offsets_to_native_tracks(offsets, track_note_counts, stats)
    events = collect_midi2_events(track_data_by_index, offsets, stats)

    out = bytearray()
    out.extend(MIDI2_CLIP_HEADER)
    append_delta_clockstamp(out, 0)
    append_dctpq(out, ticks_per_quarter)
    append_delta_clockstamp(out, 0)
    append_start_of_clip(out)

    prev_tick = 0
    for tick, _order, event_kind, payload in events:
        tick = int(max(0, tick))
        append_delta_clockstamp(out, tick - prev_tick)
        append_midi2_event(out, event_kind, payload)
        prev_tick = tick

    append_delta_clockstamp(out, 0)
    append_end_of_clip(out)

    with open(midi2_output_path, "wb") as outfile:
        outfile.write(bytes(out))

    unmatched = sum(len(values) for values in offsets.values())
    unmatched_examples = []
    for key in sorted(offsets.keys())[:12]:
        unmatched_examples.append("%d:%d:%d x%d" % (key[0], key[1], key[2], len(offsets[key])))

    log(debug_path, "MIDI2_OUTPUT_PATH=%s" % midi2_output_path)
    log(debug_path, "MIDI2_OUTPUT_SIZE=%d" % len(out))
    log(debug_path, "MIDI2_TICKS_PER_QUARTER=%d" % ticks_per_quarter)
    log(debug_path, "MIDI2_SOURCE_BYTES=%d" % len(data))
    log(debug_path, "MIDI2_TRACKS_SEEN=%d" % tracks_seen)
    log(debug_path, "MIDI2_SOURCE_EVENTS=%d" % len(events))
    log(debug_path, "MIDI2_OFFSET_RECORDS=%d" % offset_count)
    log(debug_path, "MIDI2_OFFSETS_APPLIED=%d" % stats.get("midi2_pitch_attributes", 0))
    log(debug_path, "MIDI2_OFFSETS_UNMATCHED=%d" % unmatched)
    if unmatched_examples:
        log(debug_path, "MIDI2_OFFSETS_UNMATCHED_EXAMPLES=%s" % ", ".join(unmatched_examples))
    for key in sorted(stats):
        if key.startswith("midi2_"):
            log(debug_path, "%s=%s" % (key.upper(), stats[key]))


def inject_track(track_data, track_index, offsets, stats):
    out = bytearray()
    index = 0
    tick = 0
    running_status = None

    while index < len(track_data):
        delta, index = read_vlq(track_data, index)
        tick += delta
        if index >= len(track_data):
            raise ValueError("unexpected end of track after delta")

        status_or_data = track_data[index]
        index += 1

        if status_or_data == 0xFF:
            if index >= len(track_data):
                raise ValueError("unexpected end of track after meta status")
            meta_type = track_data[index]
            index += 1
            payload_len, index = read_vlq(track_data, index)
            payload = track_data[index:index + payload_len]
            if len(payload) != payload_len:
                raise ValueError("unexpected end of track in meta payload")
            index += payload_len
            out.extend(write_vlq(delta))
            out.extend(bytes([0xFF, meta_type]))
            out.extend(write_vlq(payload_len))
            out.extend(payload)
            stats["meta_events"] += 1
            continue

        if status_or_data in (0xF0, 0xF7):
            payload_len, index = read_vlq(track_data, index)
            payload = track_data[index:index + payload_len]
            if len(payload) != payload_len:
                raise ValueError("unexpected end of track in sysex payload")
            index += payload_len
            out.extend(write_vlq(delta))
            out.append(status_or_data)
            out.extend(write_vlq(payload_len))
            out.extend(payload)
            running_status = None
            stats["sysex_events"] += 1
            continue

        if status_or_data >= 0xF0:
            event_data, index = read_system_event_data(track_data, index, status_or_data)
            out.extend(write_vlq(delta))
            out.append(status_or_data)
            out.extend(bytes(event_data))
            running_status = None
            stats["system_events"] = stats.get("system_events", 0) + 1
            continue

        status, event_type, event_data, index, running_status = read_channel_event(
            track_data,
            index,
            running_status,
            status_or_data,
        )

        offset = None
        extension_pitch = None
        if event_type in (0x80, 0x90):
            pitch = event_data[0]
            velocity = event_data[1] if event_type == 0x90 else 0
            if velocity > 0:
                offset, match_kind, offset_key = pop_offset(offsets, track_index, tick, pitch)
                if match_kind:
                    stats["offset_match_" + match_kind] = stats.get("offset_match_" + match_kind, 0) + 1
                if offset_key is not None:
                    extension_pitch = offset_key[2]
                    if extension_pitch != pitch:
                        stats["offset_pitch_overrides"] = stats.get("offset_pitch_overrides", 0) + 1
                        examples = stats.setdefault("offset_pitch_override_examples", [])
                        if len(examples) < 12:
                            examples.append(
                                "%d:%d native=%d midx=%d match=%s"
                                % (track_index, tick, pitch, extension_pitch, match_kind or "")
                            )

        if offset is not None:
            append_offset_extension(out, delta, extension_pitch if extension_pitch is not None else pitch, offset)
            out.extend(write_vlq(0))
            stats["offsets_injected"] += 1
        else:
            out.extend(write_vlq(delta))

        out.append(status)
        out.extend(bytes(event_data))
        stats["channel_events"] += 1

    return bytes(out)


def inject_midx(native_midi_path, offset_path, output_path, debug_path):
    offsets, offset_count = parse_offsets(offset_path)
    with open(native_midi_path, "rb") as infile:
        data = infile.read()

    if data[0:4] != b"MThd":
        raise ValueError("native MIDI input is missing MThd: %s" % native_midi_path)

    pos = 4
    header_len = int.from_bytes(data[pos:pos + 4], "big")
    pos += 4
    header = data[pos:pos + header_len]
    pos += header_len
    if len(header) < 6:
        raise ValueError("invalid MIDI header length: %d" % header_len)
    track_count = int.from_bytes(header[2:4], "big")

    out = bytearray()
    out.extend(b"MThd")
    out.extend(write_u32(header_len))
    out.extend(header)

    stats = {
        "channel_events": 0,
        "meta_events": 0,
        "sysex_events": 0,
        "system_events": 0,
        "offsets_injected": 0,
        "offset_match_exact": 0,
        "offset_match_near_tick": 0,
        "offset_match_near_pitch": 0,
        "offset_match_near_tick_pitch": 0,
        "offset_pitch_overrides": 0,
        "offset_pitch_override_examples": [],
        "track_map_scores": [],
    }

    tracks_seen = 0
    chunks = []
    track_data_by_index = {}
    while pos < len(data):
        if pos + 8 > len(data):
            raise ValueError("trailing bytes after MIDI chunks at %d" % pos)
        chunk_type = data[pos:pos + 4]
        pos += 4
        chunk_len = int.from_bytes(data[pos:pos + 4], "big")
        pos += 4
        chunk_data = data[pos:pos + chunk_len]
        pos += chunk_len
        if len(chunk_data) != chunk_len:
            raise ValueError("unexpected end of file in chunk %r" % chunk_type)

        if chunk_type == b"MTrk":
            track_data_by_index[tracks_seen] = chunk_data
            chunks.append((chunk_type, chunk_data, tracks_seen))
            tracks_seen += 1
        else:
            chunks.append((chunk_type, chunk_data, None))

    _note_index, track_note_counts = collect_note_on_index(track_data_by_index)
    offsets = remap_offsets_to_native_tracks(offsets, track_note_counts, stats)

    for chunk_type, chunk_data, track_index in chunks:
        if chunk_type == b"MTrk":
            new_track = inject_track(chunk_data, track_index, offsets, stats)
            out.extend(chunk_type)
            out.extend(write_u32(len(new_track)))
            out.extend(new_track)
        else:
            out.extend(chunk_type)
            out.extend(write_u32(len(chunk_data)))
            out.extend(chunk_data)

    with open(output_path, "wb") as outfile:
        outfile.write(bytes(out))

    unmatched = sum(len(values) for values in offsets.values())
    unmatched_examples = []
    for key in sorted(offsets.keys())[:12]:
        unmatched_examples.append("%d:%d:%d x%d" % (key[0], key[1], key[2], len(offsets[key])))
    log(debug_path, "NATIVE_MIDI_BYTES=%d" % len(data))
    log(debug_path, "OUTPUT_SIZE=%d" % len(out))
    log(debug_path, "HEADER_TRACKS=%d" % track_count)
    log(debug_path, "TRACKS_SEEN=%d" % tracks_seen)
    log(debug_path, "OFFSET_RECORDS=%d" % offset_count)
    log(debug_path, "OFFSETS_INJECTED=%d" % stats["offsets_injected"])
    log(debug_path, "OFFSETS_UNMATCHED=%d" % unmatched)
    log(debug_path, "OFFSET_MATCH_EXACT=%d" % stats.get("offset_match_exact", 0))
    log(debug_path, "OFFSET_MATCH_NEAR_TICK=%d" % stats.get("offset_match_near_tick", 0))
    log(debug_path, "OFFSET_MATCH_NEAR_PITCH=%d" % stats.get("offset_match_near_pitch", 0))
    log(debug_path, "OFFSET_MATCH_NEAR_TICK_PITCH=%d" % stats.get("offset_match_near_tick_pitch", 0))
    log(debug_path, "OFFSET_PITCH_OVERRIDES=%d" % stats.get("offset_pitch_overrides", 0))
    if stats.get("offset_pitch_override_examples"):
        log(debug_path, "OFFSET_PITCH_OVERRIDE_EXAMPLES=%s" % ", ".join(stats["offset_pitch_override_examples"]))
    if stats.get("track_map"):
        log(debug_path, "OFFSET_TRACK_MAP=%s" % ", ".join("%s->%s" % (key, stats["track_map"][key]) for key in sorted(stats["track_map"])))
    if stats.get("track_map_scores"):
        log(debug_path, "OFFSET_TRACK_MAP_SCORES=%s" % ", ".join("%s->%s score=%s/%s direct=%s" % item for item in stats["track_map_scores"][:12]))
    if unmatched_examples:
        log(debug_path, "OFFSETS_UNMATCHED_EXAMPLES=%s" % ", ".join(unmatched_examples))
    log(debug_path, "CHANNEL_EVENTS=%d" % stats["channel_events"])
    log(debug_path, "META_EVENTS=%d" % stats["meta_events"])
    log(debug_path, "SYSEX_EVENTS=%d" % stats["sysex_events"])
    log(debug_path, "SYSTEM_EVENTS=%d" % stats.get("system_events", 0))


def write_hex_payload(hex_path, output_path, debug_path):
    log(debug_path, "HEX_EXISTS=%s" % os.path.exists(hex_path))
    if os.path.exists(hex_path):
        log(debug_path, "HEX_SIZE=%d" % os.path.getsize(hex_path))
    with open(hex_path, "rb") as infile:
        hex_data = b"".join(infile.read().split())
    log(debug_path, "HEX_DIGITS=%d" % len(hex_data))
    data = binascii.unhexlify(hex_data)
    log(debug_path, "BINARY_BYTES=%d" % len(data))
    with open(output_path, "wb") as outfile:
        outfile.write(data)
    log(debug_path, "OUTPUT_EXISTS=%s" % os.path.exists(output_path))
    if os.path.exists(output_path):
        log(debug_path, "OUTPUT_SIZE=%d" % os.path.getsize(output_path))
    log(debug_path, "WROTE %d bytes to %s" % (len(data), output_path))


def write_pitch_bend_midi(input_path, output_path, bend_range_semitones, debug_path):
    script_dir = os.path.dirname(os.path.abspath(__file__))
    if script_dir not in sys.path:
        sys.path.insert(0, script_dir)
    from midx_pitch_bend_converter import convert_file

    stats = convert_file(input_path, output_path, bend_range_semitones)
    log(debug_path, "PITCH_BEND_OUTPUT_PATH=%s" % output_path)
    log(debug_path, "PITCH_BEND_OUTPUT_SIZE=%d" % stats["output_bytes"])
    log(debug_path, "PITCH_BEND_INPUT_FORMAT=%s" % stats["input_format"])
    log(debug_path, "PITCH_BEND_NOTES=%d" % stats["notes"])
    log(debug_path, "PITCH_BEND_CHANNELS_USED=%d" % stats["channels_used"])
    log(debug_path, "PITCH_BEND_CHANNEL_STEALS=%d" % stats["channel_steals"])
    log(debug_path, "PITCH_BEND_CLIPPED=%d" % stats["clipped_bends"])
    log(debug_path, "PITCH_BEND_PERCUSSION_NOTES=%d" % stats["percussion_notes"])
    log(debug_path, "PITCH_BEND_PERCUSSION_OFFSETS_IGNORED=%d" % stats["percussion_offsets_ignored"])
    log(debug_path, "PITCH_BEND_RANGE_SEMITONES=%s" % bend_range_semitones)
    return stats


def remove_if_exists(path):
    if path and os.path.exists(path):
        os.unlink(path)


def staged_path(path):
    return path + ".xen-tuner.tmp"


def commit_staged_outputs(outputs, completion_path, pitch_bend_stats):
    for temporary_path, output_path, expected_header in outputs:
        if not os.path.exists(temporary_path):
            raise ValueError("staged output is missing: %s" % temporary_path)
        if os.path.getsize(temporary_path) <= len(expected_header):
            raise ValueError("staged output is empty or truncated: %s" % temporary_path)
        with open(temporary_path, "rb") as infile:
            if infile.read(len(expected_header)) != expected_header:
                raise ValueError("staged output has an invalid header: %s" % temporary_path)

    transaction_id = binascii.hexlify(os.urandom(8)).decode("ascii")
    backups = []
    committed = []
    try:
        for _temporary_path, output_path, _expected_header in outputs:
            backup_path = output_path + ".xen-tuner.backup." + transaction_id
            if os.path.exists(output_path):
                os.replace(output_path, backup_path)
                backups.append((backup_path, output_path))
            else:
                backups.append((None, output_path))

        for temporary_path, output_path, _expected_header in outputs:
            os.replace(temporary_path, output_path)
            committed.append(output_path)

        write_completion_file(completion_path, pitch_bend_stats)
    except BaseException:
        try:
            remove_if_exists(completion_path)
        except OSError:
            pass
        for output_path in committed:
            try:
                remove_if_exists(output_path)
            except OSError:
                pass
        for backup_path, output_path in backups:
            if backup_path and os.path.exists(backup_path):
                try:
                    os.replace(backup_path, output_path)
                except OSError:
                    pass
        raise
    else:
        for backup_path, _output_path in backups:
            try:
                remove_if_exists(backup_path)
            except OSError:
                pass


def write_completion_file(path, pitch_bend_stats):
    if not path:
        return
    temporary_path = path + ".tmp"
    remove_if_exists(temporary_path)
    try:
        with open(temporary_path, "w", encoding="utf-8", newline="\n") as outfile:
            outfile.write("status=ok\n")
            if pitch_bend_stats:
                for key in (
                    "notes",
                    "channels_used",
                    "channel_steals",
                    "clipped_bends",
                    "percussion_notes",
                    "percussion_offsets_ignored",
                ):
                    outfile.write("pitch_bend_%s=%s\n" % (key, pitch_bend_stats.get(key, 0)))
        os.replace(temporary_path, path)
    finally:
        remove_if_exists(temporary_path)


def main():
    script_dir = os.path.dirname(os.path.abspath(__file__))
    if len(sys.argv) > 1 and sys.argv[1]:
        job_path = os.path.abspath(sys.argv[1])
    else:
        job_path = os.environ.get("XEN_TUNER_JOB_PATH", "")
        if job_path:
            job_path = os.path.abspath(job_path)
        else:
            job_path = os.path.join(script_dir, "midx_writer_job.txt")
    fallback_debug_path = os.path.join(os.path.dirname(job_path), "midx_writer_job.debug.log")

    try:
        job = read_job(job_path)
    except Exception as exc:
        log(fallback_debug_path, "ERROR_TYPE=%s" % exc.__class__.__name__)
        log(fallback_debug_path, "ERROR: could not read job file %s: %s" % (job_path, exc))
        return 1

    hex_path = job.get("hex_path", "")
    native_midi_path = job.get("native_midi_path", "")
    offset_path = job.get("offset_path", "")
    output_path = job.get("output_path", "")
    midi2_output_path = job.get("midi2_output_path", "")
    pitch_bend_output_path = job.get("pitch_bend_output_path", "")
    completion_path = job.get("completion_path", "")
    ticks_per_quarter = parse_int(job.get("ticks_per_quarter", ""), 0)
    try:
        pitch_bend_range_semitones = float(
            job.get("pitch_bend_range_semitones", DEFAULT_PITCH_BEND_RANGE_SEMITONES)
        )
    except Exception:
        pitch_bend_range_semitones = DEFAULT_PITCH_BEND_RANGE_SEMITONES
    debug_path = job.get("debug_path", fallback_debug_path)

    log(debug_path, "HELPER_PATH=%s" % os.path.abspath(__file__))
    log(debug_path, "PYTHON_EXECUTABLE=%s" % sys.executable)
    log(debug_path, "PYTHON_VERSION=%s" % sys.version.replace("\n", " "))
    log(debug_path, "CWD=%s" % os.getcwd())
    log(debug_path, "JOB_PATH=%s" % job_path)
    log(debug_path, "HEX_PATH=%s" % hex_path)
    log(debug_path, "NATIVE_MIDI_PATH=%s" % native_midi_path)
    log(debug_path, "OFFSET_PATH=%s" % offset_path)
    log(debug_path, "OUTPUT_PATH=%s" % output_path)
    log(debug_path, "MIDI2_OUTPUT_PATH=%s" % midi2_output_path)
    log(debug_path, "PITCH_BEND_OUTPUT_PATH=%s" % pitch_bend_output_path)
    log(debug_path, "COMPLETION_PATH=%s" % completion_path)
    log(debug_path, "PITCH_BEND_RANGE_SEMITONES=%s" % pitch_bend_range_semitones)
    log(debug_path, "TICKS_PER_QUARTER=%s" % ticks_per_quarter)

    pitch_bend_stats = None
    staged_outputs = []
    try:
        remove_if_exists(completion_path)
        if native_midi_path and offset_path:
            log(debug_path, "MODE=native_midi_inject")
            staged_midx_path = staged_path(output_path)
            staged_outputs.append((staged_midx_path, output_path, b"MThd"))
            remove_if_exists(staged_midx_path)
            inject_midx(native_midi_path, offset_path, staged_midx_path, debug_path)
            if midi2_output_path:
                log(debug_path, "MODE_MIDI2=native_midi_to_midi2")
                staged_midi2_path = staged_path(midi2_output_path)
                staged_outputs.append((staged_midi2_path, midi2_output_path, MIDI2_CLIP_HEADER))
                remove_if_exists(staged_midi2_path)
                write_midi2_from_native(native_midi_path, offset_path, staged_midi2_path, ticks_per_quarter, debug_path)
            if pitch_bend_output_path:
                log(debug_path, "MODE_PITCH_BEND=midx_to_pitch_bend_midi")
                staged_pitch_bend_path = staged_path(pitch_bend_output_path)
                staged_outputs.append((staged_pitch_bend_path, pitch_bend_output_path, b"MThd"))
                remove_if_exists(staged_pitch_bend_path)
                pitch_bend_stats = write_pitch_bend_midi(
                    staged_midx_path,
                    staged_pitch_bend_path,
                    pitch_bend_range_semitones,
                    debug_path,
                )
            commit_staged_outputs(staged_outputs, completion_path, pitch_bend_stats)
        else:
            log(debug_path, "MODE=hex_write")
            write_hex_payload(hex_path, output_path, debug_path)
            write_completion_file(completion_path, pitch_bend_stats)
        log(debug_path, "OUTPUT_EXISTS=%s" % os.path.exists(output_path))
        if os.path.exists(output_path):
            log(debug_path, "OUTPUT_SIZE=%d" % os.path.getsize(output_path))
        if midi2_output_path:
            log(debug_path, "MIDI2_EXISTS=%s" % os.path.exists(midi2_output_path))
            if os.path.exists(midi2_output_path):
                log(debug_path, "MIDI2_SIZE=%d" % os.path.getsize(midi2_output_path))
        if pitch_bend_output_path:
            log(debug_path, "PITCH_BEND_EXISTS=%s" % os.path.exists(pitch_bend_output_path))
            if os.path.exists(pitch_bend_output_path):
                log(debug_path, "PITCH_BEND_SIZE=%d" % os.path.getsize(pitch_bend_output_path))
        return 0
    except Exception as exc:
        log(debug_path, "ERROR_TYPE=%s" % exc.__class__.__name__)
        log(debug_path, "ERROR: %s" % exc)
        return 1
    finally:
        for temporary_path, _output_path, _expected_header in staged_outputs:
            try:
                remove_if_exists(temporary_path)
            except OSError:
                pass


if __name__ == "__main__":
    sys.exit(main())
