#!/bin/sh
# ClawPump's MCP server (@clawpump/agents) for Claude Code sessions in this project only (Zach, 22 Sep).
# Pinned to the version that was read before use, and started with an empty environment plus CLAWPUMP_API_KEY:
# none of .env's other secrets (his wallet, X keys, gateway token) reach it. The key is read from
# ~/.mrbands/clawpump.env (the rotated key, docs/launch.md step 3) or, failing that, from .env, and is never
# written anywhere else (the package's own `--claude` setup copies it to ~/Desktop/.env; not used).
# The write tools this server carries (both launch tools, wallet_transfer, add_to_whitelist, ...) are denied
# to Claude Code in .claude/settings.local.json (launch.md step 5): sessions read ClawPump, never act on it.
# Registered with: claude mcp add clawpump-agents --scope local -- <this file>
here=$(cd "$(dirname "$0")/.." && pwd)
key=$(grep -m1 '^CLAWPUMP_API_KEY=' "$HOME/.mrbands/clawpump.env" 2>/dev/null | cut -d= -f2- | sed 's/^"\(.*\)"$/\1/')
[ -z "$key" ] && key=$(grep -m1 '^CLAWPUMP_API_KEY=' "$here/.env" 2>/dev/null | cut -d= -f2- | sed 's/^"\(.*\)"$/\1/')
if [ -z "$key" ]; then
  echo "clawpump-mcp: CLAWPUMP_API_KEY is set in neither ~/.mrbands/clawpump.env nor $here/.env" >&2
  exit 1
fi
exec env -i PATH="$PATH" HOME="$HOME" CLAWPUMP_API_KEY="$key" npx -y @clawpump/agents@0.1.27
