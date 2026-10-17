*** Mergetool-generated resolution
*** Update File: src/btw/checks.ts
@@
-        `SELECT s.id, s.name, COALESCE(s.in_use_on, s.acquired_on) AS date, s.cost, l.debit AS lineDebit,
+        `SELECT s.id, s.name, COALESCE(s.in_use_on, s.acquired_on) AS date, s.cost, l.debit AS lineDebit,
@@
-          WHERE s.status = 'actief' AND CAST(substr(COALESCE(s.in_use_on, s.acquired_on), 1, 4) AS INTEGER) BETWEEN ? AND ? ORDER BY COALESCE(s.in_use_on, s.acquired_on)`,
+         WHERE s.status = 'actief' AND CAST(substr(COALESCE(s.in_use_on, s.acquired_on), 1, 4) AS INTEGER) BETWEEN ? AND ? ORDER BY COALESCE(s.in_use_on, s.acquired_on)`,
@@
-          'Dit is een schatting op basis van de btw in je boekhouding en het jaar van ingebruikname. Heb je geen aparte datum van ingebruikname ingevuld, dan gebruikt de app de aanschafdatum. Je [...]
+          'Dit is een schatting op basis van de btw in je boekhouding en het jaar van ingebruikname. Heb je geen aparte datum van ingebruikname ingevuld, dan gebruikt de app de aanschafdatum. Je vraagt de herziening zelf schriftelijk aan: een aangifte omzetbelasting aanvragen bij je belastingkantoor. Laat je boekhouder het bedrag bevestigen.',
@@
-        fingerprint: `${year}:${items.map((r) => `${r.id}:${r.date}:${r.deducted}`).join(',')}`,
+        fingerprint: `${year}:${items.map((r) => `${r.id}:${r.date}:${r.deducted}`).join(',')}`,
*** End Mergetool-generated resolution
