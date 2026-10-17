# Recording-driven playtest review

The developer plays and talks over it ("this jump feels floaty", "here — the door didn't open").
The recording IS the bug list: an unrecorded playtest is feedback lost.

## Recording

Any recorder works as long as the file has a **microphone track**: OBS (Windows/Linux/macOS),
QuickTime, ShareX, or this skill's `scripts/record-playtest.sh` on macOS:

```bash
scripts/record-playtest.sh devices            # find the screen + mic indices once
scripts/record-playtest.sh start 1 0          # <screen index> <mic index>, or env PLAYTEST_VIDEO_DEV / PLAYTEST_AUDIO_DEV
scripts/record-playtest.sh stop               # prints the .mov path
```

Mic picks up voice + game audio from the speakers; that's fine for review. In OBS, putting the
mic and the game/desktop audio on **separate tracks** gives a much cleaner transcript.

Start the recorder **before** the player touches the controller, and start any telemetry logger
(below) at the same time.

## Ingestion

```bash
scripts/ingest-recording.sh <video> [workdir]
```

1. Extracts `audio.wav` (16 kHz mono) and one frame every 5 s into `frames/`.
2. Transcribes with `whisper` if installed (`pip install openai-whisper`; `WHISPER_CMD` /
   `WHISPER_MODEL` override) → `audio.json` / `audio.srt` with segment timestamps.
3. Writes `meta.txt` (duration + creation time, for telemetry alignment).

Then, for every spoken issue, pull the exact frame(s): `ffmpeg -ss <t> -i <video> -frames:v 1 out.png`
at `t-2`, `t`, `t+2`, and Read them.

**Whisper hallucinates on silence.** Long quiet stretches produce invented lines ("Thank you.",
"Thanks for watching", repeated sentences, `[BLANK_AUDIO]`). If a recording has long silences,
chunk the audio (e.g. 45 s pieces), drop degenerate outputs, and check that speech actually exists
at a timestamp (the waveform/volume) before trusting a line there.

## Review protocol

1. Read the whole transcript first; list every segment that sounds like feedback
   ("doesn't work", "weird", "change this", "I don't like", laughter followed by critique).
2. For each: Read the frames at that timestamp ± 2 s. Identify the game state.
3. Cross-reference the code to a root cause where possible.
4. Output one row per issue (consolidate fragments of one thought):

   ```
   [03:41] "the imp fight is too easy" — screen: room 2, player full HP, 3 imps
           → cause: imp damage 2 vs player armor 4; fix: raise to ~10% max HP per hit
   ```
5. Anything ambiguous → quote the player verbatim and ask; don't guess intent.

## Telemetry alignment

A telemetry logger writes `{"wallclock_start": <epoch>}` as its first line, then inputs + watched
state only when they change. `video_time ≈ wallclock - wallclock_start` (recordings carry their
creation time: `ffprobe -show_entries format_tags=creation_time <video>`). A bug spoken at mm:ss
then maps to the exact inputs and state at that moment instead of a reproduction attempt.

Examples in `examples/`:
- `mgba-telemetry.lua` — mGBA (GBA) scripting: per-frame keys + RAM watches. Verified on mGBA 0.10.5.
- `godot_telemetry.gd` — Godot 4 autoload: pressed input actions + a `watch()` dictionary. Template — verify on first use.

The same idea ports anywhere you can run code each frame: a GZDoom ZScript `EventHandler`
(`WorldTick`) writing to the console log, or a C++ engine fork logging once per game tick.
