#!/bin/sh
mkdir -p /root/.auth2api
if [ -n "$CLAUDE_TOKEN" ]; then
  echo "$CLAUDE_TOKEN" > /root/.auth2api/claude-gamestudios2023@gmail.com.json
fi
exec node dist/index.js
