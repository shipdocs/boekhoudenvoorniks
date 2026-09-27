import type { Db } from '../db/database';
import type { PeriodType } from '../shared/dates';
import { ValidationError, isValidEmail } from '../shared/validation';

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
  /** "Antwoorden gaan naar": waar klanten op reageren (leeg = het afzenderadres) */
  replyTo: string;
}

/**
 * Inkomende post (IMAP): een apart mailadres voor de administratie. De app haalt bijlagen op als
 * bonnetje; mail van klanten en andere mail blijft onaangeroerd (ook de gelezen-status).
 */
export interface MailInSettings {
  enabled: boolean;
  host: string;
  port: number;
  secure: boolean;
  user: string;
  /** de map die de app leest (meestal INBOX) */
  folder: string;
  /** ook deze mappen doorzoeken, bv. een archiefmap; daar wordt nooit iets verplaatst */
  extraFolders: string[];
  /** verwerkte mail met bijlage verplaatsen naar deze map (nooit verwijderen); leeg = laten staan */
  processedFolder: string;
  /** alleen mail vanaf deze datum (JJJJ-MM-DD); zo haalt de eerste keer geen jaren oude mail op */
  since: string;
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
  /** 'ingebouwd' (lokaal), 'claude-code', 'codex', of een eigen dienst (glm-ocr, …) */
  engine: string;
  /** de keuze "hoe wil je bonnen laten lezen?" is al gesteld (ook bij "zelf invullen") */
  askedReader: boolean;
  /**
   * Waar Claude Code en Codex staan: alleen gezocht of gekozen als de gebruiker daarom vraagt
   * ("Zoek op deze computer" of "Kies zelf"). Leeg = niet gevonden of nog niet gezocht.
   */
  claudeCodePath: string;
  codexPath: string;
  /** de gebruiker heeft (minstens één keer) laten zoeken */
  assistantsSearched: boolean;
  /** optionele lokale LLM (Ollama-compatibel) voor classificatievoorstellen — leeg = uit */
  llmUrl: string;
  llmModel: string;
}

/**
 * Overstappen met een lopende administratie. Vanaf `date` (de instapdatum) boekt de app alles zelf;
 * wat er daarvóór was, staat als startbalans in de app (zie onboarding/switchover.ts).
 */
export interface SwitchoverSettings {
  /** null = nog niet gevraagd; 'nieuw' = net begonnen (of al ingericht); 'overstapper' = had al een administratie */
  mode: 'nieuw' | 'overstapper' | null;
  date: string | null;
  /** 'klaar' als de gebruiker de startpositie heeft bevestigd */
  status: 'concept' | 'klaar';
  /** bedragen zijn nog voorlopig (bv. de jaarrekening van vorig jaar is nog niet klaar) */
  provisional: boolean;
  /** btw-periodes vóór de instapdatum die de app als "al aangegeven" heeft gemarkeerd */
  filedElsewhere: string[];
  /** banktransacties waarvan de gebruiker zei: geen betaling voor iets van vóór de instapdatum */
  dismissed: number[];
  /** bankrekeningen waarvan de gebruiker het beginsaldo op de instapdatum bevestigde (ook als dat € 0 is) */
  bankConfirmed: number[];
  /** per bankrekening: een saldo dat de gebruiker opgaf om te controleren (voor CSV zonder saldo) */
  bankChecks: Record<string, { date: string; amount: number }>;
  /** bankrekeningen waarvan het beginsaldo uit een auditfile/kolommenbalans kwam (opnieuw inlezen zet ze eerst terug) */
  xafBanks?: number[];
  /** eigen vermogen volgens de balans van de boekhouder (centen), om te vergelijken */
  accountantEquity: number | null;
}

export interface AppSettings {
  company: CompanySettings;
  profile: BusinessProfile;
  ocr: OcrSettings;
  smtp: SmtpSettings;
  mailIn: MailInSettings;
  /** nieuwe versies automatisch downloaden en installeren bij afsluiten (standaard aan) */
  autoUpdate: boolean;
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
  /** auto van de zaak: rijd je er ook privé mee? (null = nog niet gevraagd) — voor de btw-correctie */
  carPrivateUse: boolean | null;
  /** cataloguswaarde van de auto van de zaak, incl. btw en bpm (centen) */
  carCatalogValue: number | null;
  /** jaar waarin de auto in gebruik is genomen voor je bedrijf */
  carInUseSince: number | null;
  /** maand (1–12) van ingebruikname; alleen nodig voor het eerste jaar (naar rato) */
  carInUseMonth: number | null;
  /** jaar waarin je onderneming begon (voor de startersaftrek), of null */
  startYear: number | null;
  /** hoe vaak je de startersaftrek al gebruikte vóór `asOfYear` (zo opgegeven door de gebruiker) */
  startersaftrekUsed: { count: number; asOfYear: number };
  /**
   * Zakelijk deel van telefoon & internet in procenten (null = nog niet opgegeven, dan 100%).
   * Het privédeel telt bij de winst en de btw daarover mag je niet aftrekken.
   */
  phoneInternetBusinessPct: number | null;
  /** Werkplek thuis: 'geen', een plek in huis ('thuis'), of een zelfstandige werkruimte (eigen ingang en sanitair). */
  homeWorkspace: 'geen' | 'thuis' | 'zelfstandig' | null;
  /** Uren die je partner onbetaald meewerkt in het bedrijf (meewerkaftrek), per jaar. */
  partnerHours: number;
  /** jaar waarin de gebruiker bevestigde dat de IB-berekeningen door een boekhouder gecontroleerd moeten worden */
  taxCheckAcknowledgedYear: number;
  /** Hoe automatisch: voorzichtig (niets zelf), normaal, maximaal (iets lagere drempels). */
  autopilot: 'voorzichtig' | 'normaal' | 'maximaal';
  switchover: SwitchoverSettings;
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
  ocr: { url: '', engine: 'glm-ocr', askedReader: false, claudeCodePath: '', codexPath: '', assistantsSearched: false, llmUrl: '', llmModel: '' },
  smtp: { host: '', port: 587, secure: false, user: '', fromName: '', fromEmail: '', bcc: '', replyTo: '' },
  mailIn: { enabled: false, host: '', port: 993, secure: true, user: '', folder: 'INBOX', extraFolders: [], processedFolder: 'Verwerkt', since: '' },
  autoUpdate: true,
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
  carPrivateUse: null,
  carCatalogValue: null,
  carInUseSince: null,
  carInUseMonth: null,
  phoneInternetBusinessPct: null,
  homeWorkspace: null,
  partnerHours: 0,
  taxCheckAcknowledgedYear: 0,
  startYear: null,
  startersaftrekUsed: { count: 0, asOfYear: 0 },
  vatPotAccountId: null,
  incomeTaxEstimate: true,
  urencriterium: true,
  sendUbl: true,
  jobLocation: false,
  switchover: { mode: null, date: null, status: 'concept', provisional: false, filedElsewhere: [], dismissed: [], bankConfirmed: [], bankChecks: {}, accountantEquity: null },
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

function integerInRange(value: number, min: number, max: number, label: string): void {
  if (!Number.isInteger(value) || value < min || value > max) throw new ValidationError(`${label} moet een heel getal tussen ${min} en ${max} zijn`);
}

function validateSettings(settings: AppSettings): void {
  integerInRange(settings.paymentTermDays, 0, 365, 'Betaaltermijn');
  integerInRange(settings.quoteValidityDays, 1, 3650, 'Geldigheid offerte');
  integerInRange(settings.smtp.port, 1, 65535, 'SMTP-poort');
  integerInRange(settings.partnerHours, 0, 8784, 'Partneruren');
  if (settings.startYear !== null) integerInRange(settings.startYear, 1800, new Date().getFullYear() + 1, 'Startjaar');
  if (settings.phoneInternetBusinessPct !== null) integerInRange(settings.phoneInternetBusinessPct, 0, 100, 'Zakelijk percentage telefoon en internet');
  if (!['maand', 'kwartaal', 'jaar'].includes(settings.vatPeriod)) throw new ValidationError('Ongeldige btw-periode');
  if (!['hoog', 'laag', 'nul', 'verlegd', 'vrijgesteld'].includes(settings.defaultVatCode)) throw new ValidationError('Ongeldige standaard-btw');
  if (!['voorzichtig', 'normaal', 'maximaal'].includes(settings.autopilot)) throw new ValidationError('Ongeldige automatische stand');
  if (!['onbekend', 'prive', 'zakelijk', 'geen'].includes(settings.carUse)) throw new ValidationError('Ongeldige keuze voor zakelijk vervoer');
  if (settings.reminderDays.length > 12 || settings.reminderDays.some((day) => !Number.isInteger(day) || day < 0 || day > 365)) throw new ValidationError('Herinneringsdagen moeten hele getallen tussen 0 en 365 zijn');
  if (settings.smtp.fromEmail && !isValidEmail(settings.smtp.fromEmail)) throw new ValidationError('Het afzenderadres is geen geldig e-mailadres');
  if (settings.smtp.bcc && !isValidEmail(settings.smtp.bcc)) throw new ValidationError('Het BCC-adres is geen geldig e-mailadres');
  for (const [label, value] of [['Bedrijfsnaam', settings.company.name], ['SMTP-server', settings.smtp.host], ['E-mailtekst', settings.invoiceEmailBody]] as const) {
    if (value.length > 20_000) throw new ValidationError(`${label} is te lang`);
  }
}

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
      mailIn: { ...DEFAULT_SETTINGS.mailIn, ...((stored.mailIn as object) ?? {}) },
      profile: { ...DEFAULT_SETTINGS.profile, ...((stored.profile as object) ?? {}) },
      ocr: { ...DEFAULT_SETTINGS.ocr, ...((stored.ocr as object) ?? {}) },
      switchover: { ...DEFAULT_SETTINGS.switchover, ...((stored.switchover as object) ?? {}) },
    } as AppSettings;
  }

  update(patch: Partial<AppSettings>): AppSettings {
    const upsert = this.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
    const current = this.get();
    const candidate = { ...current, ...patch } as AppSettings;
    for (const key of ['company', 'smtp', 'profile', 'ocr'] as const) candidate[key] = { ...current[key], ...((patch[key] as object | undefined) ?? {}) } as never;
    validateSettings(candidate);
    this.db.transaction(() => {
      for (const [key, value] of Object.entries(patch)) {
        if (!(key in DEFAULT_SETTINGS) || value === undefined) continue;
        const merged = ['company', 'smtp', 'mailIn', 'profile', 'ocr', 'switchover'].includes(key) ? { ...(current[key as keyof AppSettings] as object), ...(value as object) } : value;
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
    if (!Number.isInteger(value) || value < 0) throw new Error('Vul je laatste factuurnummer in als getal');
    this.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(`counter:${name}`, JSON.stringify(value));
  }
}
