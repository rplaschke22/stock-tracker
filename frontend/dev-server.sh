#!/bin/bash
# Convenience wrapper so `npm run dev` works from a plain shell without
# needing to `source ~/.nvm/nvm.sh` first (only needed in dev
# environments where node isn't already on PATH).
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  export NVM_DIR="$HOME/.nvm"
  [ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
fi
exec npm run dev -- --port 5173 --strictPort
