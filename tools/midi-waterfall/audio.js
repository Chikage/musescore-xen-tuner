(function (root) {
  "use strict";

  var AUDIO_LOOKAHEAD_SECONDS = 0.18;
  var AUDIO_RELEASE_SECONDS = 0.08;
  var DEFAULT_PIANO_SAMPLE_PATHS = ["./acoustic_grand_piano-sounds.js", "../midi/acoustic_grand_piano-sounds.js"];
  var GM_PITCH_BEND_RANGE = 2;
  var PIANO_JS_GAIN = 2.35;
  var PIANO_JS_GAIN_LIMIT = 1.85;

  function createMidiWaterfallAudio(state, controls) {
    controls = controls || {};

    function setStatus(text) {
      state.audioStatus = text;
      if (controls.onStatusChange) {
        controls.onStatusChange();
      }
    }

    function ensureAudioContext() {
      var Ctor = root.AudioContext || root.webkitAudioContext;
      if (!Ctor) {
        return Promise.reject(new Error("WebAudio is not available"));
      }
      if (!state.audioContext) {
        state.audioContext = new Ctor();
        state.masterGain = state.audioContext.createGain();
        state.masterGain.gain.value = 0.72;
        state.masterGain.connect(state.audioContext.destination);
      }
      if (state.audioContext.state === "suspended") {
        return state.audioContext.resume().then(function () {
          return state.audioContext;
        });
      }
      return Promise.resolve(state.audioContext);
    }

    function prepare() {
      if (state.audioMode === "system") {
        return prepareSystemMidi();
      }
      if (state.audioMode === "sf2") {
        return prepareSf2();
      }
      return preparePiano();
    }

    function preparePiano() {
      return ensureAudioContext().then(function (ctx) {
        if (state.pianoBank) {
          setStatus("Piano JS" + (state.pianoFileName ? ": " + state.pianoFileName : ""));
          return state.pianoBank;
        }
        if (state.pianoLoading) {
          return state.pianoLoading;
        }
        setStatus("Loading Piano JS");
        state.pianoLoading = loadDefaultPianoText().then(function (result) {
          return decodePianoSamplePack(ctx, result.text, result.name);
        }).then(function (bank) {
          state.pianoBank = bank;
          state.pianoFileName = bank.name;
          setStatus("Piano JS: " + bank.name);
          return bank;
        }).catch(function (err) {
          state.pianoLoading = null;
          throw err;
        });
        return state.pianoLoading;
      });
    }

    function prepareSf2() {
      return ensureAudioContext().then(function () {
        if (!state.sf2Bank) {
          setStatus("Choose SF2");
          throw new Error("Choose an SF2 file first");
        }
        setStatus("SF2: " + state.sf2Bank.name);
        return state.sf2Bank;
      });
    }

    function prepareSystemMidi() {
      if (!root.navigator || !root.navigator.requestMIDIAccess) {
        state.midiFallback = true;
        return ensureAudioContext().then(function () {
          setStatus("System MIDI unavailable; browser synth");
        });
      }
      if (state.midiReady && state.midiOutput) {
        setStatus("System MIDI: " + state.midiOutput.name);
        return Promise.resolve(state.midiOutput);
      }
      setStatus("Opening System MIDI");
      return root.navigator.requestMIDIAccess({ sysex: false }).then(function (access) {
        var outputs = [];
        access.outputs.forEach(function (output) {
          outputs.push(output);
        });
        state.midiAccess = access;
        state.midiOutput = outputs[0] || null;
        state.midiReady = !!state.midiOutput;
        state.midiFallback = !state.midiOutput;
        state.midiPrograms = {};
        state.midiChannelBusy = {};
        if (!state.midiOutput) {
          return ensureAudioContext().then(function () {
            setStatus("No MIDI output; browser synth");
          });
        }
        configurePitchBendRange(state.midiOutput);
        setStatus("System MIDI: " + state.midiOutput.name);
        return state.midiOutput;
      }).catch(function () {
        state.midiFallback = true;
        return ensureAudioContext().then(function () {
          setStatus("System MIDI blocked; browser synth");
        });
      });
    }

    function loadDefaultPianoText() {
      var index = 0;
      function tryNext(lastErr) {
        if (index >= DEFAULT_PIANO_SAMPLE_PATHS.length) {
          throw lastErr || new Error("Load acoustic_grand_piano-sounds.js with JS");
        }
        var url = DEFAULT_PIANO_SAMPLE_PATHS[index++];
        return root.fetch(url).then(function (response) {
          if (!response.ok) {
            throw new Error(url + " returned " + response.status);
          }
          return response.text();
        }).then(function (text) {
          return { text: text, name: url.split("/").pop() };
        }).catch(tryNext);
      }
      if (!root.fetch) {
        return Promise.reject(new Error("Load acoustic_grand_piano-sounds.js with JS"));
      }
      return tryNext();
    }

    function decodePianoSamplePack(ctx, text, name) {
      var samples = parsePianoSamplePack(text);
      if (!samples.length) {
        throw new Error("No samples found in Piano JS file");
      }
      return Promise.all(samples.map(function (sample) {
        return decodeAudioDataUri(ctx, sample.uri).then(function (buffer) {
          sample.buffer = buffer;
          return sample;
        });
      })).then(function (decoded) {
        decoded.sort(function (a, b) {
          return a.midi - b.midi;
        });
        var byMidi = {};
        for (var i = 0; i < decoded.length; i++) {
          byMidi[decoded[i].midi] = decoded[i];
        }
        return {
          name: name || "acoustic_grand_piano-sounds.js",
          samples: decoded,
          byMidi: byMidi
        };
      });
    }

    function parsePianoSamplePack(text) {
      var re = /"([A-G][b#]?-?\d+)"\s*:\s*"(data:audio\/[^"]+)"/g;
      var samples = [];
      var match;
      while ((match = re.exec(text))) {
        var midi = noteNameToMidi(match[1]);
        if (midi !== null) {
          samples.push({ name: match[1], midi: midi, uri: match[2] });
        }
      }
      return samples;
    }

    function decodeAudioDataUri(ctx, uri) {
      var comma = uri.indexOf(",");
      if (comma < 0) {
        return Promise.reject(new Error("Invalid data URI"));
      }
      var meta = uri.slice(0, comma);
      var payload = uri.slice(comma + 1);
      var binary;
      if (/;base64/i.test(meta)) {
        binary = root.atob(payload);
      } else {
        binary = decodeURIComponent(payload);
      }
      var bytes = new Uint8Array(binary.length);
      for (var i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i) & 0xFF;
      }
      return decodeAudioData(ctx, bytes.buffer);
    }

    function decodeAudioData(ctx, buffer) {
      return new Promise(function (resolve, reject) {
        try {
          var maybePromise = ctx.decodeAudioData(buffer.slice(0), resolve, reject);
          if (maybePromise && maybePromise.then) {
            maybePromise.then(resolve, reject);
          }
        } catch (err) {
          reject(err);
        }
      });
    }

    function loadPianoFile(file) {
      if (!file) {
        return;
      }
      stopAll();
      setStatus("Loading Piano JS");
      readFileAsText(file).then(function (text) {
        return ensureAudioContext().then(function (ctx) {
          return decodePianoSamplePack(ctx, text, file.name);
        });
      }).then(function (bank) {
        state.pianoBank = bank;
        state.pianoLoading = null;
        state.pianoFileName = file.name;
        state.audioMode = "piano";
        updateModeButtons();
        setStatus("Piano JS: " + file.name);
      }).catch(function (err) {
        state.pianoLoading = null;
        setStatus("Piano JS failed: " + err.message);
      });
    }

    function loadSf2File(file) {
      if (!file) {
        return;
      }
      stopAll();
      setStatus("Loading SF2");
      readFileAsArrayBuffer(file).then(function (buffer) {
        state.sf2Bank = parseSoundFont(buffer, file.name);
        state.sf2FileName = file.name;
        state.audioMode = "sf2";
        updateModeButtons();
        setStatus("SF2: " + file.name);
      }).catch(function (err) {
        state.sf2Bank = null;
        setStatus("SF2 failed: " + err.message);
      });
    }

    function readFileAsText(file) {
      return new Promise(function (resolve, reject) {
        var reader = new FileReader();
        reader.onload = function () {
          resolve(reader.result);
        };
        reader.onerror = function () {
          reject(reader.error || new Error("Could not read file"));
        };
        reader.readAsText(file);
      });
    }

    function readFileAsArrayBuffer(file) {
      return new Promise(function (resolve, reject) {
        var reader = new FileReader();
        reader.onload = function () {
          resolve(reader.result);
        };
        reader.onerror = function () {
          reject(reader.error || new Error("Could not read file"));
        };
        reader.readAsArrayBuffer(file);
      });
    }

    function resetCursor() {
      var notes = state.notes || [];
      var playhead = Math.max(0, state.playhead || 0);
      var cursor = 0;
      while (cursor < notes.length && notes[cursor].end <= playhead + 0.001) {
        cursor++;
      }
      state.audioCursor = cursor;
    }

    function schedule() {
      if (!state.playing || !state.notes || !state.notes.length) {
        return;
      }
      pruneActive();
      var speed = Math.max(0.05, state.speed || 1);
      var horizon = state.playhead + AUDIO_LOOKAHEAD_SECONDS * speed;
      var cursor = state.audioCursor || 0;
      while (cursor < state.notes.length) {
        var note = state.notes[cursor];
        if (note.end <= state.playhead + 0.002) {
          cursor++;
          continue;
        }
        if (note.start > horizon) {
          break;
        }
        scheduleNote(note, speed);
        cursor++;
      }
      state.audioCursor = cursor;
    }

    function scheduleNote(note, speed) {
      var remaining = note.end - Math.max(note.start, state.playhead);
      if (remaining <= 0.006 || note.velocity <= 0) {
        return;
      }
      var delay = Math.max(0, (note.start - state.playhead) / speed);
      var duration = Math.max(0.012, remaining / speed);
      if (state.audioMode === "system") {
        if (state.midiOutput && !state.midiFallback) {
          playMidiNote(note, delay, duration);
        } else {
          playInternalNote(note, delay, duration);
        }
      } else if (state.audioMode === "sf2" && state.sf2Bank) {
        playSf2Note(note, delay, duration);
      } else if (state.audioMode === "piano" && state.pianoBank) {
        playPianoNote(note, delay, duration);
      }
    }

    function startPreviewNote(note) {
      return prepare().then(function () {
        pruneActive();
        return playPreviewNoteNow(note);
      });
    }

    function playPreviewNoteNow(note) {
      var duration = 8;
      if (state.audioMode === "system") {
        if (state.midiOutput && !state.midiFallback) {
          return playMidiNote(note, 0, duration);
        }
        return playInternalNote(note, 0, duration);
      }
      if (state.audioMode === "sf2" && state.sf2Bank) {
        return playSf2Note(note, 0, duration);
      }
      if (state.audioMode === "piano" && state.pianoBank) {
        return playPianoNote(note, 0, duration);
      }
      return playInternalNote(note, 0, duration);
    }

    function playPianoNote(note, delay, duration) {
      var ctx = state.audioContext;
      var sample = nearestPianoSample(note.pitch);
      if (!ctx || !sample || !sample.buffer) {
        return playInternalNote(note, delay, duration);
      }
      var when = ctx.currentTime + delay;
      var source = ctx.createBufferSource();
      var gain = ctx.createGain();
      source.buffer = sample.buffer;
      source.playbackRate.setValueAtTime(frequencyFromPitch(note.pitch) / frequencyFromPitch(sample.midi), when);
      applyEnvelope(gain.gain, when, duration, pianoVelocityGain(note.velocity), AUDIO_RELEASE_SECONDS);
      source.connect(gain);
      gain.connect(state.masterGain);
      var entry = trackAudioSource(source, gain, when, duration, AUDIO_RELEASE_SECONDS);
      entry.update = function (nextNote) {
        updateAudioParam(source.playbackRate, frequencyFromPitch(nextNote.pitch) / frequencyFromPitch(sample.midi));
        updateAudioParam(gain.gain, pianoVelocityGain(nextNote.velocity));
        return true;
      };
      return entry;
    }

    function playSf2Note(note, delay, duration) {
      var ctx = state.audioContext;
      var zones = selectSf2Zones(note);
      if (!ctx || !zones.length) {
        return playInternalNote(note, delay, duration);
      }
      var entries = [];
      for (var i = 0; i < zones.length && i < 4; i++) {
        var entry = playSf2Zone(note, zones[i], delay, duration, zones.length);
        if (entry) {
          entries.push(entry);
        }
      }
      return groupEntries(entries);
    }

    function playSf2Zone(note, zone, delay, duration, layerCount) {
      var ctx = state.audioContext;
      var buffer = sf2BufferForZone(ctx, state.sf2Bank, zone);
      if (!buffer) {
        return null;
      }
      var when = ctx.currentTime + delay;
      var source = ctx.createBufferSource();
      var gain = ctx.createGain();
      var amp = velocityGain(note.velocity) * zone.gain / Math.sqrt(Math.max(1, layerCount || 1));
      source.buffer = buffer;
      source.playbackRate.setValueAtTime(sf2PlaybackRate(note, zone), when);
      if (zone.loop) {
        source.loop = true;
        source.loopStart = Math.max(0, zone.loopStart / zone.sampleRate);
        source.loopEnd = Math.max(source.loopStart + 0.001, zone.loopEnd / zone.sampleRate);
      }
      applyEnvelope(gain.gain, when, duration, amp, AUDIO_RELEASE_SECONDS);
      source.connect(gain);
      if (ctx.createStereoPanner && Math.abs(zone.pan) > 0.01) {
        var panner = ctx.createStereoPanner();
        panner.pan.value = Math.max(-1, Math.min(1, zone.pan));
        gain.connect(panner);
        panner.connect(state.masterGain);
      } else {
        gain.connect(state.masterGain);
      }
      var entry = trackAudioSource(source, gain, when, duration, AUDIO_RELEASE_SECONDS);
      entry.update = function (nextNote) {
        updateAudioParam(source.playbackRate, sf2PlaybackRate(nextNote, zone));
        updateAudioParam(gain.gain, velocityGain(nextNote.velocity) * zone.gain / Math.sqrt(Math.max(1, layerCount || 1)));
        return true;
      };
      return entry;
    }

    function playInternalNote(note, delay, duration) {
      var ctx = state.audioContext;
      if (!ctx) {
        return null;
      }
      var when = ctx.currentTime + delay;
      var osc = ctx.createOscillator();
      var gain = ctx.createGain();
      osc.type = waveformForProgram(note.program || 0);
      osc.frequency.setValueAtTime(frequencyFromPitch(note.pitch), when);
      applyEnvelope(gain.gain, when, duration, velocityGain(note.velocity) * 0.22, AUDIO_RELEASE_SECONDS);
      osc.connect(gain);
      gain.connect(state.masterGain);
      var entry = trackAudioSource(osc, gain, when, duration, AUDIO_RELEASE_SECONDS);
      entry.update = function (nextNote) {
        updateAudioParam(osc.frequency, frequencyFromPitch(nextNote.pitch));
        updateAudioParam(gain.gain, velocityGain(nextNote.velocity) * 0.22);
        return true;
      };
      return entry;
    }

    function trackAudioSource(source, gain, when, duration, release) {
      var entry = { source: source, gain: gain, done: false };
      source.onended = function () {
        entry.done = true;
      };
      entry.stop = function () {
        try {
          if (gain && gain.gain) {
            gain.gain.cancelScheduledValues(state.audioContext.currentTime);
            gain.gain.setValueAtTime(0, state.audioContext.currentTime);
          }
          source.stop(0);
        } catch (err) {
          entry.done = true;
        }
      };
      state.activeAudio.push(entry);
      try {
        source.start(when);
        source.stop(when + duration + release + 0.04);
      } catch (err) {
        entry.done = true;
      }
      return entry;
    }

    function groupEntries(entries) {
      entries = entries || [];
      if (entries.length === 1) {
        return entries[0];
      }
      return {
        done: false,
        update: function (note) {
          var ok = true;
          for (var i = 0; i < entries.length; i++) {
            if (entries[i] && entries[i].update && entries[i].update(note) === false) {
              ok = false;
            }
          }
          return ok;
        },
        stop: function () {
          for (var i = 0; i < entries.length; i++) {
            if (entries[i] && entries[i].stop) {
              entries[i].stop();
            }
          }
          this.done = true;
        }
      };
    }

    function updateAudioParam(param, value) {
      if (!param || !state.audioContext) {
        return;
      }
      var now = state.audioContext.currentTime;
      var safeValue = Math.max(0.0001, Number(value) || 0.0001);
      try {
        param.cancelScheduledValues(now);
        param.setTargetAtTime(safeValue, now, 0.018);
      } catch (err) {
        try {
          param.setValueAtTime(safeValue, now);
        } catch (ignored) {
          // AudioParams can reject updates after their source has ended.
        }
      }
    }

    function applyEnvelope(param, when, duration, amp, release) {
      var attack = Math.min(0.012, Math.max(0.002, duration * 0.25));
      var end = when + Math.max(0.01, duration);
      var releaseEnd = end + release;
      param.cancelScheduledValues(when);
      param.setValueAtTime(0.0001, when);
      param.linearRampToValueAtTime(Math.max(0.0001, amp), when + attack);
      param.setValueAtTime(Math.max(0.0001, amp), Math.max(when + attack, end - 0.006));
      param.linearRampToValueAtTime(0.0001, releaseEnd);
    }

    function playMidiNote(note, delay, duration) {
      var output = state.midiOutput;
      if (!output) {
        return null;
      }
      var channel = allocateMidiChannel(note, duration);
      var midiPitch = Math.max(0, Math.min(127, Math.round(note.pitch)));
      var velocity = Math.max(1, Math.min(127, Math.round(note.velocity || 1)));
      var bendSemitones = note.pitch - midiPitch;
      var entry = { sent: false, done: false, channel: channel, pitch: midiPitch };
      entry.onTimer = root.setTimeout(function () {
        sendProgramIfNeeded(output, note, channel);
        sendPitchBend(output, channel, bendSemitones);
        output.send([0x90 | channel, midiPitch, velocity]);
        entry.sent = true;
        entry.offTimer = root.setTimeout(function () {
          output.send([0x80 | channel, midiPitch, 0]);
          sendPitchBend(output, channel, 0);
          releaseMidiChannel(channel);
          entry.done = true;
        }, Math.max(1, duration * 1000));
      }, Math.max(0, delay * 1000));
      entry.stop = function () {
        root.clearTimeout(entry.onTimer);
        root.clearTimeout(entry.offTimer);
        if (entry.sent && state.midiOutput) {
          state.midiOutput.send([0x80 | channel, midiPitch, 0]);
          sendPitchBend(state.midiOutput, channel, 0);
        }
        releaseMidiChannel(channel);
        entry.done = true;
      };
      entry.update = function (nextNote) {
        var nextMidiPitch = Math.max(0, Math.min(127, Math.round(nextNote.pitch)));
        var nextVelocity = Math.max(1, Math.min(127, Math.round(nextNote.velocity || 1)));
        if (nextMidiPitch !== midiPitch || !state.midiOutput || !entry.sent) {
          return false;
        }
        sendPitchBend(state.midiOutput, channel, nextNote.pitch - nextMidiPitch);
        state.midiOutput.send([0xB0 | channel, 7, nextVelocity]);
        return true;
      };
      state.activeAudio.push(entry);
      state.midiActive.push(entry);
      return entry;
    }

    function allocateMidiChannel(note, duration) {
      var preferred = Math.max(0, Math.min(15, note.channel || 0));
      if (preferred === 9) {
        preferred = 0;
      }
      state.midiChannelBusy = state.midiChannelBusy || {};
      var now = Date.now();
      var until = now + Math.max(30, duration * 1000 + 80);
      var candidates = [];
      for (var i = 0; i < 16; i++) {
        if (i !== 9) {
          candidates.push(i);
        }
      }
      candidates.sort(function (a, b) {
        if (a === preferred) return -1;
        if (b === preferred) return 1;
        return (state.midiChannelBusy[a] || 0) - (state.midiChannelBusy[b] || 0);
      });
      for (var c = 0; c < candidates.length; c++) {
        var channel = candidates[c];
        if (!state.midiChannelBusy[channel] || state.midiChannelBusy[channel] <= now) {
          state.midiChannelBusy[channel] = until;
          return channel;
        }
      }
      var fallback = candidates[0];
      state.midiChannelBusy[fallback] = until;
      return fallback;
    }

    function releaseMidiChannel(channel) {
      if (state.midiChannelBusy) {
        state.midiChannelBusy[channel] = 0;
      }
    }

    function sendProgramIfNeeded(output, note, outputChannel) {
      var channel = Math.max(0, Math.min(15, outputChannel));
      var program = Math.max(0, Math.min(127, note.program || 0));
      var bankMsb = Math.max(0, Math.min(127, note.bankMsb || 0));
      var bankLsb = Math.max(0, Math.min(127, note.bankLsb || 0));
      var key = bankMsb + ":" + bankLsb + ":" + program;
      state.midiPrograms = state.midiPrograms || {};
      if (state.midiPrograms[channel] === key) {
        return;
      }
      output.send([0xB0 | channel, 0, bankMsb]);
      output.send([0xB0 | channel, 32, bankLsb]);
      output.send([0xC0 | channel, program]);
      state.midiPrograms[channel] = key;
    }

    function configurePitchBendRange(output) {
      for (var channel = 0; channel < 16; channel++) {
        output.send([0xB0 | channel, 101, 0]);
        output.send([0xB0 | channel, 100, 0]);
        output.send([0xB0 | channel, 6, GM_PITCH_BEND_RANGE]);
        output.send([0xB0 | channel, 38, 0]);
        output.send([0xB0 | channel, 101, 127]);
        output.send([0xB0 | channel, 100, 127]);
        sendPitchBend(output, channel, 0);
      }
    }

    function sendPitchBend(output, channel, semitones) {
      var normalized = Math.max(-1, Math.min(1, semitones / GM_PITCH_BEND_RANGE));
      var value = Math.max(0, Math.min(16383, Math.round(8192 + normalized * 8191)));
      output.send([0xE0 | channel, value & 0x7F, (value >> 7) & 0x7F]);
    }

    function allMidiOff() {
      if (!state.midiOutput) {
        return;
      }
      for (var channel = 0; channel < 16; channel++) {
        state.midiOutput.send([0xB0 | channel, 123, 0]);
        state.midiOutput.send([0xB0 | channel, 120, 0]);
        sendPitchBend(state.midiOutput, channel, 0);
      }
      state.midiActive = [];
      state.midiChannelBusy = {};
    }

    function stopAll() {
      var active = state.activeAudio || [];
      for (var i = 0; i < active.length; i++) {
        if (active[i] && active[i].stop) {
          active[i].stop();
        }
      }
      state.activeAudio = [];
      allMidiOff();
      resetCursor();
    }

    function setMode(mode) {
      stopAll();
      state.audioMode = mode || "piano";
      if (state.audioMode === "system") {
        setStatus("System MIDI");
      } else if (state.audioMode === "sf2") {
        setStatus(state.sf2Bank ? "SF2: " + state.sf2Bank.name : "Choose SF2");
      } else {
        setStatus(state.pianoBank ? "Piano JS: " + state.pianoBank.name : "Piano JS");
      }
      updateModeButtons();
      if (controls.onModeChange) {
        controls.onModeChange();
      }
    }

    function updateModeButtons() {
      setButtonActive(controls.systemSoundButton, state.audioMode === "system");
      setButtonActive(controls.jsSoundButton, state.audioMode === "piano");
      setButtonActive(controls.sf2FileButton, state.audioMode === "sf2");
    }

    function setButtonActive(button, active) {
      if (!button || !button.classList) {
        return;
      }
      if (active) {
        button.classList.add("active");
      } else {
        button.classList.remove("active");
      }
    }

    function pruneActive() {
      var active = state.activeAudio || [];
      var kept = [];
      for (var i = 0; i < active.length; i++) {
        if (!active[i].done) {
          kept.push(active[i]);
        }
      }
      state.activeAudio = kept;
    }

    function nearestPianoSample(pitch) {
      if (!state.pianoBank || !state.pianoBank.samples.length) {
        return null;
      }
      var rounded = Math.round(pitch);
      if (state.pianoBank.byMidi[rounded]) {
        return state.pianoBank.byMidi[rounded];
      }
      var best = state.pianoBank.samples[0];
      var bestDist = Math.abs(best.midi - rounded);
      for (var i = 1; i < state.pianoBank.samples.length; i++) {
        var dist = Math.abs(state.pianoBank.samples[i].midi - rounded);
        if (dist < bestDist) {
          best = state.pianoBank.samples[i];
          bestDist = dist;
        }
      }
      return best;
    }

    function selectSf2Zones(note) {
      if (!state.sf2Bank) {
        return [];
      }
      var key = Math.max(0, Math.min(127, Math.round(note.midiPitch !== undefined ? note.midiPitch : note.pitch)));
      var velocity = Math.max(1, Math.min(127, Math.round(note.velocity || 1)));
      var program = Math.max(0, Math.min(127, note.program || 0));
      var bank = Math.max(0, Math.min(16383, (note.bankMsb || 0) * 128 + (note.bankLsb || 0)));
      if ((note.channel || 0) === 9 && bank === 0) {
        bank = 128;
      }
      var candidates = matchingSf2Zones(program, bank, key, velocity);
      if (!candidates.length && bank !== 0) {
        candidates = matchingSf2Zones(program, 0, key, velocity);
      }
      if (!candidates.length) {
        candidates = matchingSf2Zones(program, null, key, velocity);
      }
      if (!candidates.length) {
        candidates = matchingSf2Zones(0, 0, key, velocity);
      }
      candidates.sort(function (a, b) {
        var widthA = (a.keyHi - a.keyLo) + (a.velHi - a.velLo);
        var widthB = (b.keyHi - b.keyLo) + (b.velHi - b.velLo);
        return widthA - widthB || a.attenuation - b.attenuation;
      });
      return candidates;
    }

    function matchingSf2Zones(program, bank, key, velocity) {
      var zones = state.sf2Bank.zones;
      var out = [];
      for (var i = 0; i < zones.length; i++) {
        var zone = zones[i];
        if (zone.program !== program) {
          continue;
        }
        if (bank !== null && zone.bank !== bank) {
          continue;
        }
        if (key >= zone.keyLo && key <= zone.keyHi && velocity >= zone.velLo && velocity <= zone.velHi) {
          out.push(zone);
        }
      }
      return out;
    }

    function sf2BufferForZone(ctx, bank, zone) {
      var cacheKey = zone.sampleIndex + ":" + zone.start + ":" + zone.end;
      if (bank.bufferCache[cacheKey]) {
        return bank.bufferCache[cacheKey];
      }
      var start = Math.max(0, Math.min(bank.samples.length, zone.start));
      var end = Math.max(start + 1, Math.min(bank.samples.length, zone.end));
      var len = end - start;
      var audioBuffer = ctx.createBuffer(1, len, zone.sampleRate || 44100);
      var channel = audioBuffer.getChannelData(0);
      for (var i = 0; i < len; i++) {
        channel[i] = bank.samples[start + i] / 32768;
      }
      bank.bufferCache[cacheKey] = audioBuffer;
      return audioBuffer;
    }

    function sf2PlaybackRate(note, zone) {
      var targetPitch = note.pitch;
      var semitones = (targetPitch - zone.rootKey) * (zone.scaleTuning / 100) + zone.coarseTune + zone.fineTune / 100;
      return Math.pow(2, semitones / 12);
    }

    function parseSoundFont(buffer, name) {
      var view = new DataView(buffer);
      if (readFourCC(view, 0) !== "RIFF" || readFourCC(view, 8) !== "sfbk") {
        throw new Error("Not an SF2 SoundFont");
      }
      var chunks = collectSf2Chunks(view);
      if (!chunks.smpl || !chunks.phdr || !chunks.pbag || !chunks.pgen || !chunks.inst || !chunks.ibag || !chunks.igen || !chunks.shdr) {
        throw new Error("SF2 missing required tables");
      }
      var samples = readInt16Array(view, chunks.smpl.offset, chunks.smpl.size);
      var phdr = parsePhdr(view, chunks.phdr);
      var pbag = parseBag(view, chunks.pbag);
      var pgen = parseGen(view, chunks.pgen);
      var inst = parseInst(view, chunks.inst);
      var ibag = parseBag(view, chunks.ibag);
      var igen = parseGen(view, chunks.igen);
      var shdr = parseShdr(view, chunks.shdr);
      var zones = buildSf2Zones(phdr, pbag, pgen, inst, ibag, igen, shdr, samples.length);
      if (!zones.length) {
        throw new Error("SF2 has no playable zones");
      }
      return {
        name: name || "soundfont.sf2",
        samples: samples,
        zones: zones,
        bufferCache: {}
      };
    }

    function collectSf2Chunks(view) {
      var chunks = {};
      var pos = 12;
      while (pos + 8 <= view.byteLength) {
        var id = readFourCC(view, pos);
        var size = view.getUint32(pos + 4, true);
        var dataOffset = pos + 8;
        if (id === "LIST" && dataOffset + 4 <= view.byteLength) {
          var listType = readFourCC(view, dataOffset);
          if (listType === "sdta" || listType === "pdta") {
            collectListChunks(view, dataOffset + 4, dataOffset + size, chunks);
          }
        }
        pos += 8 + size + (size & 1);
      }
      return chunks;
    }

    function collectListChunks(view, start, end, chunks) {
      var pos = start;
      while (pos + 8 <= end && pos + 8 <= view.byteLength) {
        var id = readFourCC(view, pos);
        var size = view.getUint32(pos + 4, true);
        chunks[id] = { offset: pos + 8, size: size };
        pos += 8 + size + (size & 1);
      }
    }

    function parsePhdr(view, chunk) {
      var out = [];
      for (var pos = chunk.offset; pos + 38 <= chunk.offset + chunk.size; pos += 38) {
        out.push({
          name: readSf2Name(view, pos, 20),
          preset: view.getUint16(pos + 20, true),
          bank: view.getUint16(pos + 22, true),
          bagIndex: view.getUint16(pos + 24, true)
        });
      }
      return out;
    }

    function parseBag(view, chunk) {
      var out = [];
      for (var pos = chunk.offset; pos + 4 <= chunk.offset + chunk.size; pos += 4) {
        out.push({
          genIndex: view.getUint16(pos, true),
          modIndex: view.getUint16(pos + 2, true)
        });
      }
      return out;
    }

    function parseGen(view, chunk) {
      var out = [];
      for (var pos = chunk.offset; pos + 4 <= chunk.offset + chunk.size; pos += 4) {
        out.push({
          op: view.getUint16(pos, true),
          amount: view.getUint16(pos + 2, true)
        });
      }
      return out;
    }

    function parseInst(view, chunk) {
      var out = [];
      for (var pos = chunk.offset; pos + 22 <= chunk.offset + chunk.size; pos += 22) {
        out.push({
          name: readSf2Name(view, pos, 20),
          bagIndex: view.getUint16(pos + 20, true)
        });
      }
      return out;
    }

    function parseShdr(view, chunk) {
      var out = [];
      for (var pos = chunk.offset; pos + 46 <= chunk.offset + chunk.size; pos += 46) {
        out.push({
          name: readSf2Name(view, pos, 20),
          start: view.getUint32(pos + 20, true),
          end: view.getUint32(pos + 24, true),
          startLoop: view.getUint32(pos + 28, true),
          endLoop: view.getUint32(pos + 32, true),
          sampleRate: view.getUint32(pos + 36, true) || 44100,
          originalPitch: view.getUint8(pos + 40),
          pitchCorrection: view.getInt8(pos + 41),
          sampleLink: view.getUint16(pos + 42, true),
          sampleType: view.getUint16(pos + 44, true)
        });
      }
      return out;
    }

    function buildSf2Zones(phdr, pbag, pgen, inst, ibag, igen, shdr, sampleCount) {
      var zones = [];
      for (var p = 0; p < phdr.length - 1; p++) {
        var preset = phdr[p];
        var presetGlobal = {};
        var presetBagEnd = Math.min(pbag.length - 1, phdr[p + 1].bagIndex);
        for (var pb = preset.bagIndex; pb < presetBagEnd; pb++) {
          var presetGens = genMap(pgen, pbag[pb].genIndex, pbag[pb + 1].genIndex);
          var instrumentIndex = genUnsigned(presetGens, 41, null);
          if (instrumentIndex === null) {
            presetGlobal = presetGens;
            continue;
          }
          if (!inst[instrumentIndex] || !inst[instrumentIndex + 1]) {
            continue;
          }
          var instGlobal = {};
          var instBagEnd = Math.min(ibag.length - 1, inst[instrumentIndex + 1].bagIndex);
          for (var ib = inst[instrumentIndex].bagIndex; ib < instBagEnd; ib++) {
            var instGens = genMap(igen, ibag[ib].genIndex, ibag[ib + 1].genIndex);
            var sampleIndex = genUnsigned(instGens, 53, null);
            if (sampleIndex === null) {
              instGlobal = instGens;
              continue;
            }
            if (!shdr[sampleIndex] || shdr[sampleIndex].name === "EOS") {
              continue;
            }
            var chain = [presetGlobal, presetGens, instGlobal, instGens];
            var zone = buildSf2Zone(preset, sampleIndex, shdr[sampleIndex], chain, sampleCount);
            if (zone) {
              zones.push(zone);
            }
          }
        }
      }
      return zones;
    }

    function buildSf2Zone(preset, sampleIndex, sample, chain, sampleCount) {
      var keyRange = genRange(chain, 43, 0, 127);
      var velRange = genRange(chain, 44, 0, 127);
      if (keyRange.lo > keyRange.hi || velRange.lo > velRange.hi) {
        return null;
      }
      var rootKey = genUnsignedChain(chain, 58, sample.originalPitch);
      if (rootKey === 255 || rootKey === undefined || rootKey === null) {
        rootKey = sample.originalPitch || 60;
      }
      var start = sample.start + signedSum(chain, 0) + signedSum(chain, 4) * 32768;
      var end = sample.end + signedSum(chain, 1) + signedSum(chain, 12) * 32768;
      var loopStart = sample.startLoop + signedSum(chain, 2) + signedSum(chain, 45) * 32768;
      var loopEnd = sample.endLoop + signedSum(chain, 3) + signedSum(chain, 50) * 32768;
      start = clampInt(start, 0, sampleCount - 1);
      end = clampInt(end, start + 1, sampleCount);
      loopStart = clampInt(loopStart, start, end - 1) - start;
      loopEnd = clampInt(loopEnd, start + 1, end) - start;
      var attenuation = Math.max(0, signedSum(chain, 48));
      var pan = signedSum(chain, 17) / 500;
      var coarseTune = signedSum(chain, 51);
      var fineTune = signedSum(chain, 52) + (sample.pitchCorrection || 0);
      var scaleTuning = genSignedChain(chain, 56, 100);
      return {
        program: preset.preset,
        bank: preset.bank,
        sampleIndex: sampleIndex,
        sampleName: sample.name,
        keyLo: keyRange.lo,
        keyHi: keyRange.hi,
        velLo: velRange.lo,
        velHi: velRange.hi,
        rootKey: rootKey,
        coarseTune: coarseTune,
        fineTune: fineTune,
        scaleTuning: scaleTuning || 100,
        start: start,
        end: end,
        loopStart: loopStart,
        loopEnd: loopEnd,
        loop: !!(genUnsignedChain(chain, 54, 0) & 1) && loopEnd > loopStart + 8,
        sampleRate: sample.sampleRate || 44100,
        attenuation: attenuation,
        gain: Math.max(0.02, Math.min(1.4, Math.pow(10, -attenuation / 200))),
        pan: Math.max(-1, Math.min(1, pan))
      };
    }

    function genMap(records, start, end) {
      var out = {};
      for (var i = start; i < end && i < records.length; i++) {
        out[records[i].op] = records[i].amount;
      }
      return out;
    }

    function genUnsigned(map, op, fallback) {
      return Object.prototype.hasOwnProperty.call(map, op) ? map[op] : fallback;
    }

    function genUnsignedChain(chain, op, fallback) {
      var value = fallback;
      for (var i = 0; i < chain.length; i++) {
        if (Object.prototype.hasOwnProperty.call(chain[i], op)) {
          value = chain[i][op];
        }
      }
      return value;
    }

    function genSignedChain(chain, op, fallback) {
      var value = fallback;
      for (var i = 0; i < chain.length; i++) {
        if (Object.prototype.hasOwnProperty.call(chain[i], op)) {
          value = signed16(chain[i][op]);
        }
      }
      return value;
    }

    function signedSum(chain, op) {
      var sum = 0;
      for (var i = 0; i < chain.length; i++) {
        if (Object.prototype.hasOwnProperty.call(chain[i], op)) {
          sum += signed16(chain[i][op]);
        }
      }
      return sum;
    }

    function genRange(chain, op, defaultLo, defaultHi) {
      var lo = defaultLo;
      var hi = defaultHi;
      for (var i = 0; i < chain.length; i++) {
        if (Object.prototype.hasOwnProperty.call(chain[i], op)) {
          var amount = chain[i][op];
          lo = Math.max(lo, amount & 0xFF);
          hi = Math.min(hi, (amount >> 8) & 0xFF);
        }
      }
      return { lo: lo, hi: hi };
    }

    function readInt16Array(view, offset, size) {
      var count = Math.floor(size / 2);
      var out = new Int16Array(count);
      for (var i = 0; i < count; i++) {
        out[i] = view.getInt16(offset + i * 2, true);
      }
      return out;
    }

    function readFourCC(view, offset) {
      return String.fromCharCode(
        view.getUint8(offset),
        view.getUint8(offset + 1),
        view.getUint8(offset + 2),
        view.getUint8(offset + 3)
      );
    }

    function readSf2Name(view, offset, length) {
      var out = "";
      for (var i = 0; i < length; i++) {
        var code = view.getUint8(offset + i);
        if (!code) {
          break;
        }
        out += String.fromCharCode(code);
      }
      return out;
    }

    function signed16(value) {
      return value & 0x8000 ? value - 0x10000 : value;
    }

    function clampInt(value, lo, hi) {
      value = Math.round(value);
      return Math.max(lo, Math.min(hi, value));
    }

    function noteNameToMidi(name) {
      var match = /^([A-G])([b#]?)(-?\d+)$/.exec(name);
      if (!match) {
        return null;
      }
      var semitone = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }[match[1]];
      if (match[2] === "#") {
        semitone++;
      } else if (match[2] === "b") {
        semitone--;
      }
      return (Number(match[3]) + 1) * 12 + semitone;
    }

    function frequencyFromPitch(pitch) {
      return 440 * Math.pow(2, (pitch - 69) / 12);
    }

    function velocityGain(velocity) {
      return Math.pow(Math.max(1, Math.min(127, velocity || 1)) / 127, 1.25);
    }

    function pianoVelocityGain(velocity) {
      var normalized = Math.max(1, Math.min(127, velocity || 1)) / 127;
      return Math.min(PIANO_JS_GAIN_LIMIT, (0.18 + Math.pow(normalized, 0.82) * 0.82) * PIANO_JS_GAIN);
    }

    function waveformForProgram(program) {
      if (program >= 40 && program <= 51) {
        return "sawtooth";
      }
      if (program >= 24 && program <= 31) {
        return "triangle";
      }
      if (program >= 56 && program <= 63) {
        return "square";
      }
      return "sine";
    }

    state.audioMode = state.audioMode || "piano";

    if (controls.systemSoundButton) {
      controls.systemSoundButton.addEventListener("click", function () {
        setMode("system");
      });
    }

    if (controls.jsSoundButton) {
      controls.jsSoundButton.addEventListener("click", function () {
        setMode("piano");
      });
    }

    if (controls.sf2FileButton && controls.sf2FileInput) {
      controls.sf2FileButton.addEventListener("click", function () {
        controls.sf2FileInput.click();
      });
      controls.sf2FileInput.addEventListener("change", function () {
        loadSf2File(controls.sf2FileInput.files && controls.sf2FileInput.files[0]);
      });
    }

    setStatus("Piano JS");
    updateModeButtons();

    var api = {
      prepare: prepare,
      schedule: schedule,
      stopAll: stopAll,
      resetCursor: resetCursor,
      startPreviewNote: startPreviewNote,
      loadPianoFile: loadPianoFile,
      loadSf2File: loadSf2File,
      debug: function () {
        return {
          mode: state.audioMode,
          status: state.audioStatus,
          pianoSamples: state.pianoBank ? state.pianoBank.samples.length : 0,
          sf2Zones: state.sf2Bank ? state.sf2Bank.zones.length : 0,
          midiOutput: state.midiOutput ? state.midiOutput.name : "",
          midiFallback: !!state.midiFallback,
          activeAudio: state.activeAudio ? state.activeAudio.length : 0,
          cursor: state.audioCursor || 0
        };
      }
    };
    root.midiWaterfallAudio = api;
    return api;
  }

  root.createMidiWaterfallAudio = createMidiWaterfallAudio;
})(window);
