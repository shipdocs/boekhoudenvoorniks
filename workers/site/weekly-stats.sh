#!/usr/bin/env bash
# Elke maandag een regel met de websitecijfers in de ShipDocs-updates (crontab).
# Het token staat in ~/.config/boekhoudenvoorniks/stats.env (chmod 600):
#   CLOUDFLARE_ACCOUNT_ID=…
#   CLOUDFLARE_API_TOKEN=…   (recht: Account Analytics Read)
set -euo pipefail
ENV_FILE="$HOME/.config/boekhoudenvoorniks/stats.env"
[ -r "$ENV_FILE" ] || { echo "Geen $ENV_FILE; zie workers/site/weekly-stats.sh" >&2; exit 1; }
set -a; . "$ENV_FILE"; set +a
export PATH="$HOME/.local/bin:$PATH"
exec node "$(dirname "$0")/stats.mjs" --update
