-- mGBA telemetry logger (Tools -> Scripting -> Load script)
-- Logs per-frame input keys + RAM watches as JSONL for playtest-recording alignment.
-- STATUS: VERIFIED 2026-08-05 on mGBA 0.10.5 (macOS) — the frame callback fires,
-- change-detection works, and RAM reads return live values (proved with gRngValue
-- ticking every frame + gSaveBlock1Ptr = 0x0200DFBC). API: https://mgba.io/docs/scripting.html
--   Load path (0.10.x has NO CLI flag): Tools -> Scripting… opens the console window,
--   then File -> Load script… (that File menu belongs to the Scripting window). The
--   file is written the instant the script loads — check the console for "telemetry -> …".
--   NOTE: mGBA reads the physical keyboard, so SYNTHETIC keypresses (osascript/System
--   Events) do NOT register as GBA input — only a real human at the keyboard logs keys.
--   That's fine: the playtester is a human. Don't try to self-test key capture via UI automation.
--
-- Output: ~/mgba-telemetry-<epoch>.jsonl
--   first line: {"wallclock_start": <epoch seconds>}  -- aligns to the screen recording
--   then, only on change (keys or any watch value): {"f": frame, "keys": bits, "w": {name: value, ...}}

-- EDIT ME: RAM watches (name -> {addr, size}). Addresses come from the build's
-- pokeemerald_modern.map. gRngValue advances every frame → a good liveness watch
-- that proves capture even with no input. sb1_ptr is the save-block base (deref
-- offline for coords/flags/party). Look up others: grep the .map for the symbol.
local WATCHES = {
  sb1_ptr = { addr = 0x030071f8, size = 4 },  -- gSaveBlock1Ptr (deref manually offline)
  -- rng  = { addr = 0x03007264, size = 4 },  -- gRngValue: LIVENESS-PROBE ONLY. It ticks
  --   every frame, so enabling it makes the log fire every frame (defeats change-only
  --   logging → ~150KB in seconds). Use it to confirm capture, then leave it off for real
  --   runs so the log stays keypress-driven. Addresses: grep pokeemerald_modern.map.
}

local path = os.getenv("HOME") .. "/mgba-telemetry-" .. os.time() .. ".jsonl"
local f = io.open(path, "w")
f:write(string.format('{"wallclock_start": %d}\n', os.time()))
f:flush()

local lastKeys, lastVals = -1, {}

local function readWatch(w)
  if w.size == 4 then return emu:read32(w.addr)
  elseif w.size == 2 then return emu:read16(w.addr)
  else return emu:read8(w.addr) end
end

local function onFrame()
  local keys = emu:getKeys()
  local changed = (keys ~= lastKeys)
  local vals = {}
  for name, w in pairs(WATCHES) do
    local v = readWatch(w)
    vals[name] = v
    if v ~= lastVals[name] then changed = true end
  end
  if changed then
    local parts = {}
    for name, v in pairs(vals) do parts[#parts + 1] = string.format('"%s": %d', name, v) end
    f:write(string.format('{"f": %d, "keys": %d, "w": {%s}}\n',
      emu:currentFrame(), keys, table.concat(parts, ", ")))
    f:flush()
    lastKeys, lastVals = keys, vals
  end
end

callbacks:add("frame", onFrame)
console:log("telemetry -> " .. path)
