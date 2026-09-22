#!/bin/sh
# ClawPump's MCP server (@clawpump/agents) for Claude Code sessions in this project only (Zach, 22 Sep).
# Pinned to the version that was read before use, and started with an empty environment plus CLAWPUMP_API_KEY:
# none of .env's other secrets (his wallet, X keys, gateway token) reach it. The key is read from .env here
# and is never written anywhere else (the package's own `--claude` setup copies it to ~/Desktop/.env; not used).
# Registered with: claude mcp add clawpump-agents --scope local -- <this file>
here=$(cd "$(dirname "$0")/.." && pwd)
key=$(grep -m1 '^CLAWPUMP_API_KEY=' "$here/.env" 2>/dev/null | cut -d= -f2- | sed 's/^"\(.*\)"$/\1/')
if [ -z "$key" ]; then
  echo "clawpump-mcp: CLAWPUMP_API_KEY is not set in $here/.env" >&2
  exit 1
fi
exec env -i PATH="$PATH" HOME="$HOME" CLAWPUMP_API_KEY="$key" npx -y @clawpump/agents@0.1.27
