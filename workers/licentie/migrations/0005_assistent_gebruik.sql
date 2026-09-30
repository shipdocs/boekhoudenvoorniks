-- Online hulp bij categorievoorstellen (workers/assistent, #132): aantal aanroepen per administratie per
-- dag, voor het dagquotum. Alleen een teller: geen inhoud van wat er gevraagd werd.
CREATE TABLE assistant_usage (
  administratie TEXT NOT NULL,
  day TEXT NOT NULL,
  calls INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (administratie, day)
);
