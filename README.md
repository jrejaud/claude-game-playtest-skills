# Game playtest skills for Claude Code

Two [Claude Code](https://claude.com/claude-code) skills for making games with an AI agent in the loop.

| Skill | What it does |
|---|---|
| **game-playtest** | Record yourself playing and talking ("this door didn't open"); the agent turns the recording into a timestamped, screenshotted bug table, waits for your approval, fixes each item in its own commit, then verifies every fix by driving the game itself. Also: input/state telemetry aligned to the recording (mGBA and Godot examples), a headless agentic-playtest pattern, and build contracts. Engine-agnostic. |
| **web-playtest** | A CLI that drives a browser game/page with real input: mouse (incl. threshold drags, held buttons), keyboard (held keys and chords), and multi-touch (tap, long-press, swipe, pinch, two-finger pan) under phone/tablet emulation. Screenshots with visible cursor/finger dots, DOM input-event recording, `eval` for asserting game state, `.play` scripts for regression tests. |

## Install

```bash
claude plugin marketplace add <this repo's GitHub URL>
claude plugin install game-playtest-skills@game-playtest
```

Then just talk to Claude: "playtest the web build at localhost:8060 on an iPad", "here's my playtest recording, make the bug list".

## Requirements

| For | Needs |
|---|---|
| recording review | `ffmpeg`; `whisper` for transcripts (`pip install openai-whisper`, or point `WHISPER_CMD` at another CLI) |
| recording on macOS | `scripts/record-playtest.sh` (ffmpeg + Screen Recording permission). Windows/Linux: OBS or any recorder with a mic track |
| web-playtest | Node 18+ and npm. First run installs `playwright-core` + a headless Chromium (~150 MB) into the skill folder. `jq` for the self-test |
| telemetry examples | mGBA 0.10+ (Lua scripting) or Godot 4 |

## Verify

```bash
bash ~/.claude/plugins/marketplaces/game-playtest/plugins/game-playtest-skills/skills/web-playtest/tests/selftest.sh
```

14 `PASS` lines = every input family reaches the page.

## License

MIT
