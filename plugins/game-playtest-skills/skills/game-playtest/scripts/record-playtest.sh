#!/usr/bin/env bash
# Programmatic playtest recorder (macOS, ffmpeg/avfoundation). Screen stays fully visible.
# On Windows/Linux use OBS (or any recorder) with a mic track — the review pipeline only needs a video file.
# Usage:
#   record-playtest.sh devices                         # list avfoundation device indices
#   record-playtest.sh start [video_dev] [audio_dev]   # or env PLAYTEST_VIDEO_DEV / PLAYTEST_AUDIO_DEV
#   record-playtest.sh stop                            # finalizes the .mov, prints its path
#   record-playtest.sh status
# Output: $PLAYTEST_DIR (default ~/Movies/playtests)/playtest-<timestamp>.mov  (h264 + mic AAC)
# Device indices drift when audio devices change — run `devices` before the first recording.
set -euo pipefail

DIR="${PLAYTEST_DIR:-$HOME/Movies/playtests}"
PIDFILE="$DIR/.recorder.pid"
CURFILE="$DIR/.recorder.current"
mkdir -p "$DIR"

case "${1:?usage: record-playtest.sh devices|start|stop|status}" in
  devices)
    ffmpeg -hide_banner -f avfoundation -list_devices true -i "" 2>&1 | grep -E 'AVFoundation|\[[0-9]+\]' || true
    ;;
  start)
    if [[ -f "$PIDFILE" ]] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
      echo "already recording (pid $(cat "$PIDFILE"), file $(cat "$CURFILE"))"; exit 1
    fi
    VDEV="${2:-${PLAYTEST_VIDEO_DEV:?pass the screen device index (see: record-playtest.sh devices)}}"
    ADEV="${3:-${PLAYTEST_AUDIO_DEV:?pass the microphone device index (see: record-playtest.sh devices)}}"
    OUT="$DIR/playtest-$(date +%Y%m%d-%H%M%S).mov"
    nohup ffmpeg -hide_banner -loglevel error \
      -f avfoundation -capture_cursor 1 -framerate 30 -i "${VDEV}:${ADEV}" \
      -c:v h264_videotoolbox -b:v 4M -c:a aac -b:a 128k \
      "$OUT" > "$DIR/.recorder.log" 2>&1 &
    echo $! > "$PIDFILE"
    echo "$OUT" > "$CURFILE"
    sleep 2
    if ! kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
      echo "FAILED to start — check $DIR/.recorder.log (screen-recording permission for the terminal?)"
      exit 1
    fi
    echo "RECORDING -> $OUT  (stop with: record-playtest.sh stop)"
    ;;
  stop)
    [[ -f "$PIDFILE" ]] || { echo "not recording"; exit 1; }
    PID="$(cat "$PIDFILE")"
    kill -INT "$PID" 2>/dev/null || true
    for _ in $(seq 1 20); do kill -0 "$PID" 2>/dev/null || break; sleep 0.5; done
    rm -f "$PIDFILE"
    OUT="$(cat "$CURFILE")"
    echo "SAVED $OUT ($(du -h "$OUT" | cut -f1))"
    ;;
  status)
    if [[ -f "$PIDFILE" ]] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
      echo "recording (pid $(cat "$PIDFILE")) -> $(cat "$CURFILE")"
    else
      echo "idle"
    fi
    ;;
  *) echo "usage: record-playtest.sh devices|start|stop|status"; exit 1 ;;
esac
