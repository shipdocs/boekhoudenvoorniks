-- Factuurgegevens van de klant (voor de factuur bij elke betaling) en opzeggen.
ALTER TABLE licenses ADD COLUMN billing TEXT;
ALTER TABLE licenses ADD COLUMN cancelled_at TEXT;
-- Per betaling: het bedrag en de factuur die Mollie ervoor maakte (één factuur per betaling).
ALTER TABLE payments ADD COLUMN amount TEXT;
ALTER TABLE payments ADD COLUMN invoice_id TEXT;
