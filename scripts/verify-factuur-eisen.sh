#!/usr/bin/env bash
# Dekkingsbewijs voor de wettelijke factuurcontrole (S3).
# Fase 1 (statisch): geldige import uit packages/core + typecheck.
# Fase 2 (test): aantal it()-gevallen tegen de berekende ondergrens, daarna LEGAL_TESTS_OK.
set -u
cd "$(dirname "$0")/.."
KERN=packages/core/src/documents/invoices.ts
TEST=tests/factuur-eisen-kern.test.ts

# --- Fase 1: statisch ---
if ! grep -q "export declare function checkInvoiceRequirements" packages/core/dist/documents/invoices.d.ts; then
  echo "FAAAL (statisch): checkInvoiceRequirements is niet uit packages/core geëxporteerd"; exit 1
fi
if ! node -e "const k = require('@gratis-boekhouden/kern'); if (typeof k.checkInvoiceRequirements !== 'function') process.exit(1)"; then
  echo "FAAAL (statisch): checkInvoiceRequirements is niet aanroepbaar via @gratis-boekhouden/kern"; exit 1
fi
if ! grep -q "from '@gratis-boekhouden/kern'" "$TEST"; then
  echo "FAAAL (statisch): het testbestand importeert niet uit packages/core"; exit 1
fi
if ! npm run --silent typecheck >/tmp/opencode/typecheck.log 2>&1; then
  echo "FAAAL (statisch): typecheck"; cat /tmp/opencode/typecheck.log; exit 1
fi
echo "STATISCH OK: import uit packages/core geldig, typecheck slaagt"

# --- Fase 2: ondergrens berekenen en toetsen ---
C=$(grep -c "throw new ValidationError" "$KERN")                       # aantal controles (throws)
K=$(grep -E '^  if \(' "$KERN" | grep -cE 'kor|lines\.some')           # controles met een voorwaarde
ONDERGRENS=$((2 * C + K))

FAALT=$(grep -c "it('faalt" "$TEST")
VOLDAAN=$(grep -c "it('voldaan" "$TEST")
OVERGESLAGEN=$(grep -c "it('overgeslagen" "$TEST")
TOTAAL=$(grep -oE "^\s*it\(" "$TEST" | wc -l)

echo "controles (throws): $C, waarvoorwaardelijk: $K -> ondergrens it()-gevallen: $ONDERGRENS"
echo "it()-gevallen: totaal=$TOTAAL (faalt=$FAALT, voldaan=$VOLDAAN, overgeslagen=$OVERGESLAGEN)"

if [ "$FAALT" -lt "$C" ]; then echo "FAAAL (test): minder faalt-gevallen ($FAALT) dan controles ($C)"; exit 1; fi
if [ "$VOLDAAN" -lt "$C" ]; then echo "FAAAL (test): minder voldaan-gevallen ($VOLDAAN) dan controles ($C)"; exit 1; fi
if [ "$OVERGESLAGEN" -lt "$K" ]; then echo "FAAAL (test): minder overgeslagen-gevallen ($OVERGESLAGEN) dan voorwaardelijke controles ($K)"; exit 1; fi
if [ "$TOTAAL" -lt "$ONDERGRENS" ]; then echo "FAAAL (test): $TOTAAL it()-gevallen blijft niet op de ondergrens $ONDERGRENS"; exit 1; fi

echo "LEGAL_TESTS_OK"
