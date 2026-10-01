#!/usr/bin/env bash
# Maakt de afbeeldingen voor het Store-pakket (build/appx/) uit build/icon.png, in de maten en met de
# namen die het appx-doel van electron-builder verwacht. Nodig: ImageMagick (`convert`).
# Alleen opnieuw draaien als het pictogram verandert; de uitkomst staat in git.
set -euo pipefail
cd "$(dirname "$0")/.."
src=build/icon.png
out=build/appx
mkdir -p "$out"

square() { convert "$src" -resize "$2x$2" -strip "$out/$1"; }
square StoreLogo.png 50
square Square44x44Logo.png 44
square SmallTile.png 71
square Square150x150Logo.png 150
square LargeTile.png 310
# brede tegel: het pictogram in het midden op een doorzichtig vlak
convert "$src" -resize 150x150 -background none -gravity center -extent 310x150 -strip "$out/Wide310x150Logo.png"
ls -l "$out"
