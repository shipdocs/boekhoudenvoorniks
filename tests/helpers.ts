import Database from 'better-sqlite3';
import { migrate } from '../src/db/database';
import { createServices, MemorySecretStore } from '../src/services';
import type { Mailer, MailMessage } from '../src/documents/sending';
import type { FetchLike } from '../src/integrations/types';
import type { OcrProvider } from '../src/intake/ocr';

export function setup(opts: { fetch?: FetchLike; ocr?: OcrProvider; mailer?: Mailer; licensePublicKey?: string } = {}) {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrate(db);
  const sent: MailMessage[] = [];
  const mailer: Mailer = {
    async send(m) {
      sent.push(m);
      return { messageId: `<test-${sent.length}@local>` };
    },
  };
  const secrets = new MemorySecretStore();
  const s = createServices(db, {
    pdf: async (html) => Buffer.from(`PDF:${html.length}`),
    mailerFactory: async () => opts.mailer ?? mailer,
    secrets,
    fetch: opts.fetch ?? (async () => { throw new Error('geen netwerk in tests'); }),
    storeFile: async (name) => `/tmp/test-bijlagen/${name}`,
    ocr: opts.ocr ?? null,
    // licenties standaard uit in tests (de app heeft sinds 0.7.0 een echte sleutel); aan met een eigen testsleutel
    licensePublicKey: opts.licensePublicKey ?? '',
  });
  s.settings.update({
    company: {
      name: 'Stukadoorsbedrijf Piet',
      address: 'Kalkweg 1',
      postcode: '1234 AB',
      city: 'Utrecht',
      country: 'NL',
      email: 'piet@example.nl',
      phone: '',
      website: '',
      kvkNumber: '12345678',
      vatNumber: 'NL123456789B01',
      iban: 'NL91ABNA0417164300',
      bic: '',
    },
  });
  const klant = s.relations.create({ name: 'Familie Jansen', email: 'jansen@example.nl', address: 'Dorpsstraat 5', postcode: '3511 AA', city: 'Utrecht', iban: 'NL44RABO0123456789' });
  const aannemer = s.relations.create({ name: 'Bouwbedrijf De Vries BV', email: 'info@devries.example', address: 'Industrieweg 9', postcode: '3500 BB', city: 'Utrecht', vat_number: 'NL999999999B01' });
  return { db, s, sent, klant, aannemer, secrets };
}
