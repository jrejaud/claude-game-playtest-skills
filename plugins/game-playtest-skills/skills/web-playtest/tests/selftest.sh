#!/usr/bin/env bash
# web-playtest self-test: drives fixture.html with every input family and asserts the page
# received it. Exit 0 = all pass. Usage: bash tests/selftest.sh
set -uo pipefail
cd "$(dirname "$0")"
web-playtest() { "../scripts/web-playtest" "$@"; }
F="file://$PWD/fixture.html"
fail=0
check() { # name, jq-expr, state-json
  if echo "$3" | jq -e "$2" >/dev/null; then echo "PASS $1"; else echo "FAIL $1  ($2)"; fail=1; fi
}
state() { web-playtest eval 'JSON.stringify({...state, zoom: visualViewport.scale})' --session "$1" | jq -r .value; }

web-playtest start "$F" --session st-desk --replace >/dev/null || exit 2
web-playtest run desktop.play --session st-desk >/dev/null
D=$(state st-desk); web-playtest stop --session st-desk >/dev/null
check click        '.clicks >= 3'            "$D"
check shift-click  '.shiftClick'             "$D"
check right-click  '.rclicks == 1'           "$D"
check dblclick     '.dbl == 1'               "$D"
check keys         '.keys | index("F") != null and index("Shift+Q") != null' "$D"
check wheel        '.wheel == 1'             "$D"
check ctrl-wheel   '.ctrlWheel == 1'         "$D"
check mouse-drag   '.dropped'                "$D"

web-playtest start "$F" --session st-touch --device iphone --replace >/dev/null || exit 2
web-playtest run touch.play --session st-touch >/dev/null
T=$(state st-touch); web-playtest stop --session st-touch >/dev/null
check tap          '.taps >= 1'              "$T"
check longpress    '.longpress'              "$T"
check two-finger   '.maxTouches == 2'        "$T"
check pinch-scale  '.pinchScale > 1.9 and .pinchScale < 2.1' "$T"
check no-page-zoom '.zoom == 1'              "$T"
check touch-drag   '.dropped'                "$T"
exit $fail
