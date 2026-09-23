#!/usr/bin/env bash
# Serve this folder locally so changes can be checked before they go live.
#   ./preview.sh          -> http://localhost:8000
#   ./preview.sh 8080     -> http://localhost:8080
#
# The port must match an entry in the OAuth client's Authorized JavaScript
# origins, or Google sign-in will refuse to load.
set -e
PORT="${1:-8000}"
cd "$(dirname "$0")"
echo "The 99 — local preview on http://localhost:${PORT}"
echo "Stop with Ctrl+C."
command -v open >/dev/null && (sleep 1 && open "http://localhost:${PORT}") &
exec python3 -m http.server "$PORT"
