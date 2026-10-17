#!/usr/bin/env bash
# Ingest a playtest screen recording: extract audio, transcribe it (if a whisper CLI is installed),
# and dump anchor frames so every spoken note can be matched to what was on screen.
# Usage: ingest-recording.sh <video> [workdir]
# Output: <workdir>/audio.wav (16k mono), <workdir>/frames/f_<NNNN>.png (1 per 5s),
#         <workdir>/audio.json|.srt|.txt (transcript, when whisper ran),
#         <workdir>/meta.txt (duration + creation_time for telemetry alignment).
# Env: PLAYTEST_WORKDIR (default ~/playtests), WHISPER_CMD (default whisper), WHISPER_MODEL (default small).
# Targeted frames around spoken issues: pull separately with
#   ffmpeg -ss <t> -i <video> -frames:v 1 <out.png>
set -euo pipefail

VIDEO="${1:?usage: ingest-recording.sh <video> [workdir]}"
WORK="${2:-${PLAYTEST_WORKDIR:-$HOME/playtests}/review-$(date +%Y%m%d-%H%M%S)}"
mkdir -p "$WORK/frames"

ffmpeg -hide_banner -loglevel error -i "$VIDEO" -vn -ac 1 -ar 16000 "$WORK/audio.wav"
ffmpeg -hide_banner -loglevel error -i "$VIDEO" -vf fps=1/5 "$WORK/frames/f_%04d.png"
{
  echo "video: $VIDEO"
  ffprobe -v error -show_entries format=duration -show_entries format_tags=creation_time \
    -of default=noprint_wrappers=1 "$VIDEO"
  echo "frame_interval_s: 5  (frames/f_NNNN.png -> t = (NNNN-1)*5 s)"
} > "$WORK/meta.txt"

# Transcription: openai-whisper by default (pip install openai-whisper); WHISPER_CMD overrides.
W="${WHISPER_CMD:-whisper}"
if command -v "$W" >/dev/null 2>&1; then
  "$W" "$WORK/audio.wav" --model "${WHISPER_MODEL:-small}" --word_timestamps True \
    --condition_on_previous_text False --output_dir "$WORK" --output_format all >/dev/null
  echo "TRANSCRIPT $WORK/audio.json (timestamped segments), $WORK/audio.srt"
else
  echo "no '$W' on PATH: pip install openai-whisper (or set WHISPER_CMD) and re-run,"
  echo "or transcribe $WORK/audio.wav with any tool that keeps segment timestamps."
fi
echo "WORKDIR $WORK"
