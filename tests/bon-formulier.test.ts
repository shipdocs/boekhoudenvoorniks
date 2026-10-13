import { describe, expect, it } from 'vitest';
import { formKey, proposedForm, reloadAfterRead, type ReviewForm } from '../src/shared/review-form';

/**
 * Het scherm "bon bekijken" terwijl de bon op de achtergrond gelezen wordt: wat de gebruiker intussen
 * invult of kiest, blijft staan; heeft hij niets gedaan, dan komen de gelezen gegevens in het formulier.
 */

type Doc = Parameters<typeof proposedForm>[0];

const veld = <T>(value: T) => ({ value, confidence: 0.9, source: 'ocr:test' });
const ONGELEZEN = { extraction_source: 'geen', result: null, classification: null, proposed_paid_with: null, bank_match: null, bank_match_strong: false } as unknown as Doc;
const GELEZEN = {
  ...ONGELEZEN,
  extraction_source: 'ocr:test',
  result: { supplier: veld('Bouwmaat'), invoiceDate: veld('2026-10-13'), total: veld(12100), invoiceNumber: veld('F-1') },
  classification: { categoryKey: 'gereedschap', vatCode: 'hoog', business: true },
} as unknown as Doc;

/** Het scherm, nagebootst: het document, het formulier en wat de app voorstelde. */
function scherm(doc: Doc = ONGELEZEN) {
  const s = {
    doc,
    form: proposedForm(doc) as ReviewForm | null,
    proposed: formKey(proposedForm(doc)) as string | null,
    intussenGelezen: false,
    /** hoe vaak het scherm is bijgewerkt, en of document en formulier daarbij samen zijn vervangen */
    bijgewerkt: [] as { doc: boolean; form: boolean }[],
  };
  /** de bon is veranderd; `tijdensLaden` gebeurt terwijl de nieuwe gegevens onderweg zijn */
  const gebeurtenis = (nieuw: Doc | null, tijdensLaden: () => void = () => undefined) =>
    reloadAfterRead({
      current: () => ({ form: s.form, proposed: s.proposed }),
      load: async () => {
        await Promise.resolve();
        tijdensLaden();
        return nieuw ? { doc: nieuw } : null;
      },
      apply: (next) => {
        s.bijgewerkt.push({ doc: true, form: !!next.form });
        s.doc = next.view.doc;
        if (next.form) {
          s.form = next.form;
          s.proposed = formKey(next.form);
          s.intussenGelezen = false;
        } else if (next.readMeanwhile) s.intussenGelezen = true;
      },
    });
  return { s, gebeurtenis };
}

describe('bon bekijken terwijl hij op de achtergrond gelezen wordt', () => {
  it('niets ingevuld: de gelezen gegevens komen in het formulier, samen met het nieuwe document', async () => {
    const { s, gebeurtenis } = scherm();
    await gebeurtenis(GELEZEN);
    expect(s.form).toMatchObject({ supplier: 'Bouwmaat', date: '2026-10-13', total: 12100, invoiceNumber: 'F-1', categoryKey: 'gereedschap' });
    expect(s.doc).toBe(GELEZEN);
    expect(s.intussenGelezen).toBe(false);
    // één keer bijgewerkt, document en formulier tegelijk: er is geen moment waarop het formulier uit het oude, lege document gevuld kan worden
    expect(s.bijgewerkt).toEqual([{ doc: true, form: true }]);
    // en het geldt daarna als het voorstel van de app: een volgende wijziging van de gebruiker is weer te herkennen
    expect(s.proposed).toBe(formKey(s.form!));
  });

  it('typt de gebruiker terwijl de nieuwe gegevens geladen worden, dan blijft dat staan', async () => {
    const { s, gebeurtenis } = scherm();
    await gebeurtenis(GELEZEN, () => {
      s.form = { ...s.form!, supplier: 'Hornbach' };
    });
    expect(s.form).toMatchObject({ supplier: 'Hornbach', total: null });
    expect(s.intussenGelezen).toBe(true);
    expect(s.doc).toBe(GELEZEN);
  });

  it('een gekozen klus verdwijnt niet als de gelezen gegevens in het formulier komen', async () => {
    const { s, gebeurtenis } = scherm();
    s.form = { ...s.form!, jobId: 7 };
    await gebeurtenis(GELEZEN);
    expect(s.form).toMatchObject({ supplier: 'Bouwmaat', total: 12100, jobId: 7 });
    expect(s.intussenGelezen).toBe(false);
    // ook als de klus tijdens het laden gekozen wordt
    const tweede = scherm();
    await tweede.gebeurtenis(GELEZEN, () => {
      tweede.s.form = { ...tweede.s.form!, jobId: 9 };
    });
    expect(tweede.s.form).toMatchObject({ supplier: 'Bouwmaat', jobId: 9 });
  });

  it('al iets ingevuld vóór het lezen klaar was: de invoer blijft staan, met de melding dat de bon intussen gelezen is', async () => {
    const { s, gebeurtenis } = scherm();
    s.form = { ...s.form!, supplier: 'Hornbach', total: 5000, jobId: 3 };
    const ingevuld = s.form;
    await gebeurtenis(GELEZEN);
    expect(s.form).toBe(ingevuld);
    expect(s.intussenGelezen).toBe(true);
    expect(s.bijgewerkt).toEqual([{ doc: true, form: false }]);
  });

  it('de bon is nog niet gelezen (hij is alleen aan de beurt): alleen de stand verandert, het formulier niet', async () => {
    const { s, gebeurtenis } = scherm();
    const bezig = { ...ONGELEZEN, reading: 'bezig' } as unknown as Doc;
    const form = s.form;
    await gebeurtenis(bezig);
    expect(s.doc).toBe(bezig);
    expect(s.form).toBe(form);
    expect(s.intussenGelezen).toBe(false);
  });

  it('laden mislukt, of het formulier is intussen weg (er wordt al opnieuw geladen): er verandert niets', async () => {
    const { s, gebeurtenis } = scherm();
    await gebeurtenis(null);
    expect(s.bijgewerkt).toEqual([]);
    // het formulier verdwijnt tijdens het laden (bv. na een keuze van de gebruiker): het scherm vult het zelf uit de nieuwe gegevens
    await gebeurtenis(GELEZEN, () => {
      s.form = null;
    });
    expect(s.form).toBeNull();
    expect(s.intussenGelezen).toBe(false);
  });

  it('het voorstel van de app: leeg bij een ongelezen bon, de gelezen gegevens bij een gelezen bon', () => {
    expect(proposedForm(ONGELEZEN)).toEqual({ supplier: '', date: '', total: null, invoiceNumber: '', vatAmount: null, categoryKey: 'materiaal', vatCode: 'hoog', vatRate: 21, business: true, businessPct: null, paidWith: 'later', jobId: null, splits: null });
    expect(proposedForm({ ...GELEZEN, proposed_paid_with: 'kas' } as Doc)).toMatchObject({ supplier: 'Bouwmaat', paidWith: 'kas', jobId: null });
    // de klus telt niet mee bij de vraag of de gebruiker iets heeft veranderd
    expect(formKey({ ...proposedForm(ONGELEZEN), jobId: 4 })).toBe(formKey(proposedForm(ONGELEZEN)));
  });
});
