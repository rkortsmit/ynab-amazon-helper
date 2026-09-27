#!/usr/bin/env bash
# Mac / Linux launcher for the YNAB Amazon Helper GUI.
cd "$(dirname "$0")" || exit 1

if [ ! -f package.json ] || [ ! -f gui/server.ts ]; then
  echo "This launcher needs to stay inside the YNAB Amazon Helper folder, next to package.json."
  echo "It is running from: $(pwd)"
  echo "Open the helper folder and start it there (use an alias if you want it elsewhere)."
  exit 1
fi

if ! command -v bun >/dev/null 2>&1; then
  if [ -x "$HOME/.bun/bin/bun" ]; then
    export PATH="$HOME/.bun/bin:$PATH"
  else
    echo "Bun is not installed yet. It is the free program that runs this helper (https://bun.sh)."
    read -r -p "Install Bun now? [y/N] " answer
    case "$answer" in
      [yY]*) curl -fsSL https://bun.sh/install | bash; export PATH="$HOME/.bun/bin:$PATH" ;;
      *) echo "Bun is needed to run the helper."; exit 1 ;;
    esac
  fi
fi

if [ ! -f node_modules/playwright/lib/program.js ] || [ ! -f node_modules/playwright-core/cli.js ]; then
  echo "Installing the helper's components. This happens only once..."
  bun install --force || { echo "Installing the components failed."; exit 1; }
fi

exec bun gui/server.ts
