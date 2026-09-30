-- Terugboeking (chargeback) of terugbetaling van een betaling: de maand (of proefperiode) die ermee
-- betaald was, is teruggenomen. Eén keer per betaling, net als het bijschrijven.
ALTER TABLE payments ADD COLUMN reversed_at TEXT;
