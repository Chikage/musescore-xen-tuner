#!/bin/sh

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
JOB_PATH="$SCRIPT_DIR/midx_writer_job.txt"
PY_HELPER="$SCRIPT_DIR/midx_python_writer.py"
FALLBACK_DEBUG="$SCRIPT_DIR/midx_writer_job.debug.log"
DEBUG_PATH="$FALLBACK_DEBUG"

if [ -f "$JOB_PATH" ]; then
  JOB_DEBUG=$(awk -F= '$1 == "debug_path" { print substr($0, 12); exit }' "$JOB_PATH")
  if [ -n "$JOB_DEBUG" ]; then
    DEBUG_PATH="$JOB_DEBUG"
  fi
fi

log_line() {
  printf '%s\n' "$1"
  if [ -n "$DEBUG_PATH" ]; then
    printf '%s\n' "$1" >> "$DEBUG_PATH"
  fi
}

PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH
export PATH

log_line "SHELL_HELPER_PATH=$0"
log_line "SHELL_SCRIPT_DIR=$SCRIPT_DIR"
log_line "SHELL_CWD=$(pwd)"
log_line "SHELL_PATH=$PATH"
log_line "SHELL_JOB_PATH=$JOB_PATH"
log_line "SHELL_PY_HELPER=$PY_HELPER"

if command -v python3 >/dev/null 2>&1; then
  PYTHON_BIN=$(command -v python3)
elif [ -x /usr/bin/python3 ]; then
  PYTHON_BIN=/usr/bin/python3
elif command -v python >/dev/null 2>&1; then
  PYTHON_BIN=$(command -v python)
else
  log_line "ERROR_TYPE=PythonNotFound"
  log_line "ERROR: python3/python was not found in PATH or /usr/bin/python3"
  exit 127
fi

log_line "SHELL_PYTHON=$PYTHON_BIN"
"$PYTHON_BIN" "$PY_HELPER"
STATUS=$?
log_line "SHELL_EXIT=$STATUS"
exit $STATUS
