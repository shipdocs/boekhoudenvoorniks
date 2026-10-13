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

/**
 * De bon staat open en er is op de achtergrond iets aan veranderd (hij wordt gelezen, of is gelezen).
 *
 * Eerst de nieuwe gegevens laden, dan pas kijken wat er op dat moment in het formulier staat: wat de
 * gebruiker tijdens het laden typt of kiest, telt dus mee. Heeft hij niets veranderd, dan komen de
 * gelezen gegevens in het formulier, in dezelfde stap als het nieuwe document (het formulier wordt
 * nooit uit het oude, lege document gevuld). Heeft hij wel iets veranderd, dan blijft zijn invoer
 * staan en meldt het scherm dat de bon intussen gelezen is. Een gekozen klus blijft altijd staan.
 */
export async function reloadAfterRead<V extends { doc: ReviewDoc }>(io: {
  /** wat er nu in het formulier staat, en het formulier zoals de app het voorstelde (zie formKey) */
  current: () => { form: ReviewForm | null; proposed: string | null };
  /** de gegevens van de bon zoals ze nu zijn; null als dat niet lukt */
  load: () => Promise<V | null>;
  /** document en formulier samen vervangen; zonder `form` blijft het formulier zoals het is */
  apply: (next: { view: V; form?: ReviewForm; readMeanwhile?: boolean }) => void;
}): Promise<void> {
  const view = await io.load();
  if (!view) return;
  const { form, proposed } = io.current();
  // het formulier is er niet (het scherm laadt zelf al opnieuw): dat vult het daarna uit de nieuwe gegevens
  if (!form) return;
  // nog niet gelezen: alleen de stand (wacht, wordt gelezen) is veranderd
  if (view.doc.extraction_source === 'geen') return io.apply({ view });
  if (formKey(form) === proposed) io.apply({ view, form: { ...proposedForm(view.doc), jobId: form.jobId } });
  else io.apply({ view, readMeanwhile: true });
}
