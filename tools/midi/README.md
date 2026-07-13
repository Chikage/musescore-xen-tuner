# MIDI tools

## MIDX / MIDI 2.0 to pitch-bend MIDI

`midx-to-pitch-bend-midi.py` converts either Xen Tuner MIDX or the repository's
`SMF2CLIP` MIDI 2.0 format to a standard MIDI 1.0 file. It uses only the Python
standard library.

The MuseScore `Export MIDX` plugin runs the same converter automatically and
writes `<score>.pitch-bend.mid` beside its `.midx` and `.midi2` outputs.

```sh
python3 tools/midi/midx-to-pitch-bend-midi.py score.midx
python3 tools/midi/midx-to-pitch-bend-midi.py score.midi2 score.mid
python3 tools/midi/midx-to-pitch-bend-midi.py score.midx score.mid --bend-range 2
```

When the output path is omitted, the input extension is replaced with
`.pitch-bend.mid` so an existing conventional MIDI export is not overwritten.
The converter writes RPN 0 pitch-bend-range setup events, bank/program changes,
tempo events, and dynamically assigned note channels. Concurrent notes with the
same bank, program, and bend share a channel; incompatible bends use separate
channels. MIDI channel 10 is retained for General MIDI percussion, leaving 15
melodic channels. Pitch offsets on percussion notes are ignored. If more than
15 incompatible states overlap, the state whose
notes end soonest is reclaimed and the conversion summary reports a channel
steal.

The pitch-bend range defaults to 2 semitones and is written into the output
file, so a player that honors RPN 0 needs no manual range setup. The conversion
preserves note timing, velocity, tempo, and the bank/program active at each note
onset. Other source controller, SysEx, text, and aftertouch events are not copied.
