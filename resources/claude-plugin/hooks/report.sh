#!/bin/sh
# Repassa o JSON do hook ao Cockpit pelo socket Unix privado. Sem efeito fora do Cockpit.
[ -n "$COCKPIT_PANE_ID" ] && [ -n "$COCKPIT_TOKEN" ] && [ -S "$COCKPIT_SOCK" ] || { cat >/dev/null; exit 0; }
tmp=$(mktemp "${TMPDIR:-/tmp}/cockpit-hook.XXXXXX") || exit 0
head -c 250000 > "$tmp"
n=$(wc -c < "$tmp" | tr -d ' ')
{ printf '%s %s %s\n' "$COCKPIT_TOKEN" "$COCKPIT_PANE_ID" "$n"; cat "$tmp"; } | nc -U -w 2 "$COCKPIT_SOCK" >/dev/null 2>&1
rm -f "$tmp"
exit 0
