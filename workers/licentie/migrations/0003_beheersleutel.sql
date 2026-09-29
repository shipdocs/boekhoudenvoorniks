-- Alleen de app die het abonnement afsloot kan de licentie ophalen of het abonnement opzeggen.
-- De Worker bewaart uitsluitend de SHA-256-hash; de lokale administratie bewaart de geheime sleutel.
ALTER TABLE licenses ADD COLUMN management_key_hash TEXT;
