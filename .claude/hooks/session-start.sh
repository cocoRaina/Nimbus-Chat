#!/bin/bash
set -euo pipefail

# Set git identity so commits show as Verified on GitHub
git config user.email noreply@anthropic.com
git config user.name Claude

# Install JS dependencies (cached after first run)
if [ "${CLAUDE_CODE_REMOTE:-}" = "true" ]; then
  npm install --prefer-offline --no-audit --no-fund 2>/dev/null || npm install --no-audit --no-fund
fi
