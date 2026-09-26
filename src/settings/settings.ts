import type { Db } from '../db/database';
import type { PeriodType } from '../shared/dates';

export interface CompanySettings {
  name: string;
  address: string;
  postcode: string;
  city: string;
  country: string;
  email: string;
  phone: string;
  website: string;
  kvkNumber: string;
  vatNumber: string;
  iban: string;
  bic: string;
}

export interface SmtpSettings {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  fromName: string;
  fromEmail: string;
  bcc: string;
}

export interface BusinessProfile {
  trade: string;
  worksAlone: boolean;
  hasBusinessAccount: boolean;
  /** Voornaam voor de begroeting */
  firstName: string;
}

export interface OcrSettings {
  /** lokale OCR-sidecar, bv. http://127.0.0.1:8765 — leeg = uit */
  url: string;
  engine: string;
  /** optionele lokale LLM (Ollama-compatibel) voor classificatievoorstellen — leeg = uit */
  llmUrl: string;
  llmModel: string;
}

export interface AppSettings {
  company: CompanySettings;
  profile: BusinessProfile;
  ocr: OcrSettings;
  smtp: SmtpSettings;
  paymentTermDays: number;
  quoteValidityDays: number;
  invoiceNumberFormat: string;
  quoteNumberFormat: string;
  vatPeriod: PeriodType;
  /** Kleineondernemersregeling: geen BTW rekenen/aangeven. */
  kor: boolean;
  defaultVatCode: 'hoog' | 'laag' | 'nul' | 'verlegd' | 'vrijgesteld';
  remindersEnabled: boolean;
  /** Dagen na vervaldatum waarop herinneringen gestuurd worden, bv. [7, 21]. */
  reminderDays: number[];
  advancedMode: boolean;
  /** Locatie van foto's gebruiken om bonnen aan klussen te koppelen (#32). Standaard uit; alleen lokaal. */
  jobLocation: boolean;
  /** E-factuur (UBL) als bijlage meesturen met elke factuur (#24). */
  sendUbl: boolean;
  /** Bankrekening (bank_accounts.id) die dient als belastingpotje (#33), of null. */
  vatPotAccountId: number | null;
  /** Schatting inkomstenbelasting tonen (#33); altijd als schatting gemarkeerd. */
  incomeTaxEstimate: boolean;
  /** Voldoe ik aan het urencriterium (1.225 uur)? Bepaalt of de zelfstandigenaftrek meetelt in de schatting. */
  urencriterium: boolean;
  /**
   * Waarmee rijd je zakelijk? 'prive' = privéauto: tanken en parkeren tellen als privé, zakelijke
   * kilometers geven € per km aftrek. 'zakelijk' = bus/auto van de zaak (kosten aftrekbaar).
   */
  carUse: 'onbekend' | 'prive' | 'zakelijk' | 'geen';
  /** jaar waarin je onderneming begon (voor de startersaftrek), of null */
  startYear: number | null;
  /** hoe vaak je de startersaftrek al gebruikte vóór `asOfYear` (zo opgegeven door de gebruiker) */
  startersaftrekUsed: { count: number; asOfYear: number };
  /** Hoe automatisch: voorzichtig (niets zelf), normaal, maximaal (iets lagere drempels). */
  autopilot: 'voorzichtig' | 'normaal' | 'maximaal';
  onboardingDone: boolean;
  /** Per onboardingstap de versie die de gebruiker gezien heeft (zie shared/onboarding.ts). */
  onboardingSteps: Record<string, number>;
  /** "Aan de slag"-lijstje op Vandaag verborgen */
  checklistHidden: boolean;
  /** Deze administratie is de demo: voorbeelddata, er gaat geen e-mail naar buiten. */
  demoMode: boolean;
  /** versie van de voorwaarden waarmee akkoord is gegeven (leeg = nog niet) */
  termsAcceptedVersion: string;
  invoiceEmailSubject: string;
  invoiceEmailBody: string;
  quoteEmailSubject: string;
  quoteEmailBody: string;
  reminderEmailSubject: string;
  reminderEmailBody: string;
}

export const DEFAULT_SETTINGS: AppSettings = {
  company: {
    name: '',
    address: '',
    postcode: '',
    city: '',
    country: 'NL',
    email: '',
    phone: '',
    website: '',
    kvkNumber: '',
    vatNumber: '',
    iban: '',
    bic: '',
  },
  profile: { trade: '', worksAlone: true, hasBusinessAccount: true, firstName: '' },
  ocr: { url: '', engine: 'glm-ocr', llmUrl: '', llmModel: '' },
  smtp: { host: '', port: 587, secure: false, user: '', fromName: '', fromEmail: '', bcc: '' },
  paymentTermDays: 14,
  quoteValidityDays: 30,
  invoiceNumberFormat: '{JJJJ}-{NNNN}',
  quoteNumberFormat: 'OFF-{JJJJ}-{NNNN}',
  vatPeriod: 'kwartaal',
  kor: false,
  defaultVatCode: 'hoog',
  remindersEnabled: false,
  reminderDays: [7, 21],
  advancedMode: false,
  autopilot: 'normaal',
  carUse: 'onbekend',
  startYear: null,
  startersaftrekUsed: { count: 0, asOfYear: 0 },
  vatPotAccountId: null,
  incomeTaxEstimate: true,
  urencriterium: true,
  sendUbl: true,
  jobLocation: false,
  onboardingDone: false,
  onboardingSteps: {},
  checklistHidden: false,
  demoMode: false,
  termsAcceptedVersion: '',
  invoiceEmailSubject: 'Factuur {nummer} van {bedrijf}',
  invoiceEmailBody:
    'Beste {klant},\n\nIn de bijlage vindt u factuur {nummer} voor een bedrag van {bedrag}.\nWij verzoeken u vriendelijk dit bedrag vóór {vervaldatum} over te maken op {iban} o.v.v. het factuurnummer.\n\nMet vriendelijke groet,\n{bedrijf}',
  quoteEmailSubject: 'Offerte {nummer} van {bedrijf}',
  quoteEmailBody:
    'Beste {klant},\n\nIn de bijlage vindt u offerte {nummer} voor een bedrag van {bedrag}. De offerte is geldig tot {geldig_tot}.\n\nMet vriendelijke groet,\n{bedrijf}',
  reminderEmailSubject: 'Herinnering: factuur {nummer} van {bedrijf}',
  reminderEmailBody:
    'Beste {klant},\n\nVolgens onze administratie staat factuur {nummer} van {bedrag} nog open; de vervaldatum was {vervaldatum}.\nWilt u het openstaande bedrag van {openstaand} zo snel mogelijk overmaken op {iban} o.v.v. het factuurnummer? Heeft u al betaald, dan kunt u deze herinnering als niet verzonden beschouwen.\n\nMet vriendelijke groet,\n{bedrijf}',
};

export class SettingsService {
  constructor(private readonly db: Db) {}

  get(): AppSettings {
    const rows = this.db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[];
    const stored: Record<string, unknown> = {};
    for (const r of rows) stored[r.key] = JSON.parse(r.value);
    return {
      ...DEFAULT_SETTINGS,
      ...stored,
      company: { ...DEFAULT_SETTINGS.company, ...((stored.company as object) ?? {}) },
      smtp: { ...DEFAULT_SETTINGS.smtp, ...((stored.smtp as object) ?? {}) },
      profile: { ...DEFAULT_SETTINGS.profile, ...((stored.profile as object) ?? {}) },
      ocr: { ...DEFAULT_SETTINGS.ocr, ...((stored.ocr as object) ?? {}) },
    } as AppSettings;
  }

  update(patch: Partial<AppSettings>): AppSettings {
    const upsert = this.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
    const current = this.get();
    this.db.transaction(() => {
      for (const [key, value] of Object.entries(patch)) {
        if (!(key in DEFAULT_SETTINGS) || value === undefined) continue;
        const merged = ['company', 'smtp', 'profile', 'ocr'].includes(key) ? { ...(current[key as keyof AppSettings] as object), ...(value as object) } : value;
        upsert.run(key, JSON.stringify(merged));
      }
    })();
    return this.get();
  }

  /** Interne tellers (factuurnummers e.d.) — niet via update() bereikbaar. */
  nextCounter(name: string): number {
    const key = `counter:${name}`;
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
    const next = (row ? Number(JSON.parse(row.value)) : 0) + 1;
    this.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, JSON.stringify(next));
    return next;
  }

  peekCounter(name: string): number {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(`counter:${name}`) as { value: string } | undefined;
    return row ? Number(JSON.parse(row.value)) : 0;
  }

  setCounter(name: string, value: number): void {
    if (!Number.isInteger(value) || value < 0) throw new Error('Teller moet een positief geheel getal zijn');
    this.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(`counter:${name}`, JSON.stringify(value));
  }
}
