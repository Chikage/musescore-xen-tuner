(function (root) {
  "use strict";

  function createMidiWaterfallRenderer(options) {
    var state = options.state;
    var canvas = options.canvas;
    var ctx = canvas.getContext("2d");
    var parser = options.parser;
    var config = options.config;
    var MIN_PITCH = config.MIN_PITCH;
    var MAX_PITCH = config.MAX_PITCH;
    var NOTE_RANGE = config.NOTE_RANGE;
    var LOOKAHEAD_SECONDS = config.LOOKAHEAD_SECONDS;
    var NOTE_MIN_WIDTH = config.NOTE_MIN_WIDTH;
    var NOTE_MAX_WIDTH = config.NOTE_MAX_WIDTH;
    var SAME_KEY_GAP_PX = config.SAME_KEY_GAP_PX;
    var SAME_KEY_TIME_EPSILON = config.SAME_KEY_TIME_EPSILON;
    var SAME_KEY_PITCH_EPSILON = config.SAME_KEY_PITCH_EPSILON;
    var HIT_PARTICLE_MAX = config.HIT_PARTICLE_MAX;
    var HIT_PARTICLE_GRAVITY = config.HIT_PARTICLE_GRAVITY;
    var HIT_PARTICLE_CURSOR_EPSILON = config.HIT_PARTICLE_CURSOR_EPSILON;
    var KEY_IMPACT_LIFE = config.KEY_IMPACT_LIFE;
    var RULER_VELOCITY_MAX_DEPTH = config.RULER_VELOCITY_MAX_DEPTH;
    var OFFSET_CENT_RANGE = config.OFFSET_CENT_RANGE;
    var MANUAL_NOTE_FADE_DISTANCE = config.MANUAL_NOTE_FADE_DISTANCE;
    var MANUAL_NOTE_OFFSCREEN_MARGIN = config.MANUAL_NOTE_OFFSCREEN_MARGIN;
    var MANUAL_NOTE_MIN_SECONDS = config.MANUAL_NOTE_MIN_SECONDS;
    var MANUAL_NOTE_MIN_HEIGHT = config.MANUAL_NOTE_MIN_HEIGHT;
    var MANUAL_NOTE_MAX = config.MANUAL_NOTE_MAX;
    var NOTE_RENDER_LOOKBACK_SECONDS = config.NOTE_RENDER_LOOKBACK_SECONDS;
    var MAX_OCTAVE_DIVISIONS = config.MAX_OCTAVE_DIVISIONS || 53;
    var C_TICK_LENGTH_RATIO = 0.84;
    var C_TICK_ALPHA = 0.72;
    var C_DIVISION_ALPHA = 0.42;
    var PITCH_CENTER = (MIN_PITCH + MAX_PITCH) / 2;
    var tickToSeconds = parser.tickToSeconds;
    var secondsToTick = parser.secondsToTick;
    var scaleMarks = normalizeScaleMarks(options.scaleMarks || root.MidiWaterfallScaleMarks);
    var renderCache = {
      background: null,
      keyboard: null
    };

    function normalizeScaleMarks(source) {
      var marks = { "0": 1 };
      var scales = {};
      if (!source || !source.Mark || !source.Scale) {
        return { marks: marks, scales: scales };
      }

      var rawMarks = source.Mark || {};
      var markKeys = Object.keys(rawMarks);
      for (var i = 0; i < markKeys.length; i++) {
        var key = String(markKeys[i]);
        var ratio = Number(rawMarks[key]);
        if (isFinite(ratio) && ratio >= 0) {
          marks[key] = Math.min(1, ratio);
        }
      }
      if (!isFinite(marks["0"]) || marks["0"] <= 0) {
        marks["0"] = 1;
      }

      var rawScales = source.Scale || {};
      var scaleKeys = Object.keys(rawScales);
      for (var scaleIndex = 0; scaleIndex < scaleKeys.length; scaleIndex++) {
        var scaleKey = String(scaleKeys[scaleIndex]);
        var pattern = String(rawScales[scaleKey] || "");
        if (pattern) {
          scales[scaleKey] = pattern;
        }
      }
      return { marks: marks, scales: scales };
    }

    function currentOctaveDivisions() {
      return Math.max(0, Math.min(MAX_OCTAVE_DIVISIONS, Math.round(Number(state.octaveDivisions) || 0)));
    }

    function scalePatternForDivisions(divisions) {
      return scaleMarks.scales[String(divisions)] || "";
    }

    function markRatio(mark) {
      if (mark === "N") {
        return null;
      }
      var ratio = scaleMarks.marks[String(mark)];
      if (!isFinite(ratio) || ratio <= 0) {
        return null;
      }
      return Math.min(1, ratio);
    }

    function forEachVisibleScaleMark(callback) {
      var divisions = currentOctaveDivisions();
      var pattern = scalePatternForDivisions(divisions);
      if (!pattern) {
        return false;
      }

      var stepCount = divisions > 0 ? Math.min(divisions, pattern.length) : 1;
      var minPitch = visiblePitchMin();
      var maxPitch = visiblePitchMax();
      var startOctave = Math.floor((minPitch - 12) / 12);
      var endOctave = Math.ceil((maxPitch - 12) / 12);

      for (var octave = startOctave; octave <= endOctave; octave++) {
        var basePitch = (octave + 1) * 12;
        for (var step = 0; step < stepCount; step++) {
          var mark = pattern.charAt(step);
          var ratio = markRatio(mark);
          if (ratio === null) {
            continue;
          }
          var pitch = divisions > 0 ? basePitch + step * 12 / divisions : basePitch;
          if (pitch < minPitch || pitch > maxPitch) {
            continue;
          }
          callback({
            pitch: pitch,
            ratio: ratio,
            mark: mark,
            step: step,
            isC: step === 0
          });
        }
      }
      return true;
    }

    function tickBaseFromScaleMark(pitch, keyHeight, ratio, isC) {
      var safeRatio = Math.max(0, Math.min(1, Number(ratio) || 0));
      var midiPitch = Math.round(pitch);
      var pc = ((midiPitch % 12) + 12) % 12;
      return {
        isSemitone: true,
        midiPitch: midiPitch,
        pc: pc,
        isC: !!isC,
        tickLength: keyHeight * C_TICK_LENGTH_RATIO * safeRatio,
        stroke: "rgba(255,255,255," + (C_TICK_ALPHA * safeRatio) + ")",
        lineWidth: 0.9 + 0.5 * safeRatio
      };
    }

    function scaleTickBaseForPitch(pitch, keyHeight) {
      var divisions = currentOctaveDivisions();
      if (divisions <= 0) {
        return null;
      }
      var pattern = scalePatternForDivisions(divisions);
      if (!pattern) {
        return null;
      }

      var stepSize = 12 / divisions;
      var octave = Math.floor(pitch / 12) - 1;
      var basePitch = (octave + 1) * 12;
      var step = Math.round((pitch - basePitch) / stepSize);
      if (step < 0) {
        step += divisions;
        basePitch -= 12;
      } else if (step >= divisions) {
        step -= divisions;
        basePitch += 12;
      }

      var ratio = markRatio(pattern.charAt(step));
      return tickBaseFromScaleMark(basePitch + step * stepSize, keyHeight, ratio || 0, step === 0);
    }

    function collectMeasureLines(startTick, endTick) {
      var meters = state.meters.length ? state.meters : [{ tick: 0, numerator: 4, denominator: 4 }];
      var lines = [];
      var measureNumber = 1;
      for (var i = 0; i < meters.length; i++) {
        var meter = meters[i];
        var stepTicks = parser.measureTicks(meter, state.ticksPerQuarter);
        var segmentStart = Math.max(0, meter.tick);
        var segmentEnd = i + 1 < meters.length ? meters[i + 1].tick : endTick + stepTicks;
        if (segmentEnd <= segmentStart) {
          continue;
        }
        var firstIndex = Math.max(0, Math.ceil((startTick - segmentStart) / stepTicks));
        var lastIndex = Math.floor((Math.min(endTick, segmentEnd - 0.0001) - segmentStart) / stepTicks);
        for (var localIndex = firstIndex; localIndex <= lastIndex; localIndex++) {
          lines.push({
            tick: segmentStart + localIndex * stepTicks,
            number: measureNumber + localIndex
          });
        }
        measureNumber += Math.ceil((segmentEnd - segmentStart) / stepTicks);
      }
      return lines;
    }

  function waterfallOffsetCents() {
    return Math.max(-OFFSET_CENT_RANGE, Math.min(OFFSET_CENT_RANGE, Number(state.waterfallOffsetCents) || 0));
  }

  function waterfallOffsetSemitones() {
    return waterfallOffsetCents() / 100;
  }

  function pitchZoomScale() {
    return Math.max(0.25, Math.min(4, Number(state.pitchZoomScale) || 1));
  }

  function visiblePitchRange() {
    return NOTE_RANGE / pitchZoomScale();
  }

  function pitchPanSemitones() {
    var limit = Math.max(0, (NOTE_RANGE - visiblePitchRange()) / 2);
    return Math.max(-limit, Math.min(limit, Number(state.pitchPanSemitones) || 0));
  }

  function visiblePitchCenter() {
    return PITCH_CENTER + pitchPanSemitones();
  }

  function visiblePitchMin() {
    return visiblePitchCenter() - visiblePitchRange() / 2;
  }

  function visiblePitchMax() {
    return visiblePitchCenter() + visiblePitchRange() / 2;
  }

  function pitchToX(pitch, width) {
    return (pitch - visiblePitchMin()) / visiblePitchRange() * width;
  }

  function xToPitch(x, width) {
    return visiblePitchMin() + Math.max(0, Math.min(1, x / Math.max(1, width))) * visiblePitchRange();
  }

  function renderedPitchForNote(note) {
    if (!note) {
      return MIN_PITCH;
    }
    if (note.visualPitch !== undefined) {
      return Number(note.visualPitch) || MIN_PITCH;
    }
    return (Number(note.pitch) || MIN_PITCH) + waterfallOffsetSemitones();
  }

  function normalizedVelocity(velocity) {
    return Math.max(0, Math.min(1, (Number(velocity) || 0) / 127));
  }

  function impactKeyForPitch(pitch) {
    return String(Math.round(pitch * 10000));
  }

  function timeToY(time, height) {
    return keyboardTop(height) - (time - state.playhead) * state.pixelsPerSecond;
  }

  function keyboardHeight(height) {
    return Math.min(72, Math.max(42, height * 0.085));
  }

  function keyboardTop(height) {
    return height - keyboardHeight(height);
  }

  function trackHue(track) {
    var palette = [190, 28, 132, 48, 264, 158, 330, 88, 218, 12, 288, 116, 242, 176, 308, 68];
    var index = Math.abs(Math.round(track || 0)) % palette.length;
    return palette[index];
  }

  function createLayer(width, height) {
    var layer = document.createElement("canvas");
    layer.width = Math.max(1, Math.floor(width * state.dpr));
    layer.height = Math.max(1, Math.floor(height * state.dpr));
    var layerCtx = layer.getContext("2d");
    layerCtx.scale(state.dpr, state.dpr);
    return {
      canvas: layer,
      ctx: layerCtx,
      width: width,
      height: height,
      dpr: state.dpr,
      pitchZoomScale: pitchZoomScale(),
      pitchPanSemitones: pitchPanSemitones(),
      octaveDivisions: state.octaveDivisions
    };
  }

  function layerMatches(layer, width, height, includeOctave) {
    return !!(
      layer &&
      layer.width === width &&
      layer.height === height &&
      layer.dpr === state.dpr &&
      layer.pitchZoomScale === pitchZoomScale() &&
      layer.pitchPanSemitones === pitchPanSemitones() &&
      (!includeOctave || layer.octaveDivisions === state.octaveDivisions)
    );
  }

  function invalidateStaticLayers() {
    renderCache.background = null;
    renderCache.keyboard = null;
    requestDraw();
  }

    function requestDraw() {
      state.needsDraw = true;
    }

  function resizeCanvas() {
    var rect = canvas.getBoundingClientRect();
    var dpr = Math.max(1, root.devicePixelRatio || 1);
    var targetW = Math.max(1, Math.floor(rect.width * dpr));
    var targetH = Math.max(1, Math.floor(rect.height * dpr));
    if (canvas.width !== targetW || canvas.height !== targetH) {
      canvas.width = targetW;
      canvas.height = targetH;
      invalidateStaticLayers();
    }
    state.dpr = dpr;
  }

  function draw() {
    resizeCanvas();
    var width = canvas.width / state.dpr;
    var height = canvas.height / state.dpr;
    ctx.save();
    ctx.scale(state.dpr, state.dpr);
    ctx.clearRect(0, 0, width, height);
    drawCachedBackground(width, height);
    drawMeasureLines(width, height);
    drawPlayhead(width, height);
    if (state.notes.length) {
      drawNotes(width, height);
    }
    drawManualReverseNotes(width, height);
    drawCachedKeyboard(width, height);
    drawParticles(width, height);
    ctx.restore();
    state.needsDraw = false;
  }

  function keyboardTickBase(pitch, keyHeight) {
    var scaleTick = scaleTickBaseForPitch(pitch, keyHeight);
    if (scaleTick) {
      return scaleTick;
    }

    var isSemitone = Math.round(pitch * 2) % 2 === 0;
    var midiPitch = Math.round(pitch);
    var pc = ((midiPitch % 12) + 12) % 12;
    var natural = isNaturalPitchClass(pc);
    var isC = pc === 0 && isSemitone;
    var tickLength = keyHeight * 0.25;
    var stroke = "rgba(255,255,255,0.24)";
    var lineWidth = 1;

    if (isC) {
      tickLength = keyHeight * 0.84;
      stroke = "rgba(255,255,255,0.72)";
      lineWidth = 1.4;
    } else if (isSemitone && natural) {
      tickLength = keyHeight * 0.66;
      stroke = "rgba(255,255,255,0.55)";
      lineWidth = 1.2;
    } else if (isSemitone) {
      tickLength = keyHeight * 0.49;
      stroke = "rgba(255,255,255,0.38)";
    }

    return {
      isSemitone: isSemitone,
      midiPitch: midiPitch,
      pc: pc,
      isC: isC,
      tickLength: tickLength,
      stroke: stroke,
      lineWidth: lineWidth
    };
  }

  function activeImpact(impact) {
    if (!impact) {
      return null;
    }
    var progress = Math.max(0, Math.min(1, impact.life / impact.maxLife));
    var velocityRatio = Math.max(0, Math.min(1, impact.velocityRatio || 0));
    return {
      amount: Math.sin(progress * Math.PI) * velocityRatio,
      fade: Math.pow(progress, 0.72),
      velocityRatio: velocityRatio,
      hue: impact.hue
    };
  }

  function drawCachedBackground(width, height) {
    if (!layerMatches(renderCache.background, width, height, true)) {
      renderCache.background = createLayer(width, height);
      drawStaticBackground(renderCache.background.ctx, width, height);
    }
    ctx.drawImage(renderCache.background.canvas, 0, 0, width, height);
  }

  function drawStaticBackground(targetCtx, width, height) {
    var gradient = targetCtx.createLinearGradient(0, 0, 0, height);
    gradient.addColorStop(0, "#241a16");
    gradient.addColorStop(0.5, "#33190f");
    gradient.addColorStop(1, "#111315");
    targetCtx.fillStyle = gradient;
    targetCtx.fillRect(0, 0, width, height);

    drawOctaveDivisionLines(targetCtx, width, height);
  }

  function drawPlayhead(width, height) {
    var playY = timeToY(state.playhead, height);
    ctx.strokeStyle = "rgba(255,255,255,0.8)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, playY);
    ctx.lineTo(width, playY);
    ctx.stroke();
  }

  function drawOctaveDivisionLines(targetCtx, width, height) {
    if (drawScaleProfileDivisionLines(targetCtx, width, height)) {
      return;
    }

    var divisions = currentOctaveDivisions();
    if (divisions === 0) {
      return;
    }
    var minPitch = visiblePitchMin();
    var maxPitch = visiblePitchMax();
    var startOctave = Math.floor((minPitch - 12) / 12);
    var endOctave = Math.ceil((maxPitch - 12) / 12);

    targetCtx.save();
    targetCtx.strokeStyle = "rgba(255,255,255,0.12)";
    targetCtx.lineWidth = 1;
    targetCtx.setLineDash([4, 6]);

    for (var octave = startOctave; octave <= endOctave; octave++) {
      var basePitch = (octave + 1) * 12;
      for (var step = 1; step < divisions; step++) {
        var pitch = basePitch + step * 12 / divisions;
        if (pitch <= minPitch || pitch >= maxPitch) {
          continue;
        }
        var x = pitchToX(pitch, width);
        targetCtx.beginPath();
        targetCtx.moveTo(x, 0);
        targetCtx.lineTo(x, height);
        targetCtx.stroke();
      }
    }

    targetCtx.restore();
  }

  function drawScaleProfileDivisionLines(targetCtx, width, height) {
    targetCtx.save();
    var hasProfile = forEachVisibleScaleMark(function (entry) {
      var alpha = C_DIVISION_ALPHA * entry.ratio;
      var x = pitchToX(entry.pitch, width);
      targetCtx.strokeStyle = "rgba(255,255,255," + alpha + ")";
      targetCtx.lineWidth = entry.isC ? 1.25 : 1;
      if (!entry.isC) {
        targetCtx.setLineDash([4, 6]);
      } else {
        targetCtx.setLineDash([]);
      }
      targetCtx.beginPath();
      targetCtx.moveTo(x, 0);
      targetCtx.lineTo(x, height);
      targetCtx.stroke();
    });
    targetCtx.restore();
    return hasProfile;
  }

  function drawMeasureLines(width, height) {
    if (!state.notes.length) {
      return;
    }
    var visibleStart = Math.max(0, state.playhead - 1.5);
    var visibleEnd = state.playhead + LOOKAHEAD_SECONDS;
    var startTick = secondsToTick(visibleStart, state.tempoMap, state.ticksPerQuarter);
    var endTick = secondsToTick(visibleEnd, state.tempoMap, state.ticksPerQuarter);
    var lines = collectMeasureLines(startTick, endTick);

    ctx.save();
    ctx.font = "11px system-ui, sans-serif";
    ctx.textBaseline = "middle";
    for (var count = 0; count < lines.length && count < 160; count++) {
      var y = timeToY(tickToSeconds(lines[count].tick, state.tempoMap, state.ticksPerQuarter), height);
      if (y >= -16 && y <= height + 16) {
        ctx.strokeStyle = "rgba(255,255,255,0.20)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(width, y);
        ctx.stroke();
        ctx.fillStyle = "rgba(255,255,255,0.50)";
        ctx.fillText(String(lines[count].number), 8, y - 8);
      }
    }
    ctx.restore();
  }

  function drawNotes(width, height) {
    var visibleStart = state.playhead - 1.5;
    var visibleEnd = state.playhead + LOOKAHEAD_SECONDS;
    var startIndex = findNoteStartIndex(Math.max(0, visibleStart - NOTE_RENDER_LOOKBACK_SECONDS));
    for (var i = startIndex; i < state.notes.length; i++) {
      var note = state.notes[i];
      if (note.start > visibleEnd) {
        break;
      }
      if (note.end >= visibleStart) {
        drawOneNote(note, i, width, height);
      }
    }
    drawLongVisibleNotes(visibleStart, visibleEnd, width, height);
  }

  function findNoteStartIndex(target) {
    var lo = 0;
    var hi = state.notes.length;
    while (lo < hi) {
      var mid = Math.floor((lo + hi) / 2);
      if (state.notes[mid].start < target) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    return lo;
  }

  function drawLongVisibleNotes(visibleStart, visibleEnd, width, height) {
    for (var i = 0; i < state.longNotes.length; i++) {
      var note = state.longNotes[i];
      if (note.start <= visibleEnd && note.end >= visibleStart && note.start < visibleStart - NOTE_RENDER_LOOKBACK_SECONDS) {
        drawOneNote(note, -1, width, height);
      }
    }
  }

  function drawOneNote(note, index, width, height) {
    var x = pitchToX(renderedPitchForNote(note), width);
    var y1 = timeToY(note.start, height);
    var y2 = timeToY(note.end, height);
    var gap = index >= 0 ? sameKeyVisualGap(note, index, Math.abs(y2 - y1)) : { start: 0, end: 0 };
    var top = Math.min(y1, y2) + gap.end;
    var bottom = Math.max(y1, y2) - gap.start;
    if (bottom < -8 || top > height + 8) {
      return;
    }
    var clippedTop = Math.max(-8, top);
    var clippedBottom = Math.min(height + 8, bottom);
    var h = Math.max(4, clippedBottom - clippedTop);
    var semitoneWidth = width / NOTE_RANGE;
    var w = Math.max(NOTE_MIN_WIDTH, Math.min(NOTE_MAX_WIDTH, semitoneWidth * 0.16));
    var hue = trackHue(note.track);
    var alpha = 0.62 + Math.min(0.32, note.velocity / 127 * 0.32);
    var lightness = 48 + Math.min(14, note.velocity / 127 * 14);
    ctx.fillStyle = "hsla(" + hue + ", 84%, " + lightness + "%, " + alpha + ")";
    ctx.strokeStyle = "hsla(" + hue + ", 82%, 24%, 0.72)";
    ctx.lineWidth = 1;
    ctx.fillRect(x - w / 2, clippedTop, w, h);
    ctx.strokeRect(x - w / 2, clippedTop, w, h);
  }

  function currentVisualTime() {
    if (window.performance && window.performance.now) {
      return window.performance.now() / 1000;
    }
    return Date.now() / 1000;
  }

  function addManualReverseNote(note) {
    var now = currentVisualTime();
    var visual = {
      id: state.nextManualNoteId++,
      pitch: note.pitch,
      visualPitch: note.visualPitch,
      midiPitch: note.midiPitch,
      velocity: note.velocity,
      track: note.track,
      startedAt: now,
      releasedAt: null
    };
    state.manualNotes.push(visual);
    if (state.manualNotes.length > MANUAL_NOTE_MAX) {
      state.manualNotes.splice(0, state.manualNotes.length - MANUAL_NOTE_MAX);
    }
    requestDraw();
    return visual;
  }

  function updateManualReverseNote(visual, note) {
    if (!visual || !note) {
      return;
    }
    visual.pitch = note.pitch;
    visual.visualPitch = note.visualPitch;
    visual.midiPitch = note.midiPitch;
    visual.velocity = note.velocity;
    visual.track = note.track;
    requestDraw();
  }

  function releaseManualReverseNote(visual) {
    if (visual && visual.releasedAt === null) {
      visual.releasedAt = currentVisualTime();
      requestDraw();
    }
  }

  function drawManualReverseNotes(width, height) {
    if (!state.manualNotes.length) {
      return;
    }
    var now = currentVisualTime();
    var keyTop = keyboardTop(height);
    var kept = [];
    var semitoneWidth = width / NOTE_RANGE;
    var w = Math.max(NOTE_MIN_WIDTH + 1, Math.min(NOTE_MAX_WIDTH + 2, semitoneWidth * 0.22));

    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    for (var i = 0; i < state.manualNotes.length; i++) {
      var note = state.manualNotes[i];
      var releasedAt = note.releasedAt === null ? now : note.releasedAt;
      var heldSeconds = Math.max(MANUAL_NOTE_MIN_SECONDS, releasedAt - note.startedAt);
      var releaseAge = note.releasedAt === null ? 0 : now - note.releasedAt;
      var travel = releaseAge * state.pixelsPerSecond;
      var fadeDistance = Math.max(MANUAL_NOTE_FADE_DISTANCE, height * 0.92);
      var fade = note.releasedAt === null ? 1 : Math.max(0, 1 - travel / fadeDistance);
      var bottom = keyTop - travel;
      var top = bottom - Math.max(MANUAL_NOTE_MIN_HEIGHT, heldSeconds * state.pixelsPerSecond);

      if (fade <= 0 || bottom < -MANUAL_NOTE_OFFSCREEN_MARGIN) {
        continue;
      }
      kept.push(note);
      if (top > height || bottom < -12) {
        continue;
      }

      var x = pitchToX(note.visualPitch, width);
      var hue = trackHue(note.track);
      var velocity = Math.max(1, Math.min(127, note.velocity || 64));
      var alpha = (0.44 + velocity / 127 * 0.42) * (0.38 + fade * 0.62);
      var lightness = 54 + Math.min(18, velocity / 127 * 18);
      var clippedTop = Math.max(-8, top);
      var clippedBottom = Math.min(height + 8, bottom);
      var gradient = ctx.createLinearGradient(0, clippedTop, 0, clippedBottom);
      gradient.addColorStop(0, "hsla(" + hue + ", 96%, 74%, " + (alpha * 0.95) + ")");
      gradient.addColorStop(0.22, "hsla(" + hue + ", 92%, " + lightness + "%, " + alpha + ")");
      gradient.addColorStop(1, "hsla(" + hue + ", 82%, 36%, " + (alpha * 0.28) + ")");

      ctx.fillStyle = gradient;
      ctx.strokeStyle = "hsla(" + hue + ", 94%, 74%, " + (alpha * 0.58) + ")";
      ctx.lineWidth = 1;
      ctx.fillRect(x - w / 2, clippedTop, w, Math.max(3, clippedBottom - clippedTop));
      ctx.strokeRect(x - w / 2, clippedTop, w, Math.max(3, clippedBottom - clippedTop));
    }
    ctx.restore();
    state.manualNotes = kept;
  }

  function sameKeyVisualGap(note, index, pixelHeight) {
    if (pixelHeight < 8) {
      return { start: 0, end: 0 };
    }
    var maxGap = Math.min(SAME_KEY_GAP_PX, Math.max(0, pixelHeight / 3 - 1));
    return {
      start: hasSameKeyNeighbor(note, index, -1) ? maxGap : 0,
      end: hasSameKeyNeighbor(note, index, 1) ? maxGap : 0
    };
  }

  function hasSameKeyNeighbor(note, index, direction) {
    var limit = 16;
    for (var step = 1; step <= limit; step++) {
      var other = state.notes[index + step * direction];
      if (!other) {
        return false;
      }
      if (direction < 0 && other.end < note.start - SAME_KEY_TIME_EPSILON) {
        return false;
      }
      if (direction > 0 && other.start > note.end + SAME_KEY_TIME_EPSILON) {
        return false;
      }
      if (direction < 0 && isSameKeyContinuation(other, note)) {
        return true;
      }
      if (direction > 0 && isSameKeyContinuation(note, other)) {
        return true;
      }
    }
    return false;
  }

  function isSameKeyContinuation(first, second) {
    return !!(
      first &&
      second &&
      first.track === second.track &&
      first.channel === second.channel &&
      first.midiPitch === second.midiPitch &&
      Math.abs(first.pitch - second.pitch) <= SAME_KEY_PITCH_EPSILON &&
      Math.abs(first.end - second.start) <= SAME_KEY_TIME_EPSILON
    );
  }

  function drawCachedKeyboard(width, height) {
    if (!layerMatches(renderCache.keyboard, width, height, false)) {
      renderCache.keyboard = createLayer(width, height);
      drawKeyboardBase(renderCache.keyboard.ctx, width, height);
    }
    ctx.drawImage(renderCache.keyboard.canvas, 0, 0, width, height);
    drawKeyboardImpacts(width, height);
  }

  function drawKeyboardBase(targetCtx, width, height) {
    var keyHeight = keyboardHeight(height);
    var top = keyboardTop(height);
    var bottom = top + keyHeight;
    targetCtx.fillStyle = "#15181d";
    targetCtx.fillRect(0, top, width, keyHeight);
    targetCtx.fillStyle = "rgba(255,255,255,0.035)";
    targetCtx.fillRect(0, top, width, 1);

    targetCtx.save();
    targetCtx.lineCap = "butt";
    targetCtx.font = "10px system-ui, sans-serif";
    targetCtx.textAlign = "center";
    targetCtx.textBaseline = "top";
    if (drawScaleProfileKeyboard(targetCtx, width, height, keyHeight, top, bottom)) {
      targetCtx.restore();
      return;
    }

    var firstHalfStep = Math.floor(visiblePitchMin() * 2);
    var lastHalfStep = Math.ceil(visiblePitchMax() * 2);
    for (var halfStep = firstHalfStep; halfStep <= lastHalfStep; halfStep++) {
      var pitch = halfStep / 2;
      var x = pitchToX(pitch, width);
      var tick = keyboardTickBase(pitch, keyHeight);
      var tickLength = tick.tickLength;
      var stroke = tick.stroke;
      var lineWidth = tick.lineWidth;
      var isC4 = tick.midiPitch === 60 && tick.isC;

      if (isC4) {
        tickLength = Math.min(tickLength, keyHeight - 15);
      }

      targetCtx.strokeStyle = stroke;
      targetCtx.lineWidth = lineWidth;
      targetCtx.beginPath();
      targetCtx.moveTo(x, top);
      targetCtx.lineTo(x, top + tickLength);
      targetCtx.stroke();

      if (isC4) {
        targetCtx.fillStyle = "rgba(255,255,255,0.72)";
        targetCtx.fillText("C4", x, Math.min(bottom - 11, top + tickLength + 3));
      }
    }
    targetCtx.restore();
  }

  function drawScaleProfileKeyboard(targetCtx, width, height, keyHeight, top, bottom) {
    return forEachVisibleScaleMark(function (entry) {
      var tick = tickBaseFromScaleMark(entry.pitch, keyHeight, entry.ratio, entry.isC);
      var tickLength = tick.tickLength;
      var x = pitchToX(entry.pitch, width);
      var isC4 = tick.midiPitch === 60 && tick.isC;

      if (isC4) {
        tickLength = Math.min(tickLength, keyHeight - 15);
      }

      targetCtx.strokeStyle = tick.stroke;
      targetCtx.lineWidth = tick.lineWidth;
      targetCtx.beginPath();
      targetCtx.moveTo(x, top);
      targetCtx.lineTo(x, top + tickLength);
      targetCtx.stroke();

      if (isC4) {
        targetCtx.fillStyle = "rgba(255,255,255,0.72)";
        targetCtx.fillText("C4", x, Math.min(bottom - 11, top + tickLength + 3));
      }
    });
  }

  function drawKeyboardImpacts(width, height) {
    var keyHeight = keyboardHeight(height);
    var top = keyboardTop(height);
    var keys = Object.keys(state.keyImpacts);
    if (!keys.length) {
      return;
    }
    ctx.save();
    ctx.lineCap = "butt";
    for (var i = 0; i < keys.length; i++) {
      var entry = state.keyImpacts[keys[i]];
      var impact = activeImpact(entry);
      if (!entry || !impact) {
        continue;
      }
      var pitch = Number(entry.pitch);
      if (!isFinite(pitch)) {
        continue;
      }
      var tick = keyboardTickBase(pitch, keyHeight);
      var maxAmplitude = Math.max(0, keyHeight - 2 - tick.tickLength) * impact.velocityRatio;
      var tickLength = Math.min(keyHeight - 2, tick.tickLength + maxAmplitude * Math.sin(Math.max(0, Math.min(1, entry.life / entry.maxLife)) * Math.PI));
      var yOffset = -Math.min(4, keyHeight * 0.08) * impact.amount;
      ctx.strokeStyle = "hsla(" + impact.hue + ", 96%, 70%, " + (0.30 + impact.fade * (0.34 + impact.velocityRatio * 0.30)) + ")";
      ctx.lineWidth = tick.lineWidth + 1.8 * impact.amount;
      ctx.beginPath();
      var x = pitchToX(pitch, width);
      ctx.moveTo(x, top + yOffset);
      ctx.lineTo(x, top + yOffset + tickLength);
      ctx.stroke();
    }
    ctx.restore();
  }

  function resetHitParticles(playhead) {
    state.particles = [];
    state.keyImpacts = {};
    state.particleCursor = findParticleCursor(playhead || 0);
  }

  function findParticleCursor(playhead) {
    var target = Number(playhead) || 0;
    var lo = 0;
    var hi = state.notes.length;
    while (lo < hi) {
      var mid = Math.floor((lo + hi) / 2);
      if (state.notes[mid].start < target - HIT_PARTICLE_CURSOR_EPSILON) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    return lo;
  }

  function emitHitParticles(previousPlayhead, currentPlayhead) {
    if (!state.notes.length || currentPlayhead < previousPlayhead) {
      state.particleCursor = findParticleCursor(currentPlayhead);
      return;
    }

    var rect = canvas.getBoundingClientRect();
    var width = Math.max(1, rect.width);
    var hitY = keyboardTop(Math.max(1, rect.height));
    var cursor = Math.max(0, Math.min(state.particleCursor || 0, state.notes.length));
    while (cursor < state.notes.length && state.notes[cursor].start < previousPlayhead - HIT_PARTICLE_CURSOR_EPSILON) {
      cursor++;
    }
    while (cursor < state.notes.length && state.notes[cursor].start <= currentPlayhead + HIT_PARTICLE_CURSOR_EPSILON) {
      spawnNoteHitParticles(state.notes[cursor], width, hitY);
      cursor++;
    }
    state.particleCursor = cursor;
  }

  function spawnNoteHitParticles(note, width, hitY) {
    var hue = trackHue(note.track);
    var velocity = Math.max(1, Math.min(127, note.velocity || 64));
    var velocityScale = 0.55 + velocity / 127 * 0.85;
    var count = Math.round(5 + velocity / 127 * 8);
    var x = pitchToX(renderedPitchForNote(note), width);
    var spread = Math.max(2, width / NOTE_RANGE * 0.22);
    for (var i = 0; i < count; i++) {
      var upward = i % 4 !== 0;
      var life = 0.26 + Math.random() * 0.28;
      var vx = (Math.random() - 0.5) * 120 * velocityScale;
      var vy = upward ? (-90 - Math.random() * 155) * velocityScale : (34 + Math.random() * 86) * velocityScale;
      state.particles.push({
        x: x + (Math.random() - 0.5) * spread,
        y: hitY + (Math.random() - 0.5) * 3,
        vx: vx,
        vy: vy,
        life: life,
        maxLife: life,
        size: 1.2 + Math.random() * 2.2,
        hue: hue,
        lightness: 54 + Math.random() * 18
      });
    }
    if (state.particles.length > HIT_PARTICLE_MAX) {
      state.particles.splice(0, state.particles.length - HIT_PARTICLE_MAX);
    }
    triggerKeyImpact(note, hue, velocity);
    requestDraw();
  }

  function spawnManualHitParticles(note) {
    spawnNoteHitParticles(note, note.width, note.hitY);
  }

  function triggerKeyImpact(note, hue, velocity) {
    var pitch = renderedPitchForNote(note);
    state.keyImpacts[impactKeyForPitch(pitch)] = {
      pitch: pitch,
      life: KEY_IMPACT_LIFE,
      maxLife: KEY_IMPACT_LIFE,
      velocityRatio: normalizedVelocity(velocity),
      hue: hue
    };
    requestDraw();
  }

  function updateParticles(dt) {
    updateKeyImpacts(dt);
    if (!state.particles.length) {
      return;
    }
    var kept = [];
    var damping = Math.pow(0.18, dt);
    for (var i = 0; i < state.particles.length; i++) {
      var particle = state.particles[i];
      particle.life -= dt;
      if (particle.life <= 0) {
        continue;
      }
      particle.x += particle.vx * dt;
      particle.y += particle.vy * dt;
      particle.vy += HIT_PARTICLE_GRAVITY * dt;
      particle.vx *= damping;
      kept.push(particle);
    }
    state.particles = kept;
    requestDraw();
  }

  function updateKeyImpacts(dt) {
    var keys = Object.keys(state.keyImpacts);
    for (var i = 0; i < keys.length; i++) {
      var impact = state.keyImpacts[keys[i]];
      impact.life -= dt;
      if (impact.life <= 0) {
        delete state.keyImpacts[keys[i]];
      }
      requestDraw();
    }
  }

  function drawParticles(width, height) {
    if (!state.particles.length) {
      return;
    }
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.lineCap = "round";
    for (var i = 0; i < state.particles.length; i++) {
      var particle = state.particles[i];
      if (particle.x < -12 || particle.x > width + 12 || particle.y < -24 || particle.y > height + 24) {
        continue;
      }
      var alpha = Math.pow(Math.max(0, particle.life / particle.maxLife), 1.35);
      var size = particle.size * (1 + (1 - alpha) * 0.75);
      ctx.strokeStyle = "hsla(" + particle.hue + ", 92%, " + particle.lightness + "%, " + (alpha * 0.52) + ")";
      ctx.lineWidth = Math.max(1, size * 0.75);
      ctx.beginPath();
      ctx.moveTo(particle.x, particle.y);
      ctx.lineTo(particle.x - particle.vx * 0.018, particle.y - particle.vy * 0.018);
      ctx.stroke();
      ctx.fillStyle = "hsla(" + particle.hue + ", 96%, 72%, " + (alpha * 0.82) + ")";
      ctx.beginPath();
      ctx.arc(particle.x, particle.y, size, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  function isNaturalPitchClass(pc) {
    return pc === 0 || pc === 2 || pc === 4 || pc === 5 || pc === 7 || pc === 9 || pc === 11;
  }

  function noteFromRulerPointer(event) {
    var rect = canvas.getBoundingClientRect();
    var keyHeight = keyboardHeight(rect.height);
    var top = rect.height - keyHeight;
    var localX = event.clientX - rect.left;
    var localY = event.clientY - rect.top;
    if (localX < 0 || localX > rect.width || localY < top || localY > rect.height) {
      return null;
    }
    var rawPitch = xToPitch(localX, rect.width);
    var snappedPitch = quantizePitchToEdo(rawPitch);
    var pitch = snappedPitch - waterfallOffsetSemitones();
    var visualPitch = visualPitchForRuler(rawPitch, snappedPitch);
    var depth = Math.max(0, Math.min(keyHeight * RULER_VELOCITY_MAX_DEPTH, localY - top));
    var normalized = keyHeight > 0 ? Math.min(1, depth / (keyHeight * RULER_VELOCITY_MAX_DEPTH)) : 0;
    var velocity = Math.max(1, Math.min(127, Math.round(1 + normalized * 126)));
    return {
      pitch: pitch,
      visualPitch: visualPitch,
      midiPitch: Math.round(pitch),
      cents: (pitch - Math.round(pitch)) * 100,
      velocity: velocity,
      track: 0,
      channel: 0,
      program: 0,
      bankMsb: 0,
      bankLsb: 0,
      width: rect.width,
      hitY: top
    };
  }

  function quantizePitchToEdo(rawPitch) {
    var divisions = currentOctaveDivisions();
    if (divisions === 0) {
      return Math.max(MIN_PITCH, Math.min(MAX_PITCH, rawPitch));
    }
    var step = 12 / divisions;
    var octave = Math.floor(rawPitch / 12) - 1;
    var cPitch = (octave + 1) * 12;
    var rounded = cPitch + Math.round((rawPitch - cPitch) / step) * step;
    return Math.max(MIN_PITCH, Math.min(MAX_PITCH, rounded));
  }

  function visualPitchForRuler(rawPitch, snappedPitch) {
    var divisions = currentOctaveDivisions();
    if (divisions === 0) {
      return Math.max(MIN_PITCH, Math.min(MAX_PITCH, rawPitch));
    }
    return Math.max(MIN_PITCH, Math.min(MAX_PITCH, snappedPitch));
  }

  function sameManualPitchSlot(first, second) {
    return !!(
      first &&
      second &&
      Math.abs(first.visualPitch - second.visualPitch) < 0.0001
    );
  }

  function startManualVisualSegment(active, note) {
    var visual = addManualReverseNote(note);
    if (active) {
      active.visual = visual;
    }
    return visual;
  }

  function splitManualVisualSegment(active, note) {
    releaseManualReverseNote(active.visual);
    return startManualVisualSegment(active, note);
  }

    return {
      draw: draw,
      requestDraw: requestDraw,
      invalidateStaticLayers: invalidateStaticLayers,
      resetHitParticles: resetHitParticles,
      findParticleCursor: findParticleCursor,
      emitHitParticles: emitHitParticles,
      updateParticles: updateParticles,
      noteFromRulerPointer: noteFromRulerPointer,
      spawnManualHitParticles: spawnManualHitParticles,
      sameManualPitchSlot: sameManualPitchSlot,
      startManualVisualSegment: startManualVisualSegment,
      splitManualVisualSegment: splitManualVisualSegment,
      updateManualReverseNote: updateManualReverseNote,
      releaseManualReverseNote: releaseManualReverseNote
    };
  }

  root.createMidiWaterfallRenderer = createMidiWaterfallRenderer;
})(window);
