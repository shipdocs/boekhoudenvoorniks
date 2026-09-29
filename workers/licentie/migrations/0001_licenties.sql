-- Licenties voor de uitwisseling met de boekhouder (D1: sterk consistent, transacties).
-- Betaald t/m = period_start + months maanden (in de Worker berekend, met afkappen op het eind van
-- de maand). Zo is een betaalde maand erbij één atomische `months = months + 1`.
CREATE TABLE licenses (
  administratie TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  -- het lopende Mollie-abonnement; uniek, zodat een incasso bij precies één administratie hoort
  subscription_id TEXT UNIQUE,
  -- eerste dag van de doorlopende betaalde periode
  period_start TEXT NOT NULL,
  months INTEGER NOT NULL DEFAULT 0,
  -- betaling die het abonnement aan het aanmaken is: maar één webhook doet dat
  subscription_claim TEXT
);

-- Elke Mollie-betaling telt één keer (idempotente webhook).
CREATE TABLE payments (
  payment_id TEXT PRIMARY KEY,
  administratie TEXT NOT NULL,
  processed_at TEXT NOT NULL
);
