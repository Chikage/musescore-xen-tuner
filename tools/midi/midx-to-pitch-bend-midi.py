#!/usr/bin/env python3
"""Command-line entry point for the bundled MIDX/MIDI2 converter."""

from __future__ import print_function

import os
import sys


ROOT_DIR = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
PLUGIN_DIR = os.path.join(ROOT_DIR, "Xen Tuner")
if PLUGIN_DIR not in sys.path:
    sys.path.insert(0, PLUGIN_DIR)

from midx_pitch_bend_converter import main


if __name__ == "__main__":
    raise SystemExit(main())
