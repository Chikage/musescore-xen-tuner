(function () {
  "use strict";

  var config = window.MidiWaterfallConfig;
  var parser = window.MidiWaterfallParser;
  var DEFAULT_TEMPO_US_PER_QUARTER = config.DEFAULT_TEMPO_US_PER_QUARTER;
  var LOOKAHEAD_SECONDS = config.LOOKAHEAD_SECONDS;
  var PREVIEW_UPDATE_CENTS = config.PREVIEW_UPDATE_CENTS;
  var PREVIEW_UPDATE_VELOCITY = config.PREVIEW_UPDATE_VELOCITY;
  var PREVIEW_VISUAL_CENTS = config.PREVIEW_VISUAL_CENTS;
  var PREVIEW_VISUAL_VELOCITY = config.PREVIEW_VISUAL_VELOCITY;
  var OFFSET_CENT_RANGE = config.OFFSET_CENT_RANGE;
  var PLAY_LABEL = "Play";
  var PAUSE_LABEL = "Pause";
  var LOADING_LABEL = "Loading";
  var TIME_ZOOM_MIN = 60;
  var TIME_ZOOM_DEFAULT = 160;
  var TIME_ZOOM_MAX = 420;
  var TIME_ZOOM_STEP = 10;
  var PITCH_ZOOM_MIN = 0.5;
  var PITCH_ZOOM_DEFAULT = 1;
  var PITCH_ZOOM_MAX = 2.5;
  var PITCH_ZOOM_STEP = 0.05;
  var PITCH_MOVE_STEP = 0.25;
  var SPEED_MIN = 0.2;
  var SPEED_MAX = 4;
  var SPEED_STEP = 0.05;
  var EDO_MIN = 0;
  var EDO_MAX = config.MAX_OCTAVE_DIVISIONS || 53;

  function createInitialState() {
    var tempos = [{ tick: 0, usPerQuarter: DEFAULT_TEMPO_US_PER_QUARTER }];
    var meters = [{ tick: 0, numerator: 4, denominator: 4 }];
    return {
      title: "",
      format: "",
      ticksPerQuarter: 480,
      tempos: tempos,
      meters: meters,
      tempoMap: parser.makeTempoMap(tempos, 480),
      rawEvents: [],
      notes: [],
      longNotes: [],
      duration: 0,
      playhead: 0,
      playing: false,
      lastFrame: 0,
      particles: [],
      manualNotes: [],
      nextManualNoteId: 1,
      particleCursor: 0,
      keyImpacts: {},
      activePointers: {},
      speed: 1,
      pixelsPerSecond: 160,
      pitchZoomScale: 1,
      pitchPanSemitones: 0,
      waterfallOffsetCents: 0,
      octaveDivisions: 12,
      dpr: 1,
      needsDraw: true,
      audioMode: "piano",
      audioStatus: "Piano JS",
      audioContext: null,
      masterGain: null,
      audioCursor: 0,
      activeAudio: [],
      pianoBank: null,
      pianoLoading: null,
      pianoFileName: "",
      sf2Bank: null,
      sf2Loading: null,
      sf2FileName: "",
      midiAccess: null,
      midiOutput: null,
      midiReady: false,
      midiFallback: false,
      midiActive: []
    };
  }

  var state = createInitialState();
  var canvas = document.getElementById("waterfall");
  var fileInput = document.getElementById("fileInput");
  var dropZone = document.getElementById("dropZone");
  var playButton = document.getElementById("playButton");
  var resetButton = document.getElementById("resetButton");
  var speedInput = document.getElementById("speedInput");
  var zoomJoystick = document.getElementById("zoomJoystick");
  var zoomInput = document.getElementById("zoomInput");
  var moveInput = document.getElementById("moveInput");
  var offsetInput = document.getElementById("offsetInput");
  var divisionInput = document.getElementById("divisionInput");
  var speedValue = document.getElementById("speedValue");
  var zoomValue = document.getElementById("zoomValue");
  var zoomTimeValue = document.getElementById("zoomTimeValue");
  var zoomPitchValue = document.getElementById("zoomPitchValue");
  var moveValue = document.getElementById("moveValue");
  var offsetValue = document.getElementById("offsetValue");
  var divisionValue = document.getElementById("divisionValue");
  var systemSoundButton = document.getElementById("systemSoundButton");
  var jsSoundButton = document.getElementById("jsSoundButton");
  var sf2FileButton = document.getElementById("sf2FileButton");
  var sf2FileInput = document.getElementById("sf2FileInput");
  var bpmValue = document.getElementById("bpmValue");
  var meterValue = document.getElementById("meterValue");
  var statsText = document.getElementById("statsText");
  var emptyState = document.getElementById("emptyState");
  var zoomJoystickPointer = null;
  var renderer = window.createMidiWaterfallRenderer({
    state: state,
    canvas: canvas,
    parser: parser,
    config: config,
    scaleMarks: window.MidiWaterfallScaleMarks
  });
  var audioEngine = window.createMidiWaterfallAudio(state, {
    systemSoundButton: systemSoundButton,
    jsSoundButton: jsSoundButton,
    sf2FileButton: sf2FileButton,
    sf2FileInput: sf2FileInput,
    onStatusChange: updateStats
  });
  window.midiWaterfallState = state;

  function loadFile(file) {
    var reader = new FileReader();
    reader.onload = function () {
      try {
        var parsed = parser.detectAndParse(reader.result, file.name);
        state.title = parsed.title;
        state.format = parsed.format;
        state.ticksPerQuarter = parsed.ticksPerQuarter;
        state.tempos = parsed.tempos;
        state.meters = parsed.meters;
        state.tempoMap = parsed.tempoMap;
        state.rawEvents = parsed.rawEvents;
        state.notes = parsed.notes;
        state.longNotes = parsed.longNotes || [];
        state.duration = parsed.duration;
        state.playhead = 0;
        state.playing = false;
        renderer.resetHitParticles(0);
        audioEngine.stopAll();
        audioEngine.resetCursor();
        setPlayButtonState("play");
        setEmptyStateVisible(false);
        updateStats();
        renderer.requestDraw();
        renderer.draw();
      } catch (err) {
        state.format = "";
        state.ticksPerQuarter = 480;
        state.duration = 0;
        state.rawEvents = [];
        state.notes = [];
        state.longNotes = [];
        state.playhead = 0;
        renderer.resetHitParticles(0);
        state.tempos = [{ tick: 0, usPerQuarter: DEFAULT_TEMPO_US_PER_QUARTER }];
        state.meters = [{ tick: 0, numerator: 4, denominator: 4 }];
        state.tempoMap = parser.makeTempoMap(state.tempos, state.ticksPerQuarter);
        state.playing = false;
        audioEngine.stopAll();
        setPlayButtonState("play");
        setEmptyStateVisible(true);
        statsText.textContent = "Parse failed: " + err.message;
        updateCurrentMetrics();
        renderer.requestDraw();
      }
    };
    reader.readAsArrayBuffer(file);
  }

  function currentTempoAtSecond(second) {
    var tempo = state.tempoMap[0];
    for (var i = 0; i < state.tempoMap.length; i++) {
      if (state.tempoMap[i].second <= second) {
        tempo = state.tempoMap[i];
      } else {
        break;
      }
    }
    return tempo;
  }

  function currentMeterAtTick(tick) {
    var meters = state.meters.length ? state.meters : [{ tick: 0, numerator: 4, denominator: 4 }];
    var meter = meters[0];
    for (var i = 0; i < meters.length; i++) {
      if (meters[i].tick <= tick) {
        meter = meters[i];
      } else {
        break;
      }
    }
    return meter;
  }

  function updateCurrentMetrics() {
    var tempo = currentTempoAtSecond(state.playhead);
    var currentTick = parser.secondsToTick(state.playhead, state.tempoMap, state.ticksPerQuarter);
    var meter = currentMeterAtTick(currentTick);
    bpmValue.textContent = (60000000 / tempo.usPerQuarter).toFixed(1);
    meterValue.textContent = meter.numerator + "/" + meter.denominator;
  }

  function updateStats() {
    updateCurrentMetrics();
    if (!state.notes.length) {
      statsText.textContent = "No file loaded | " + formatProgress(0, 0);
      return;
    }
    statsText.textContent = displayTitle(state.title) + " | " + state.format + " | " + state.notes.length + " notes | " + formatProgress(state.playhead, state.duration);
  }

  function setEmptyStateVisible(visible) {
    if (!emptyState) {
      return;
    }
    emptyState.classList.toggle("hidden", !visible);
  }

  function displayTitle(title) {
    var value = String(title || "").replace(/^.*[\\/]/, "");
    var withoutExtension = value.replace(/\.[^.\\/]+$/, "");
    return withoutExtension || value || "Untitled";
  }

  function formatProgress(current, total) {
    return formatClock(current) + "/" + formatClock(total);
  }

  function formatClock(seconds) {
    var safe = Math.max(0, Math.floor(Number(seconds) || 0));
    var minutes = Math.floor(safe / 60);
    var sec = safe % 60;
    return String(minutes) + ":" + (sec < 10 ? "0" : "") + String(sec);
  }

  function formatOffsetCents(cents) {
    var value = Math.round(Number(cents) || 0);
    return (value > 0 ? "+" : "") + value + " c";
  }

  function formatMoveSemitones(semitones) {
    var value = Math.round((Number(semitones) || 0) * 100) / 100;
    if (Math.abs(value) < 0.005) {
      value = 0;
    }
    return (value > 0 ? "+" : "") + value.toFixed(2).replace(/\.?0+$/, "") + " st";
  }

  function formatSpeed(speed) {
    return speed.toFixed(2) + "x";
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, Number(value) || 0));
  }

  function roundToStep(value, step) {
    return Math.round(value / step) * step;
  }

  function pixelsPerSecondFromZoomAxis(axis) {
    var value = axis < 0
      ? TIME_ZOOM_DEFAULT + axis * (TIME_ZOOM_DEFAULT - TIME_ZOOM_MIN)
      : TIME_ZOOM_DEFAULT + axis * (TIME_ZOOM_MAX - TIME_ZOOM_DEFAULT);
    return roundToStep(clamp(value, TIME_ZOOM_MIN, TIME_ZOOM_MAX), TIME_ZOOM_STEP);
  }

  function zoomAxisFromPixelsPerSecond(value) {
    var pixels = clamp(value, TIME_ZOOM_MIN, TIME_ZOOM_MAX);
    if (pixels < TIME_ZOOM_DEFAULT) {
      return (pixels - TIME_ZOOM_DEFAULT) / (TIME_ZOOM_DEFAULT - TIME_ZOOM_MIN);
    }
    return (pixels - TIME_ZOOM_DEFAULT) / (TIME_ZOOM_MAX - TIME_ZOOM_DEFAULT);
  }

  function pitchZoomFromAxis(axis) {
    var value = axis < 0
      ? PITCH_ZOOM_DEFAULT + axis * (PITCH_ZOOM_DEFAULT - PITCH_ZOOM_MIN)
      : PITCH_ZOOM_DEFAULT + axis * (PITCH_ZOOM_MAX - PITCH_ZOOM_DEFAULT);
    return roundToStep(clamp(value, PITCH_ZOOM_MIN, PITCH_ZOOM_MAX), PITCH_ZOOM_STEP);
  }

  function visiblePitchRangeForZoom(pitchZoomScale) {
    return config.NOTE_RANGE / clamp(pitchZoomScale || PITCH_ZOOM_DEFAULT, PITCH_ZOOM_MIN, PITCH_ZOOM_MAX);
  }

  function pitchMoveLimit(pitchZoomScale) {
    return Math.max(0, (config.NOTE_RANGE - visiblePitchRangeForZoom(pitchZoomScale)) / 2);
  }

  function clampPitchPan(pitchPanSemitones, pitchZoomScale) {
    var limit = pitchMoveLimit(pitchZoomScale);
    return clamp(roundToStep(pitchPanSemitones, PITCH_MOVE_STEP), -limit, limit);
  }

  function axisFromPitchZoom(value) {
    var scale = clamp(value || PITCH_ZOOM_DEFAULT, PITCH_ZOOM_MIN, PITCH_ZOOM_MAX);
    if (scale < PITCH_ZOOM_DEFAULT) {
      return (scale - PITCH_ZOOM_DEFAULT) / (PITCH_ZOOM_DEFAULT - PITCH_ZOOM_MIN);
    }
    return (scale - PITCH_ZOOM_DEFAULT) / (PITCH_ZOOM_MAX - PITCH_ZOOM_DEFAULT);
  }

  function formatZoomTimeValue() {
    return Math.round(state.pixelsPerSecond) + " px/s";
  }

  function formatZoomPitchValue() {
    return state.pitchZoomScale.toFixed(2) + "x";
  }

  function formatZoomValue() {
    return formatZoomTimeValue() + " / " + formatZoomPitchValue();
  }

  function updateZoomJoystickVisual() {
    var xAxis = axisFromPitchZoom(state.pitchZoomScale);
    var yAxis = zoomAxisFromPixelsPerSecond(state.pixelsPerSecond);
    if (zoomJoystick) {
      zoomJoystick.style.setProperty("--joy-x", xAxis.toFixed(4));
      zoomJoystick.style.setProperty("--joy-y", (-yAxis).toFixed(4));
      zoomJoystick.setAttribute("aria-label", "Zoom: " + formatZoomValue());
    }
    if (zoomInput) {
      zoomInput.value = String(state.pixelsPerSecond);
    }
    if (zoomValue) {
      if (zoomJoystick && zoomTimeValue && zoomPitchValue) {
        zoomTimeValue.textContent = formatZoomTimeValue();
        zoomPitchValue.textContent = formatZoomPitchValue();
      } else {
        zoomValue.textContent = zoomJoystick ? formatZoomValue() : formatZoomTimeValue();
      }
    }
  }

  function updateMoveControl() {
    var limit = pitchMoveLimit(state.pitchZoomScale);
    var pan = clampPitchPan(state.pitchPanSemitones, state.pitchZoomScale);
    state.pitchPanSemitones = pan;
    if (moveInput) {
      moveInput.min = String(-limit);
      moveInput.max = String(limit);
      moveInput.step = String(PITCH_MOVE_STEP);
      moveInput.disabled = limit <= 0.0001;
      moveInput.value = String(pan);
      moveInput.setAttribute("aria-label", "Move visible pitch range: " + formatMoveSemitones(pan));
    }
    if (moveValue) {
      moveValue.textContent = formatMoveSemitones(pan);
    }
  }

  function applySpeedInput() {
    var value = clamp(roundToStep(Number(speedInput && speedInput.value) || 1, SPEED_STEP), SPEED_MIN, SPEED_MAX);
    state.speed = value;
    if (speedInput) {
      speedInput.value = value.toFixed(2);
      speedInput.setAttribute("aria-label", "Playback speed: " + formatSpeed(value));
    }
    if (speedValue) {
      speedValue.textContent = formatSpeed(value);
    }
    if (state.playing) {
      stopAllRulerPointers();
      audioEngine.stopAll();
      audioEngine.resetCursor();
      renderer.requestDraw();
    }
  }

  function applyZoomValues(nextPixelsPerSecond, nextPitchZoomScale) {
    var pixels = clamp(roundToStep(nextPixelsPerSecond, TIME_ZOOM_STEP), TIME_ZOOM_MIN, TIME_ZOOM_MAX);
    var pitchScale = clamp(roundToStep(nextPitchZoomScale, PITCH_ZOOM_STEP), PITCH_ZOOM_MIN, PITCH_ZOOM_MAX);
    var nextPitchPan = clampPitchPan(state.pitchPanSemitones, pitchScale);
    var pitchChanged = Math.abs(pitchScale - state.pitchZoomScale) > 0.0001;
    var timeChanged = Math.abs(pixels - state.pixelsPerSecond) > 0.0001;
    var moveChanged = Math.abs(nextPitchPan - state.pitchPanSemitones) > 0.0001;
    if (!pitchChanged && !timeChanged && !moveChanged) {
      return;
    }
    state.pixelsPerSecond = pixels;
    state.pitchZoomScale = pitchScale;
    state.pitchPanSemitones = nextPitchPan;
    updateZoomJoystickVisual();
    updateMoveControl();
    if (pitchChanged || moveChanged) {
      renderer.invalidateStaticLayers();
    } else {
      renderer.requestDraw();
    }
    renderer.draw();
  }

  function applyZoomAxes(xAxis, yAxis) {
    applyZoomValues(
      pixelsPerSecondFromZoomAxis(yAxis),
      pitchZoomFromAxis(xAxis)
    );
  }

  function zoomAxesFromPointer(event) {
    if (!zoomJoystick) {
      return { x: 0, y: 0 };
    }
    var rect = zoomJoystick.getBoundingClientRect();
    var radius = Math.max(1, Math.min(rect.width, rect.height) / 2);
    var xAxis = ((event.clientX - rect.left) - rect.width / 2) / radius;
    var yAxis = (rect.height / 2 - (event.clientY - rect.top)) / radius;
    var length = Math.sqrt(xAxis * xAxis + yAxis * yAxis);
    if (length > 1) {
      xAxis /= length;
      yAxis /= length;
    }
    return {
      x: clamp(xAxis, -1, 1),
      y: clamp(yAxis, -1, 1)
    };
  }

  function setPlayButtonState(stateName) {
    var label = stateName === "pause" ? PAUSE_LABEL : stateName === "loading" ? LOADING_LABEL : PLAY_LABEL;
    playButton.dataset.state = stateName;
    playButton.setAttribute("aria-label", label);
    playButton.title = label;
  }

  function startRulerPreview(event) {
    var pointerId = event.pointerId;
    var note = renderer.noteFromRulerPointer(event);
    if (!note) {
      return;
    }
    event.preventDefault();
    if (canvas.setPointerCapture) {
      try {
        canvas.setPointerCapture(pointerId);
      } catch (err) {
        // Pointer capture is best-effort; audio preview still works without it.
      }
    }
    stopRulerPointer(pointerId);
    state.activePointers[pointerId] = {
      note: note,
      entry: null,
      pending: true,
      visual: null
    };
    renderer.startManualVisualSegment(state.activePointers[pointerId], note);
    renderer.spawnManualHitParticles(note);
    audioEngine.startPreviewNote(note).then(function (entry) {
      var active = state.activePointers[pointerId];
      if (!active || active.note !== note) {
        stopPreviewEntry(entry);
        return;
      }
      active.entry = entry;
      active.pending = false;
    }).catch(function (err) {
      var active = state.activePointers[pointerId];
      if (active) {
        renderer.releaseManualReverseNote(active.visual);
        delete state.activePointers[pointerId];
      }
      state.audioStatus = "Preview failed: " + err.message;
      updateStats();
    });
  }

  function moveRulerPreview(event) {
    var pointerId = event.pointerId;
    var active = state.activePointers[pointerId];
    if (!active) {
      return;
    }
    var note = renderer.noteFromRulerPointer(event);
    if (!note) {
      stopRulerPointer(pointerId);
      return;
    }
    event.preventDefault();
    var pitchDeltaCents = Math.abs(note.pitch - active.note.pitch) * 100;
    var velocityDelta = Math.abs(note.velocity - active.note.velocity);
    if (pitchDeltaCents < PREVIEW_UPDATE_CENTS && velocityDelta < PREVIEW_UPDATE_VELOCITY) {
      return;
    }
    if (active.entry && active.entry.update && active.entry.update(note) !== false) {
      if (renderer.sameManualPitchSlot(active.note, note)) {
        renderer.updateManualReverseNote(active.visual, note);
      } else {
        renderer.splitManualVisualSegment(active, note);
      }
      active.note = note;
      if (pitchDeltaCents >= PREVIEW_VISUAL_CENTS || velocityDelta >= PREVIEW_VISUAL_VELOCITY) {
        renderer.spawnManualHitParticles(note);
      }
      return;
    }
    restartRulerPreview(pointerId, note);
  }

  function restartRulerPreview(pointerId, note) {
    var active = state.activePointers[pointerId];
    if (!active) {
      return;
    }
    stopPreviewEntry(active.entry);
    if (renderer.sameManualPitchSlot(active.note, note)) {
      renderer.updateManualReverseNote(active.visual, note);
    } else {
      renderer.splitManualVisualSegment(active, note);
    }
    active.note = note;
    active.entry = null;
    active.pending = true;
    renderer.spawnManualHitParticles(note);
    audioEngine.startPreviewNote(note).then(function (entry) {
      var latest = state.activePointers[pointerId];
      if (!latest || latest.note !== note) {
        stopPreviewEntry(entry);
        return;
      }
      latest.entry = entry;
      latest.pending = false;
    }).catch(function (err) {
      var latest = state.activePointers[pointerId];
      if (latest) {
        renderer.releaseManualReverseNote(latest.visual);
        delete state.activePointers[pointerId];
      }
      state.audioStatus = "Preview failed: " + err.message;
      updateStats();
    });
  }

  function stopRulerPointer(pointerId) {
    var active = state.activePointers[pointerId];
    if (!active) {
      return;
    }
    stopPreviewEntry(active.entry);
    renderer.releaseManualReverseNote(active.visual);
    delete state.activePointers[pointerId];
  }

  function stopAllRulerPointers() {
    var ids = Object.keys(state.activePointers);
    for (var i = 0; i < ids.length; i++) {
      stopRulerPointer(ids[i]);
    }
  }

  function stopPreviewEntry(entry) {
    if (entry && entry.stop) {
      entry.stop();
    }
  }

  function frame(timestamp) {
    if (!state.lastFrame) {
      state.lastFrame = timestamp;
    }
    var dt = Math.min(0.08, (timestamp - state.lastFrame) / 1000);
    state.lastFrame = timestamp;
    var hasDynamicParticles = state.particles.length > 0 || Object.keys(state.keyImpacts).length > 0;
    if (state.playing) {
      var previousPlayhead = state.playhead;
      state.playhead += dt * state.speed;
      renderer.emitHitParticles(previousPlayhead, state.playhead);
      audioEngine.schedule();
      if (state.playhead > state.duration + LOOKAHEAD_SECONDS) {
        state.playing = false;
        setPlayButtonState("play");
        audioEngine.stopAll();
      }
      updateStats();
      renderer.requestDraw();
    }
    if (hasDynamicParticles) {
      renderer.updateParticles(dt);
    }
    if (state.needsDraw || state.playing || state.manualNotes.length || state.particles.length || Object.keys(state.keyImpacts).length) {
      renderer.draw();
    }
    requestAnimationFrame(frame);
  }

  fileInput.addEventListener("change", function () {
    if (fileInput.files && fileInput.files[0]) {
      loadFile(fileInput.files[0]);
    }
  });

  dropZone.addEventListener("dragover", function (event) {
    event.preventDefault();
    dropZone.classList.add("dragging");
  });

  dropZone.addEventListener("dragleave", function () {
    dropZone.classList.remove("dragging");
  });

  dropZone.addEventListener("drop", function (event) {
    event.preventDefault();
    dropZone.classList.remove("dragging");
    if (event.dataTransfer.files && event.dataTransfer.files[0]) {
      loadFile(event.dataTransfer.files[0]);
    }
  });

  playButton.addEventListener("click", function () {
    if (!state.notes.length) {
      return;
    }
    if (state.playing) {
      state.playing = false;
      stopAllRulerPointers();
      audioEngine.stopAll();
      setPlayButtonState("play");
      updateStats();
      renderer.requestDraw();
      return;
    }
    setPlayButtonState("loading");
    audioEngine.prepare().then(function () {
      stopAllRulerPointers();
      audioEngine.stopAll();
      audioEngine.resetCursor();
      state.particleCursor = renderer.findParticleCursor(state.playhead);
      state.playing = true;
      state.lastFrame = 0;
      setPlayButtonState("pause");
      updateStats();
      renderer.requestDraw();
    }).catch(function (err) {
      state.playing = false;
      state.audioStatus = "Audio failed: " + err.message;
      setPlayButtonState("play");
      updateStats();
      renderer.requestDraw();
    });
  });

  resetButton.addEventListener("click", function () {
    state.playhead = 0;
    state.playing = false;
    renderer.resetHitParticles(0);
    stopAllRulerPointers();
    audioEngine.stopAll();
    audioEngine.resetCursor();
    setPlayButtonState("play");
    updateStats();
    renderer.requestDraw();
    renderer.draw();
  });

  if (speedInput) {
    speedInput.addEventListener("input", function () {
      applySpeedInput();
    });
  }

  if (zoomInput) {
    zoomInput.addEventListener("input", function () {
      applyZoomValues(Number(zoomInput.value) || TIME_ZOOM_DEFAULT, state.pitchZoomScale);
    });
  }

  if (zoomJoystick) {
    zoomJoystick.addEventListener("pointerdown", function (event) {
      event.preventDefault();
      zoomJoystickPointer = event.pointerId;
      if (zoomJoystick.setPointerCapture) {
        zoomJoystick.setPointerCapture(event.pointerId);
      }
      var axes = zoomAxesFromPointer(event);
      applyZoomAxes(axes.x, axes.y);
    });

    zoomJoystick.addEventListener("pointermove", function (event) {
      if (zoomJoystickPointer !== event.pointerId) {
        return;
      }
      event.preventDefault();
      var axes = zoomAxesFromPointer(event);
      applyZoomAxes(axes.x, axes.y);
    });
  }

  function stopZoomJoystickPointer(event) {
    if (zoomJoystickPointer === event.pointerId) {
      zoomJoystickPointer = null;
    }
  }

  if (zoomJoystick) {
    zoomJoystick.addEventListener("pointerup", stopZoomJoystickPointer);
    zoomJoystick.addEventListener("pointercancel", stopZoomJoystickPointer);
    zoomJoystick.addEventListener("lostpointercapture", stopZoomJoystickPointer);

    zoomJoystick.addEventListener("keydown", function (event) {
      var handled = true;
      if (event.key === "ArrowUp") {
        applyZoomValues(state.pixelsPerSecond + TIME_ZOOM_STEP, state.pitchZoomScale);
      } else if (event.key === "ArrowDown") {
        applyZoomValues(state.pixelsPerSecond - TIME_ZOOM_STEP, state.pitchZoomScale);
      } else if (event.key === "ArrowRight") {
        applyZoomValues(state.pixelsPerSecond, state.pitchZoomScale + PITCH_ZOOM_STEP);
      } else if (event.key === "ArrowLeft") {
        applyZoomValues(state.pixelsPerSecond, state.pitchZoomScale - PITCH_ZOOM_STEP);
      } else if (event.key === "Home") {
        applyZoomValues(TIME_ZOOM_DEFAULT, PITCH_ZOOM_DEFAULT);
      } else {
        handled = false;
      }
      if (handled) {
        event.preventDefault();
      }
    });
  }

  if (moveInput) {
    moveInput.addEventListener("input", function () {
      var value = clampPitchPan(Number(moveInput.value) || 0, state.pitchZoomScale);
      if (Math.abs(value - state.pitchPanSemitones) <= 0.0001) {
        updateMoveControl();
        return;
      }
      state.pitchPanSemitones = value;
      updateMoveControl();
      renderer.invalidateStaticLayers();
      renderer.draw();
    });
  }

  if (offsetInput) {
    offsetInput.addEventListener("input", function () {
      var value = Math.max(-OFFSET_CENT_RANGE, Math.min(OFFSET_CENT_RANGE, Math.round(Number(offsetInput.value) || 0)));
      state.waterfallOffsetCents = value;
      offsetInput.value = String(value);
      if (offsetValue) {
        offsetValue.textContent = formatOffsetCents(value);
      }
      renderer.requestDraw();
      renderer.draw();
    });
  }

  divisionInput.addEventListener("input", function () {
    var value = Math.max(EDO_MIN, Math.min(EDO_MAX, Math.round(Number(divisionInput.value) || 0)));
    state.octaveDivisions = value;
    divisionInput.value = String(value);
    divisionValue.textContent = String(value);
    renderer.invalidateStaticLayers();
    renderer.draw();
  });

  canvas.addEventListener("pointerdown", startRulerPreview);
  canvas.addEventListener("pointermove", moveRulerPreview);
  canvas.addEventListener("pointerup", function (event) {
    stopRulerPointer(event.pointerId);
  });
  canvas.addEventListener("pointercancel", function (event) {
    stopRulerPointer(event.pointerId);
  });
  canvas.addEventListener("lostpointercapture", function (event) {
    stopRulerPointer(event.pointerId);
  });

  window.addEventListener("resize", function () {
    renderer.requestDraw();
    renderer.draw();
  });

  requestAnimationFrame(frame);
  updateZoomJoystickVisual();
  applySpeedInput();
  updateMoveControl();
  updateStats();
  renderer.draw();
})();
