-- Proefperiode: de eerste betaling is dan alleen een klein bedrag voor de machtiging (iDEAL kan niet
-- met € 0) en telt meerdere gratis maanden. Zo'n betaling krijgt geen factuur.
ALTER TABLE payments ADD COLUMN trial INTEGER NOT NULL DEFAULT 0;
