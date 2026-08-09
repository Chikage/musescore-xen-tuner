(function (root) {
  "use strict";

  var config = root.MidiWaterfallConfig;
  var MIDX_META_TYPE = config.MIDX_META_TYPE;
  var MIDX_PITCHED_OFFSET_PAYLOAD_LEN = config.MIDX_PITCHED_OFFSET_PAYLOAD_LEN;
  var MIDX_EXPERIMENTAL_MANUFACTURER_ID = config.MIDX_EXPERIMENTAL_MANUFACTURER_ID;
  var MIDX_PITCHED_OFFSET_RECORD_TYPE = config.MIDX_PITCHED_OFFSET_RECORD_TYPE;
  var OFFSET_CENT_RANGE = config.OFFSET_CENT_RANGE;
  var OFFSET_MAGNITUDE_STEPS = config.OFFSET_MAGNITUDE_STEPS;
  var DEFAULT_TEMPO_US_PER_QUARTER = config.DEFAULT_TEMPO_US_PER_QUARTER;
  var MIN_PITCH = config.MIN_PITCH;
  var MAX_PITCH = config.MAX_PITCH;
  var NOTE_RENDER_LOOKBACK_SECONDS = config.NOTE_RENDER_LOOKBACK_SECONDS;

  function ByteReader(buffer, source) {
    this.data = new Uint8Array(buffer);
    this.source = source || "<buffer>";
    this.pos = 0;
  }

  ByteReader.prototype.remaining = function () {
    return this.data.length - this.pos;
  };

  ByteReader.prototype.read = function (count) {
    if (this.pos + count > this.data.length) {
      throw new Error(this.source + ": unexpected end of file at byte " + this.pos);
    }
    var out = this.data.slice(this.pos, this.pos + count);
    this.pos += count;
    return out;
  };

  ByteReader.prototype.readByte = function () {
    return this.read(1)[0];
  };

  ByteReader.prototype.peekByte = function () {
    if (this.remaining() <= 0) {
      throw new Error(this.source + ": unexpected end of file");
    }
    return this.data[this.pos];
  };

  ByteReader.prototype.readU16 = function () {
    var b = this.read(2);
    return (b[0] << 8) | b[1];
  };

  ByteReader.prototype.readU24 = function () {
    var b = this.read(3);
    return (b[0] << 16) | (b[1] << 8) | b[2];
  };

  ByteReader.prototype.readU32 = function () {
    var b = this.read(4);
    return ((b[0] * 0x1000000) + (b[1] << 16) + (b[2] << 8) + b[3]) >>> 0;
  };

  ByteReader.prototype.readAscii = function (count) {
    var b = this.read(count);
    var s = "";
    for (var i = 0; i < b.length; i++) {
      s += String.fromCharCode(b[i]);
    }
    return s;
  };

  ByteReader.prototype.readVlq = function () {
    var value = 0;
    for (var i = 0; i < 4; i++) {
      var b = this.readByte();
      value = (value << 7) | (b & 0x7F);
      if (b < 0x80) {
        return value;
      }
    }
    throw new Error(this.source + ": invalid variable-length quantity");
  };

  function decodeCentOffset(raw) {
    var sign = (raw & 0x8000) ? -1 : 1;
    var magnitude = raw & 0x7FFF;
    return sign * (magnitude / OFFSET_MAGNITUDE_STEPS * OFFSET_CENT_RANGE);
  }

  function decodePitchedOffsetPayload(payload) {
    if (
      payload.length === MIDX_PITCHED_OFFSET_PAYLOAD_LEN &&
      payload[0] === MIDX_EXPERIMENTAL_MANUFACTURER_ID &&
      payload[1] === 0x58 &&
      payload[2] === 0x54 &&
      payload[3] === MIDX_PITCHED_OFFSET_RECORD_TYPE
    ) {
      return {
        pitch: payload[4],
        cents: decodeCentOffset((payload[5] << 8) | payload[6])
      };
    }
    return null;
  }

  function normalizeTempos(tempos) {
    var byTick = {};
    for (var i = 0; i < tempos.length; i++) {
      if (tempos[i].usPerQuarter > 0) {
        byTick[tempos[i].tick] = tempos[i];
      }
    }
    var ticks = Object.keys(byTick).map(Number).sort(function (a, b) { return a - b; });
    var out = ticks.map(function (tick) { return byTick[tick]; });
    if (!out.length || out[0].tick !== 0) {
      out.unshift({ tick: 0, usPerQuarter: DEFAULT_TEMPO_US_PER_QUARTER });
    }
    return out;
  }

  function normalizeMeters(meters) {
    var byTick = {};
    for (var i = 0; i < meters.length; i++) {
      var numerator = Math.max(1, Math.round(meters[i].numerator || 4));
      var denominator = Math.max(1, Math.round(meters[i].denominator || 4));
      byTick[meters[i].tick] = {
        tick: Math.max(0, Math.round(meters[i].tick || 0)),
        numerator: numerator,
        denominator: denominator
      };
    }
    var ticks = Object.keys(byTick).map(Number).sort(function (a, b) { return a - b; });
    var out = ticks.map(function (tick) { return byTick[tick]; });
    if (!out.length || out[0].tick !== 0) {
      out.unshift({ tick: 0, numerator: 4, denominator: 4 });
    }
    return out;
  }

  function makeTempoMap(tempos, ticksPerQuarter) {
    tempos = normalizeTempos(tempos);
    var map = [];
    var currentSec = 0;
    var prevTick = 0;
    var prevUs = DEFAULT_TEMPO_US_PER_QUARTER;
    for (var i = 0; i < tempos.length; i++) {
      var tempo = tempos[i];
      currentSec += (tempo.tick - prevTick) * prevUs / 1000000 / ticksPerQuarter;
      map.push({ tick: tempo.tick, second: currentSec, usPerQuarter: tempo.usPerQuarter });
      prevTick = tempo.tick;
      prevUs = tempo.usPerQuarter;
    }
    return map;
  }

  function tickToSeconds(tick, tempoMap, ticksPerQuarter) {
    var lo = 0;
    var hi = tempoMap.length - 1;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      if (tempoMap[mid].tick <= tick) {
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    var item = tempoMap[Math.max(0, hi)];
    return item.second + (tick - item.tick) * item.usPerQuarter / 1000000 / ticksPerQuarter;
  }

  function secondsToTick(second, tempoMap, ticksPerQuarter) {
    var sec = Math.max(0, second);
    var lo = 0;
    var hi = tempoMap.length - 1;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      if (tempoMap[mid].second <= sec) {
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    var item = tempoMap[Math.max(0, hi)];
    return item.tick + (sec - item.second) * 1000000 * ticksPerQuarter / item.usPerQuarter;
  }

  function measureTicks(meter, ticksPerQuarter) {
    return Math.max(1, ticksPerQuarter * 4 * meter.numerator / meter.denominator);
  }

  function popInline(inlineOffsets, midiPitch, tick) {
    for (var i = 0; i < inlineOffsets.length; i++) {
      if (inlineOffsets[i].tick === tick && inlineOffsets[i].pitch === midiPitch) {
        return inlineOffsets.splice(i, 1)[0];
      }
    }
    var found = -1;
    for (var j = 0; j < inlineOffsets.length; j++) {
      if (inlineOffsets[j].tick === tick) {
        if (found !== -1) {
          return null;
        }
        found = j;
      }
    }
    if (found !== -1) {
      return inlineOffsets.splice(found, 1)[0];
    }
    return null;
  }

  function parseSmfMidx(buffer, fileName) {
    var reader = new ByteReader(buffer, fileName);
    if (reader.readAscii(4) !== "MThd") {
      throw new Error("Not a MIDI/MIDX file: missing MThd");
    }
    var headerLen = reader.readU32();
    var header = new ByteReader(reader.read(headerLen).buffer, "MThd");
    var midiFormat = header.readU16();
    var trackCount = header.readU16();
    var division = header.readU16();
    if (division & 0x8000) {
      throw new Error("SMPTE time division is not supported");
    }
    if (midiFormat !== 0 && midiFormat !== 1) {
      throw new Error("Unsupported MIDI format " + midiFormat);
    }

    var tempos = [{ tick: 0, usPerQuarter: DEFAULT_TEMPO_US_PER_QUARTER }];
    var meters = [{ tick: 0, numerator: 4, denominator: 4 }];
    var raw = [];
    var order = 0;

    for (var track = 0; track < trackCount; track++) {
      if (reader.remaining() <= 0) {
        break;
      }
      var chunkType = reader.readAscii(4);
      var chunkLen = reader.readU32();
      var chunk = reader.read(chunkLen);
      if (chunkType !== "MTrk") {
        continue;
      }
      var tr = new ByteReader(chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength), "MTrk[" + track + "]");
      var tick = 0;
      var runningStatus = null;
      var programs = {};
      var bankMsb = {};
      var bankLsb = {};
      var inlineOffsets = [];

      while (tr.remaining() > 0) {
        tick += tr.readVlq();
        var statusOrData = tr.readByte();

        if (statusOrData === 0xFF) {
          var metaType = tr.readByte();
          var payloadLen = tr.readVlq();
          var payload = tr.read(payloadLen);
          if (metaType === 0x2F) {
            break;
          }
          if (metaType === 0x51 && payloadLen === 3) {
            tempos.push({ tick: tick, usPerQuarter: (payload[0] << 16) | (payload[1] << 8) | payload[2] });
          } else if (metaType === 0x58 && payloadLen >= 2) {
            meters.push({ tick: tick, numerator: payload[0], denominator: Math.pow(2, payload[1]) });
          } else if (metaType === MIDX_META_TYPE && payloadLen === MIDX_PITCHED_OFFSET_PAYLOAD_LEN) {
            var decodedPitchedOffset = decodePitchedOffsetPayload(payload);
            if (decodedPitchedOffset) {
              var pitch = decodedPitchedOffset.pitch;
              var cents = decodedPitchedOffset.cents;
              if (inlineOffsets.length && inlineOffsets[inlineOffsets.length - 1].tick !== tick) {
                inlineOffsets = [];
              }
              inlineOffsets.push({ tick: tick, pitch: pitch, cents: cents });
            } else {
              inlineOffsets = [];
            }
          } else {
            inlineOffsets = [];
          }
          continue;
        }

        if (statusOrData === 0xF0 || statusOrData === 0xF7) {
          tr.read(tr.readVlq());
          runningStatus = null;
          inlineOffsets = [];
          continue;
        }

        if (statusOrData >= 0xF0) {
          skipSystemEvent(tr, statusOrData);
          runningStatus = null;
          inlineOffsets = [];
          continue;
        }

        var status;
        var firstData = null;
        if (statusOrData & 0x80) {
          status = statusOrData;
          runningStatus = status;
        } else {
          if (runningStatus === null) {
            throw new Error("Running status without prior status");
          }
          status = runningStatus;
          firstData = statusOrData;
        }

        var eventType = status & 0xF0;
        var channel = status & 0x0F;
        if (eventType === 0xC0 || eventType === 0xD0) {
          var data1only = firstData === null ? tr.readByte() : firstData;
          if (eventType === 0xC0) {
            programs[channel] = data1only;
          }
          inlineOffsets = [];
          continue;
        }

        var data1 = firstData === null ? tr.readByte() : firstData;
        var data2 = tr.readByte();
        if (eventType === 0xB0) {
          if (data1 === 0) {
            bankMsb[channel] = data2;
          } else if (data1 === 32) {
            bankLsb[channel] = data2;
          }
        }
        if (eventType === 0x80 || eventType === 0x90) {
          var velocity = eventType === 0x90 ? data2 : 0;
          var effectivePitch = data1;
          var noteCents = 0;
          if (velocity > 0) {
            if (inlineOffsets.length && inlineOffsets[inlineOffsets.length - 1].tick !== tick) {
              inlineOffsets = [];
            }
            var inline = popInline(inlineOffsets, data1, tick);
            if (inline) {
              effectivePitch = inline.pitch;
              noteCents = inline.cents;
            }
          } else {
            inlineOffsets = [];
          }
          raw.push({
            tick: tick,
            pitch: effectivePitch,
            midiPitch: data1,
            cents: noteCents,
            velocity: velocity,
            track: track,
            channel: channel,
            program: programs[channel] || 0,
            bankMsb: bankMsb[channel] || 0,
            bankLsb: bankLsb[channel] || 0,
            order: order++
          });
        } else {
          inlineOffsets = [];
        }
      }
    }
    return finalizeParsed(fileName, "MIDX", division, tempos, meters, raw);
  }

  function skipSystemEvent(reader, status) {
    var lengths = { 0xF1: 1, 0xF2: 2, 0xF3: 1, 0xF6: 0, 0xF8: 0, 0xFA: 0, 0xFB: 0, 0xFC: 0, 0xFE: 0 };
    reader.read(lengths[status] || 0);
  }

  function parseMidi2Clip(buffer, fileName) {
    var reader = new ByteReader(buffer, fileName);
    if (reader.readAscii(8) !== "SMF2CLIP") {
      throw new Error("Not a MIDI 2.0 Clip file: missing SMF2CLIP");
    }
    var ticksPerQuarter = 480;
    var tick = 0;
    var tempos = [{ tick: 0, usPerQuarter: DEFAULT_TEMPO_US_PER_QUARTER }];
    var meters = [{ tick: 0, numerator: 4, denominator: 4 }];
    var raw = [];
    var order = 0;
    var programs = {};
    var bankMsb = {};
    var bankLsb = {};

    while (reader.remaining() > 0) {
      var first = reader.peekByte();
      var mt = first >> 4;
      var packetSize = umpPacketSize(mt);
      var packet = reader.read(packetSize);

      if (mt === 0x0) {
        var utilityStatus = (packet[1] >> 4) & 0x0F;
        if (utilityStatus === 0x3) {
          ticksPerQuarter = Math.max(1, ((packet[2] << 8) | packet[3]) || ticksPerQuarter);
        } else if (utilityStatus === 0x4) {
          var delta = ((packet[1] & 0x0F) << 16) | (packet[2] << 8) | packet[3];
          tick += delta;
        }
        continue;
      }

      if (mt === 0xD && packet.length >= 16) {
        if (packet[1] === 0x10 && packet[2] === 0x00 && packet[3] === 0x00) {
          var tenNs = readU32FromBytes(packet, 4);
          if (tenNs > 0) {
            tempos.push({ tick: tick, usPerQuarter: tenNs / 100 });
          }
        }
        continue;
      }

      if (mt !== 0x4 || packet.length < 8) {
        continue;
      }
      var statusByte = packet[1];
      var eventType = statusByte & 0xF0;
      var channel = statusByte & 0x0F;
      var key = String(channel);
      var note = packet[2] & 0x7F;
      var attributeType = packet[3];
      var velocity16 = (packet[4] << 8) | packet[5];
      var attribute = (packet[6] << 8) | packet[7];

      if (eventType === 0xB0) {
        var controller = packet[2] & 0x7F;
        var controllerValue = scaleDownU32To7(readU32FromBytes(packet, 4));
        if (controller === 0) {
          bankMsb[key] = controllerValue;
        } else if (controller === 32) {
          bankLsb[key] = controllerValue;
        }
        continue;
      }

      if (eventType === 0xC0) {
        programs[key] = packet[4] & 0x7F;
        if (packet[3] & 0x01) {
          bankMsb[key] = packet[6] & 0x7F;
          bankLsb[key] = packet[7] & 0x7F;
        }
        continue;
      }

      if (eventType === 0x90) {
        var pitchFloat = note;
        if (attributeType === 0x03) {
          pitchFloat = attribute / 512;
        }
        var velocity = velocity16 > 0 ? Math.max(1, Math.round(velocity16 / 65535 * 127)) : 0;
        raw.push({
          tick: tick,
          pitch: Math.floor(pitchFloat),
          pitchFloat: pitchFloat,
          midiPitch: note,
          cents: (pitchFloat - Math.floor(pitchFloat)) * 100,
          velocity: velocity,
          track: 0,
          channel: channel,
          program: programs[key] || 0,
          bankMsb: bankMsb[key] || 0,
          bankLsb: bankLsb[key] || 0,
          order: order++
        });
      } else if (eventType === 0x80) {
        raw.push({
          tick: tick,
          pitch: note,
          pitchFloat: note,
          midiPitch: note,
          cents: 0,
          velocity: 0,
          track: 0,
          channel: channel,
          program: programs[key] || 0,
          bankMsb: bankMsb[key] || 0,
          bankLsb: bankLsb[key] || 0,
          order: order++
        });
      }
    }
    return finalizeParsed(fileName, "MIDI 2.0 Clip", ticksPerQuarter, tempos, meters, raw);
  }

  function umpPacketSize(mt) {
    if (mt === 0x0 || mt === 0x1 || mt === 0x2) {
      return 4;
    }
    if (mt === 0x3 || mt === 0x4) {
      return 8;
    }
    if (mt === 0x5 || mt === 0xD || mt === 0xF) {
      return 16;
    }
    return 4;
  }

  function readU32FromBytes(bytes, offset) {
    return ((bytes[offset] * 0x1000000) + (bytes[offset + 1] << 16) + (bytes[offset + 2] << 8) + bytes[offset + 3]) >>> 0;
  }

  function scaleDownU32To7(value) {
    return Math.max(0, Math.min(127, Math.round((value >>> 0) * 127 / 0xFFFFFFFF)));
  }

  function finalizeParsed(title, format, ticksPerQuarter, tempos, meters, rawEvents) {
    if (!rawEvents.length) {
      throw new Error("No note events found");
    }
    var tempoMap = makeTempoMap(tempos, ticksPerQuarter);
    var normalizedMeters = normalizeMeters(meters);
    var notes = pairNotes(rawEvents, tempoMap, ticksPerQuarter);
    var longNotes = notes.filter(function (note) {
      return note.end - note.start > NOTE_RENDER_LOOKBACK_SECONDS;
    });
    return {
      title: title,
      format: format,
      ticksPerQuarter: ticksPerQuarter,
      tempos: normalizeTempos(tempos),
      meters: normalizedMeters,
      tempoMap: tempoMap,
      rawEvents: rawEvents,
      notes: notes,
      longNotes: longNotes,
      duration: notes.reduce(function (max, note) { return Math.max(max, note.end); }, 0)
    };
  }

  function pairNotes(rawEvents, tempoMap, ticksPerQuarter) {
    var sorted = rawEvents.slice().sort(function (a, b) {
      if (a.tick !== b.tick) return a.tick - b.tick;
      if ((a.velocity === 0) !== (b.velocity === 0)) return a.velocity === 0 ? -1 : 1;
      return a.order - b.order;
    });
    var active = {};
    var notes = [];
    for (var i = 0; i < sorted.length; i++) {
      var event = sorted[i];
      var key = event.track + ":" + event.channel + ":" + event.midiPitch;
      if (event.velocity > 0) {
        (active[key] || (active[key] = [])).push(event);
      } else {
        var queue = active[key];
        if (!queue || !queue.length) {
          continue;
        }
        var start = queue.shift();
        var startPitchFloat = start.pitchFloat !== undefined ? start.pitchFloat : start.pitch + start.cents / 100;
        notes.push({
          startTick: start.tick,
          endTick: Math.max(event.tick, start.tick),
          start: tickToSeconds(start.tick, tempoMap, ticksPerQuarter),
          end: tickToSeconds(Math.max(event.tick, start.tick), tempoMap, ticksPerQuarter),
          pitch: startPitchFloat,
          midiPitch: start.midiPitch,
          cents: (startPitchFloat - Math.round(startPitchFloat)) * 100,
          velocity: start.velocity,
          channel: start.channel,
          track: start.track,
          program: start.program || 0,
          bankMsb: start.bankMsb || 0,
          bankLsb: start.bankLsb || 0
        });
      }
    }
    var defaultTicks = ticksPerQuarter;
    Object.keys(active).forEach(function (key) {
      active[key].forEach(function (start) {
        var startPitchFloat = start.pitchFloat !== undefined ? start.pitchFloat : start.pitch + start.cents / 100;
        notes.push({
          startTick: start.tick,
          endTick: start.tick + defaultTicks,
          start: tickToSeconds(start.tick, tempoMap, ticksPerQuarter),
          end: tickToSeconds(start.tick + defaultTicks, tempoMap, ticksPerQuarter),
          pitch: startPitchFloat,
          midiPitch: start.midiPitch,
          cents: (startPitchFloat - Math.round(startPitchFloat)) * 100,
          velocity: start.velocity,
          channel: start.channel,
          track: start.track,
          program: start.program || 0,
          bankMsb: start.bankMsb || 0,
          bankLsb: start.bankLsb || 0
        });
      });
    });
    notes.sort(function (a, b) { return a.start - b.start || a.pitch - b.pitch; });
    return notes.filter(function (note) {
      return note.pitch >= MIN_PITCH - 1 && note.pitch <= MAX_PITCH + 1;
    });
  }

  function detectAndParse(buffer, fileName) {
    var head = new ByteReader(buffer, fileName).readAscii(Math.min(8, buffer.byteLength));
    if (head.indexOf("SMF2CLIP") === 0) {
      return parseMidi2Clip(buffer, fileName);
    }
    return parseSmfMidx(buffer, fileName);
  }

  root.MidiWaterfallParser = {
    detectAndParse: detectAndParse,
    normalizeTempos: normalizeTempos,
    normalizeMeters: normalizeMeters,
    makeTempoMap: makeTempoMap,
    tickToSeconds: tickToSeconds,
    secondsToTick: secondsToTick,
    measureTicks: measureTicks
  };
})(window);
