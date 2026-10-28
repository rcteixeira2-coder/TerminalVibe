#!/bin/sh
[ -z "$COCKPIT_PANE_ID" ] && exit 0
{ printf '== %s pane=%s\n' "$1" "$COCKPIT_PANE_ID"; head -c 2000; printf '\n'; } >> "$COCKPIT_SPIKE_LOG"
exit 0
