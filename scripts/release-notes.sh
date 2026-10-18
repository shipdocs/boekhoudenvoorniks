#!/usr/bin/env bash
# Print het CHANGELOG-deel van één versie (zonder de kop), voor de tekst bij de GitHub-release.
# Gebruik: scripts/release-notes.sh 0.3.0 > notes.md
set -euo pipefail
version="${1:?versie ontbreekt, bv. 0.3.0}"
notes=$(awk -v v="$version" '
  index($0, "## " v " ") == 1 || $0 == "## " v { found = 1; next }
  found && /^## / { exit }
  found { print }
' CHANGELOG.md)
if [ -z "$(printf '%s' "$notes" | tr -d '[:space:]')" ]; then
  echo "Geen CHANGELOG-deel gevonden voor versie $version" >&2
  exit 1
fi
printf '%s\n' "$notes" | sed -e '/./,$!d'
