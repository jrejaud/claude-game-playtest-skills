# Godot 4 playtest telemetry — TEMPLATE, untested: adapt and verify on first use.
# Add as an Autoload (Project Settings -> Autoload) in debug builds. Writes JSONL to user://:
#   first line: {"wallclock_start": <unix seconds>}   -> aligns the log to the screen recording
#   then, only when something changes: {"f": frame, "t": seconds, "actions": [...pressed], "w": {watch: value}}
# Edit watch() to return whatever state you want next to each input change (player pos, hp, scene).
extends Node

var _file: FileAccess
var _last := ""

func _ready() -> void:
	if not OS.is_debug_build():
		set_process(false)
		return
	var start := Time.get_unix_time_from_system()
	var path := "user://telemetry-%d.jsonl" % int(start)
	_file = FileAccess.open(path, FileAccess.WRITE)
	_file.store_line(JSON.stringify({"wallclock_start": start}))
	print("telemetry -> ", ProjectSettings.globalize_path(path))

func watch() -> Dictionary:
	var scene := get_tree().current_scene
	return {"scene": String(scene.name) if scene else ""}

func _process(_delta: float) -> void:
	var pressed: Array[String] = []
	for action in InputMap.get_actions():
		if not String(action).begins_with("ui_") and Input.is_action_pressed(action):
			pressed.append(String(action))
	var w := watch()
	var key := JSON.stringify([pressed, w])
	if key == _last:
		return
	_last = key
	_file.store_line(JSON.stringify({
		"f": Engine.get_process_frames(),
		"t": Time.get_unix_time_from_system(),
		"actions": pressed,
		"w": w,
	}))
	_file.flush()
