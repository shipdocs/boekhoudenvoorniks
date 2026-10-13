import type { IntakeDocument } from '../intake/intake';
import { proposedPaidWith, type PaidWith } from './paid-with';
import type { PurchaseVatCode } from './vat';

/** Het formulier bij een bon (scherm "bon bekijken"): wat de gebruiker bevestigt. */
export interface ReviewForm {
  supplier: string;
  date: string;
  total: number | null;
  invoiceNumber: string;
  vatAmount: number | null;
  categoryKey: string;
  vatCode: PurchaseVatCode;
  vatRate: 9 | 21;
  business: boolean;
  businessPct: number | null;
  paidWith: PaidWith;
  jobId: number | null;
  splits: { categoryKey: string; gross: number; vatRate?: number }[] | null;
}

type ReviewDoc = Pick<IntakeDocument, 'result' | 'classification' | 'proposed_paid_with' | 'bank_match' | 'bank_match_strong' | 'extraction_source'>;

/** Het formulier zoals de app het voorstelt bij dit document. De klus stelt het scherm apart voor. */
export function proposedForm(d: ReviewDoc): ReviewForm {
  const r = d.result;
  return {
    supplier: r?.supplier?.value ?? '',
    date: r?.invoiceDate?.value ?? '',
    total: r?.total?.value ?? null,
    invoiceNumber: r?.invoiceNumber?.value ?? '',
    vatAmount: null,
    categoryKey: d.classification?.categoryKey ?? 'materiaal',
    vatCode: (d.classification?.vatCode ?? 'hoog') as PurchaseVatCode,
    vatRate: 21,
    business: d.classification?.business ?? true,
    businessPct: null,
    // de betaalwijze die op de telefoon is gekozen (bonnenscanner) is het voorstel
    paidWith: proposedPaidWith(d),
    jobId: null,
    splits: null,
  };
}

/** Om twee formulieren te vergelijken; de klus telt niet mee, die vult de app zelf nog in. */
export const formKey = (f: ReviewForm): string => JSON.stringify({ ...f, jobId: null });

/** Wat het scherm aan de beslisfunctie geeft: hoe het er nu staat, hoe er geladen wordt en hoe het resultaat op het scherm komt. */
export interface ReloadIo<V extends { doc: ReviewDoc }> {
  /** het formulier en het document zoals ze er nu staan, en het formulier zoals de app het voorstelde (zie formKey) */
  current: () => { form: ReviewForm | null; proposed: string | null; doc: ReviewDoc };
  /** de gegevens van de bon zoals ze nu zijn; null als dat niet lukt */
  load: () => Promise<V | null>;
  /**
   * Document en formulier samen vervangen; zonder `form` blijft het formulier zoals het is.
   * `readMeanwhile`: melden dat de bon intussen gelezen is en de invoer is blijven staan.
   */
  apply: (next: { view: V; form?: ReviewForm; readMeanwhile?: boolean }) => void;
}

/**
 * De ene plek waar wordt beslist wat er met het formulier gebeurt als de bon opnieuw geladen wordt.
 * Elke weg op het scherm die na een wachtpunt het formulier of de klus zou kunnen zetten, loopt hierlangs.
 *
 * Eerst de nieuwe gegevens laden, dan pas kijken wat er op dat moment in het formulier staat: wat de
 * gebruiker tijdens het laden typt of kiest, telt dus mee. Het formulier wordt alleen vervangen als
 * het nog is wat het was (`unchanged`); dan komt het nieuwe voorstel erin, in dezelfde stap als het
 * nieuwe document (het wordt nooit uit het oude document gevuld). Anders blijft de invoer staan. De
 * klus is altijd die van ná het laden.
 */
async function reload<V extends { doc: ReviewDoc }>(io: ReloadIo<V>, unchanged: (now: { form: ReviewForm; proposed: string | null }) => boolean): Promise<void> {
  const wasUnread = io.current().doc.extraction_source === 'geen';
  const view = await io.load();
  if (!view) return;
  const { form, proposed } = io.current();
  // het formulier is er (nog) niet: het scherm vult het zelf uit de gegevens die het dan heeft
  if (!form) return;
  if (unchanged({ form, proposed })) return io.apply({ view, form: { ...proposedForm(view.doc), jobId: form.jobId } });
  // de invoer blijft staan; is de bon in de tussentijd gelezen, dan meldt het scherm dat
  io.apply({ view, readMeanwhile: (wasUnread && view.doc.extraction_source !== 'geen') || undefined });
}

/** Het formulier is nog wat de app voorstelde: de gebruiker heeft er niets aan veranderd. */
const untouched = (now: { form: ReviewForm; proposed: string | null }): boolean => formKey(now.form) === now.proposed;

/**
 * De bon staat open en er is op de achtergrond iets aan veranderd (hij wordt gelezen, of is gelezen).
 * Niets ingevuld: de gelezen gegevens komen in het formulier. Wel iets ingevuld: dat blijft staan, met
 * de melding dat de bon intussen gelezen is.
 */
export function reloadAfterRead<V extends { doc: ReviewDoc }>(io: ReloadIo<V>): Promise<void> {
  return reload(io, untouched);
}

/**
 * De gebruiker koos bij de bon zelf hoe hij gelezen wordt ("Nu lezen"); het lezen is klaar. Dat is geen
 * verzoek om zijn invoer te vervangen: dezelfde regel als bij lezen op de achtergrond.
 */
export function afterReaderDone<V extends { doc: ReviewDoc }>(io: ReloadIo<V>): Promise<void> {
  return reload(io, untouched);
}

/**
 * Na een keuze bij de bon (een voorstel beantwoord, ontkoppeld, "van mijn eigen bedrijf"): de app kan
 * nu iets anders voorstellen. Dat komt in het formulier, tenzij de gebruiker zelf iets had veranderd.
 */
export function afterDecision<V extends { doc: ReviewDoc }>(io: ReloadIo<V>): Promise<void> {
  return reload(io, untouched);
}

/**
 * "Gelezen gegevens tonen": de gebruiker kiest ervoor zijn invoer te laten vervangen. Vervangen wordt
 * wat er op het moment van klikken stond; typt hij daarna nog iets terwijl de gegevens onderweg zijn,
 * dan blijft dat staan (en blijft de knop er, zodat hij opnieuw kan kiezen).
 */
export function showReadData<V extends { doc: ReviewDoc }>(io: ReloadIo<V>): Promise<void> {
  const clicked = io.current().form;
  const key = clicked ? formKey(clicked) : null;
  return reload(io, (now) => formKey(now.form) === key);
}

