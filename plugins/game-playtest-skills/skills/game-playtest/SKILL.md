---
name: game-playtest
description: Playtest loop for game development — recording-driven playtest review (screen recording + spoken commentary → timestamped, screenshotted bug list), input/state telemetry aligned to the recording, headless agentic playtesting (agent drives the game step by step and reads screenshots), build contracts, and an approval-gated fix-and-verify loop. Auto-activates on "playtest", "review my playtest recording/video", "game bug at timestamp", "I recorded a playtest", "go through my playtest", "turn this recording into a bug list", "telemetry for my game", "agent plays the game", "verify the fix in-game", "game build". Engine-agnostic (Godot, GZDoom, custom C++ engines, emulators, web games).
---

# Game Playtest

Four pillars: **recording-driven review**, **telemetry**, **headless agentic playtesting**, and a
**fix-verification loop** that never trusts a green build. Engine-agnostic. For browser games,
pair with the `web-playtest` skill (real mouse/keyboard/touch input).

## Pillar 1 — Recording-driven playtest review

The developer plays and narrates; the recording becomes the bug list.

1. **Recorder ON before the controller is touched** — OBS or any recorder with a mic track, or
   `scripts/record-playtest.sh start <screen> <mic>` on macOS (`devices` lists indices).
2. `scripts/ingest-recording.sh <video>` — audio extract, whisper transcript with timestamps
   (if installed), a frame every 5 s.
3. For every spoken issue, Read the frames at that timestamp ± 2 s, find the game state, and
   trace it to code.

Full procedure, whisper pitfalls and output format: [recording-review.md](resources/recording-review.md).

## Pillar 2 — Telemetry aligned to the recording (optional, high value)

A logger that writes inputs + a few watched values **only when they change**, with a wallclock
start line, turns "it broke here at 3:41" into the exact inputs and state at that frame — no
reproduction needed. Examples: `examples/mgba-telemetry.lua` (mGBA, verified),
`examples/godot_telemetry.gd` (Godot 4 autoload, template). Same pattern for a GZDoom ZScript
`EventHandler.WorldTick` or a per-tick log line in a C++ engine fork.

## Pillar 3 — Headless agentic playtesting

Give the agent a **one-shot step CLI**: load state → apply input tokens → save state → write a
uniquely-numbered screenshot (and print key state: position, HP, current map). The agent Reads
each shot and chooses the next inputs — an agentic loop, not a fixed script.

- Build it on whatever the engine offers: a debug console command, a command-line flag that
  replays an input file, an emulator's scripting API, or `web-playtest` for HTML5 builds.
- **Print state as text every step** (position, map, HP, current music/scene id). Steering by
  numbers beats steering by pixels, and "same song?" is proven by two equal ids, not by ear.
- **Savestates usually die with the binary.** Expect to re-drive after a rebuild, or keep
  engine-level save files / checkpoints that survive rebuilds.
- **Checkpoints, not intros.** Bake save files that drop straight into the scene under test,
  so neither the agent nor the developer replays the intro to check one fix.
- Pace inputs (`A wait30`, not `A x10`) — text boxes and transitions eat mashed inputs.
- Screenshot to CONFIRM a menu is open before sending cursor + confirm inputs.
- Audio can't be heard headlessly: assert on the engine's sound/music state instead.

## Build contracts (always)

A build wrapper's exit code can lie (trailing pipes). Grep the log:
- success line present exactly as often as expected
- `grep -cE 'error:' build.log` == 0
- a headless boot check (game reaches its first scene, prints a marker) before claiming it works.

Never say "fixed/works" without a fresh contract + a screenshot for anything visual.

## The playtest feedback loop (approval-gated)

Triggered by a recorded playtest ending.

1. **Complete change list.** Ingest the recording, frame-match every spoken issue. Miss nothing —
   re-read the transcript for items you skipped.
2. **Present it for approval as a table**, columns exactly
   `| # | Time | Severity | Issue | Proposed fix |`, severity one of:
   - **BLOCK** — breaks play / progress
   - **FIX** — should change
   - **INFO** — the player asked a QUESTION ("what does this rune do?"). The "proposed fix" is an
     ANSWER, not a code change.
   - **KEEP** — praise or "leave this as is"; protects it from accidental change

   Consolidate fragments of one thought into one row. **Stop here** — nothing is implemented
   before the developer approves rows (individually or all).
3. **Implement every approved item, one small commit per fix.** The approved list is one unit of
   work — "ready for review" means the whole list, not progress on it.
4. **Verify by playing it yourself** (Pillar 3 / `web-playtest`): drive to the exact scene each
   item is about and confirm it on screen. A rename isn't verified until it's read off the screen;
   a text-cutoff fix isn't verified until the full message shows.
5. **Report once, at the end.** At the end of a batch, one full run-through catches regressions.

## Self-test gate — every change, not just playtest items

After ANY change to the game — one sprite, one line of dialogue, one script — run the game, drive
to where it shows, Read the screenshot, then play a little further to confirm nothing adjacent
broke. Only then hand it to a human. "I built it" ≠ "I tested it".

## Files

| Path | What |
|---|---|
| `scripts/record-playtest.sh` | macOS screen+mic recorder (ffmpeg/avfoundation): `devices`, `start`, `stop`, `status` |
| `scripts/ingest-recording.sh` | recording → `audio.wav`, transcript, frames, `meta.txt` |
| `resources/recording-review.md` | full recording → bug-list procedure |
| `examples/mgba-telemetry.lua` | mGBA telemetry logger |
| `examples/godot_telemetry.gd` | Godot 4 telemetry autoload (template) |

## Verification

```bash
ffmpeg -hide_banner -f lavfi -i testsrc=duration=12:size=320x240:rate=10 -f lavfi -i sine=duration=12 -shortest -y /tmp/pt-test.mp4
WORK=$(bash scripts/ingest-recording.sh /tmp/pt-test.mp4 /tmp/pt-test | awk '/^WORKDIR/{print $2}')
ls "$WORK/frames" | wc -l    # pass: 2 (one frame per 5 s), plus audio.wav and meta.txt in $WORK
```
