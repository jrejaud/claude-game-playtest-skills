---
name: web-playtest
description: REQUIRED when an agent must PLAYTEST or physically manipulate any web page/app/game with real input — mouse (move, click, right/middle click, modifier-click, wheel, threshold-crossing drags), keyboard (keys, chords, held keys), and TOUCH incl. multi-touch (tap, double-tap, long-press, swipe, finger-drag, pinch, two-finger pan) under phone/tablet device emulation. Auto-activates on "playtest the web app", "playtest in the browser", "simulate a drag", "drag and drop test", "simulate touch", "test on mobile/tablet", "pinch zoom test", "long press", "two-finger", "simulate keyboard/mouse", "test the controls", "does the gesture work", "drag not registering in playwright", or whenever a plain click/drag can't express the gesture. Persistent session CLI (one Chromium page held by a background server, so held keys/buttons survive across calls), plus observation: screenshots with visible finger/cursor dots, recorded DOM input events, aria snapshot, eval, console, video.
---

# web-playtest

Drive a web page or browser game the way a player would, from the CLI, and prove what the page received.

**Why it exists:** most browser automation `drag` verbs teleport — pointer-sensor libraries
(dnd-kit, Sortable, most game canvases) need movement past an activation distance or they never
start a drag — and Playwright's own touchscreen only taps. Touch here goes through CDP
`Input.dispatchTouchEvent`, i.e. the real input pipeline: pages get `TouchEvent` **and**
`PointerEvent{pointerType:"touch"}`, and native pinch-zoom happens if the page doesn't prevent
it — so it catches real mobile bugs. Chromium only.

## Setup

The CLI is `scripts/web-playtest` inside this skill's directory. Call it by that path, or link it
onto PATH once:

```bash
ln -sf "<this skill's directory>/scripts/web-playtest" ~/.local/bin/web-playtest
```

First run installs `playwright-core` and a matching headless Chromium into `scripts/node_modules`
(needs Node 18+ and npm; one-time, ~150 MB). Examples below assume it is on PATH.

## Quick Start

```bash
web-playtest start http://localhost:5173 --device ipad      # desktop | iphone | ipad | pixel | any Playwright device
web-playtest cursor on                                      # draw pointer/finger dots into screenshots
web-playtest events on                                      # record DOM input events the page gets
web-playtest tdrag '[data-card-id="c1"]' '#zone-discard'    # finger drag, 300ms hold first
web-playtest pinch 600,400 --scale 0.5                      # pinch out
web-playtest screenshot                                      # prints path → Read it
web-playtest events dump                                    # what actually fired, on which element
web-playtest stop
```

Every verb prints one JSON line (`"ok":false` + exit 1 on failure). Full verb list: `web-playtest help`.

| Family | Verbs |
|---|---|
| Session | `start <url> [--device D] [--headed] [--video DIR] [--gpu]`, `stop`, `sessions`, `info`, `goto`, `reload`, `resize`, `wait`, `throttle <rate>` |
| Mouse | `move`, `down`/`up [--button]`, `click [--button] [--count] [--mods Shift+Alt]`, `dblclick`, `rclick`, `hover`, `wheel dx dy [--at t] [--mods Control]`, `drag a b [--steps] [--hold] [--mods] [--no-release]` |
| Keyboard | `press <key or chord>`, `keydown`, `keyup` (hold a key across other verbs — e.g. hold W while moving the mouse), `type` |
| Touch | `tap`, `dtap`, `longpress [--ms] [--no-release]`, `swipe`, `tdrag`, `pinch [c] --scale`, `pan2`, raw `touch start|move|end '<points json>'` (or `'@<js expr>'` returning the points array) |
| Observe | `screenshot [path] [--sel] [--full]`, `snapshot` (aria), `rect <sel>`, `eval`, `console`, `events on|dump|clear`, `cursor on|off` |
| Script | `run <file> [--keep-going]` — one verb per line, `#` comments |

**Targets** are `"x,y"` viewport pixels, any Playwright selector (→ element center), or
`"@<js expr>"` returning `{x,y}` — the only way to hit objects in a canvas/WebGL game (have the
game expose e.g. `window.__game.screenPos(id)` in debug builds). `--offset dx,dy` /
`--to-offset dx,dy` nudge. **Sessions**: `--session NAME` (or env `WEB_PLAYTEST_SESSION`) runs
several pages in parallel, e.g. desktop + phone side by side, or two multiplayer seats.

**Game state is the oracle.** For a canvas game, expose a tiny debug hook (`window.__game =
{ player: {...}, scene: 'level1', screenPos(id) }`) so `eval` can assert what happened instead of
guessing from pixels. Works for HTML5 exports from Godot/Unity/Phaser too.

## Environment options

- `WEB_PLAYTEST_ARGS="--flag --flag"` — extra Chromium flags for that session.
- `WEB_PLAYTEST_EXECUTABLE=<path>` — launch another Chromium-family binary (always a fresh
  temporary profile), e.g. an installed Google Chrome.
- `WEB_PLAYTEST_CHROMIUM=<path>` — fallback binary if the Playwright-managed Chromium is missing.
- `WEB_PLAYTEST_SHOTS=<dir>` — where screenshots go (default `~/.cache/web-playtest/shots`).

**WebRTC between two sessions (multiplayer / peer-to-peer playtests)** needs all three:
1. `start` run outside any sandbox that blocks sockets (UDP);
2. on macOS, a browser the application firewall lets accept connections — the Playwright build
   changes per update and has no allow rule, so incoming WebRTC is silently dropped: set
   `WEB_PLAYTEST_EXECUTABLE` to the installed Google Chrome;
3. real local IPs: two headless browsers on one machine don't resolve each other's mDNS
   `.local` candidates — `WEB_PLAYTEST_ARGS=--disable-features=WebRtcHideLocalIpsWithMdns`.

## Rules

- **Headless by default.** `--headed` pops a real Chromium window and steals focus — use it only
  when the developer asked to watch, or the bug only reproduces headed.
- **Frame times need `--gpu`** (put it last, or `--gpu=1`: a bare flag swallows the next word;
  the flags are macOS/Metal). Without it headless Chromium renders WebGL in SwiftShader
  (~600 ms/frame) — numbers about the CPU, not a device. "Mid-range phone" =
  `start <url> --device pixel --gpu=1`, then `throttle 4`.
- **Prove, don't assume.** A verb returning `ok` means the input was dispatched, not that the
  game reacted. Assert on game state (`eval`), `events dump`, or a screenshot you Read.
- **Scripts for regressions.** Put a gesture sequence in a `.play` file in the project's repo
  and `run` it; pair with an `eval` assertion (see `tests/selftest.sh` for the pattern).
- In zsh, don't stuff `--session x` into one variable (`$S`) — it isn't word-split and silently
  targets the `default` session.

## Verification

Oracle: a fixture page that counts every input family it receives (`tests/fixture.html`).

```bash
bash "<this skill's directory>/tests/selftest.sh"
```

Pass = 14 `PASS` lines and exit 0 (click, shift-click, right-click, dblclick, keys, wheel,
ctrl-wheel, mouse-drag, tap, longpress, two-finger, pinch-scale≈2, no-page-zoom, touch-drag).
Needs `jq`. For a project, the oracle is the game's own state after a `.play` script plus a
screenshot you Read.

## Files

- `scripts/web-playtest` — wrapper (first-run install); `scripts/web-playtest.mjs` — CLI + server
- `scripts/help.txt` — verb reference printed by `web-playtest help`
- `tests/` — fixture, `.play` scripts, `selftest.sh`
- State: `~/.cache/web-playtest/<session>.json|.log`
