import { describe, expect, it } from 'vitest';
import { afterDecision, afterReaderDone, formKey, loadTurn, openReview, proposedForm, reloadAfterRead, showReadData, type ReviewForm } from '../src/shared/review-form';

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
    fout: null as string | null,
    /** hoe vaak het scherm is bijgewerkt, en of document en formulier daarbij samen zijn vervangen */
    bijgewerkt: [] as { doc: boolean; form: boolean }[],
  };
  /** één teller voor alle laadacties van het scherm */
  const turn = loadTurn();
  /**
   * De bon is veranderd; `tijdensLaden` gebeurt terwijl de nieuwe gegevens onderweg zijn. `route`: langs
   * welke weg het scherm opnieuw laadt (standaard: de melding dat er op de achtergrond iets gelezen is).
   */
  const gebeurtenis = (nieuw: Doc | null, tijdensLaden: () => void = () => undefined, route: Route = reloadAfterRead) =>
    laad(route, async () => {
      await Promise.resolve();
      tijdensLaden();
      if (!nieuw) throw new Error('geen verbinding');
      return { doc: nieuw };
    });
  /** het scherm laadt langs deze weg; `haal` levert de gegevens (of mislukt) */
  const laad = (route: Route, haal: () => Promise<{ doc: Doc }>) =>
    route({
      turn,
      current: () => ({ form: s.form, proposed: s.proposed, doc: s.doc }),
      load: haal,
      apply: (next) => {
        s.bijgewerkt.push({ doc: true, form: !!next.form });
        s.doc = next.view.doc;
        s.fout = null;
        if (next.form) {
          s.form = next.form;
          s.proposed = formKey(next.form);
          s.intussenGelezen = false;
        } else if (next.readMeanwhile) s.intussenGelezen = true;
      },
      failed: (melding) => void (s.fout = melding),
    });
  return { s, gebeurtenis, laad };
}

type Route = typeof reloadAfterRead;

/** Een laadactie waarvan de test bepaalt wanneer het antwoord komt. */
function uitgesteld() {
  let klaar: (doc: Doc) => void = () => undefined;
  let mislukt: (fout: Error) => void = () => undefined;
  const antwoord = new Promise<{ doc: Doc }>((resolve, reject) => {
    klaar = (doc) => resolve({ doc });
    mislukt = reject;
  });
  return { haal: () => antwoord, klaar, mislukt };
}
/** alles wat al klaarstaat laten gebeuren */
const even = () => new Promise((r) => setTimeout(r, 0));

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
    expect(s.form).toEqual(form);
    expect(s.intussenGelezen).toBe(false);
  });

  it('laden mislukt ook bij de tweede poging: er verandert niets, het scherm krijgt de foutmelding', async () => {
    const { s, gebeurtenis } = scherm();
    const form = s.form;
    await gebeurtenis(null);
    expect(s.bijgewerkt).toEqual([]);
    expect(s.form).toBe(form);
    expect(s.fout).toBe('geen verbinding');
    // een volgende laadactie die lukt haalt de melding weer weg
    await gebeurtenis(GELEZEN);
    expect(s.fout).toBeNull();
    expect(s.form).toMatchObject({ supplier: 'Bouwmaat' });
  });

  it('laden mislukt één keer: de tweede poging gaat langs dezelfde bewaking, dus de gelezen gegevens komen in het formulier', async () => {
    // een ongelezen bon staat open; het ophalen na de melding "gelezen" mislukt eenmalig en lukt daarna
    const eenmalig = (doc: Doc) => {
      let keer = 0;
      return async () => {
        if (keer++ === 0) throw new Error('even geen verbinding');
        return { doc };
      };
    };
    const { s, laad } = scherm();
    await laad(reloadAfterRead, eenmalig(GELEZEN));
    expect(s.doc).toBe(GELEZEN);
    expect(s.form).toMatchObject({ supplier: 'Bouwmaat', total: 12100 });
    expect(s.fout).toBeNull();
    // had de gebruiker zelf iets ingevuld, dan blijft dat staan en verschijnt "Gelezen gegevens tonen"
    const tweede = scherm();
    tweede.s.form = { ...tweede.s.form!, supplier: 'Hornbach' };
    await tweede.laad(reloadAfterRead, eenmalig(GELEZEN));
    expect(tweede.s.form).toMatchObject({ supplier: 'Hornbach' });
    expect(tweede.s.intussenGelezen).toBe(true);
    expect(tweede.s.doc).toBe(GELEZEN);
  });

  it('een ouder laadantwoord dat later binnenkomt, draait het nieuwere leesresultaat niet terug', async () => {
    // twee meldingen kort na elkaar: de eerste laadactie haalde nog de ongelezen bon op en wacht; de tweede levert de gelezen bon
    const { s, laad } = scherm();
    const eerste = uitgesteld();
    const tweede = uitgesteld();
    const a = laad(reloadAfterRead, eerste.haal);
    const b = laad(reloadAfterRead, tweede.haal);
    tweede.klaar(GELEZEN);
    await b;
    expect(s.form).toMatchObject({ supplier: 'Bouwmaat', total: 12100 });
    eerste.klaar({ ...ONGELEZEN, reading: 'bezig' } as unknown as Doc);
    await a;
    expect(s.doc).toBe(GELEZEN);
    expect(s.form).toMatchObject({ supplier: 'Bouwmaat', total: 12100 });
    expect(s.bijgewerkt).toHaveLength(1);
    // ook een oudere laadactie die mislukt en het opnieuw probeert, komt er niet meer tussen
    const derde = uitgesteld();
    const c = laad(reloadAfterRead, derde.haal);
    await laad(afterDecision, async () => ({ doc: GELEZEN }));
    derde.mislukt(new Error('te laat'));
    await c;
    expect(s.fout).toBeNull();
    expect(s.bijgewerkt).toHaveLength(2);
  });

  it('wisselt de gebruiker naar een andere bon terwijl de vorige nog laadt, dan komt het antwoord van de vorige niet meer op het scherm', async () => {
    const ANDERE = { ...GELEZEN, result: { ...(GELEZEN.result as object), supplier: veld('Gamma'), total: veld(4500) } } as unknown as Doc;
    const { s, laad } = scherm();
    const vorige = uitgesteld();
    const a = laad(reloadAfterRead, vorige.haal);
    // de andere bon gaat open: het formulier begint met wat de app voor díe bon voorstelt
    s.form = { ...s.form!, supplier: 'Nog van de vorige bon', jobId: 5 };
    await laad(openReview, async () => ({ doc: ANDERE }));
    expect(s.form).toMatchObject({ supplier: 'Gamma', total: 4500, jobId: null });
    vorige.klaar(GELEZEN);
    await a;
    expect(s.doc).toBe(ANDERE);
    expect(s.form).toMatchObject({ supplier: 'Gamma', total: 4500 });
    // en andersom: het openen duurt lang, intussen niets anders; het antwoord komt gewoon aan
    const traag = uitgesteld();
    const open = scherm();
    open.s.form = null;
    const b = open.laad(openReview, traag.haal);
    await even();
    expect(open.s.form).toBeNull();
    traag.klaar(GELEZEN);
    await b;
    expect(open.s.form).toMatchObject({ supplier: 'Bouwmaat' });
    expect(open.s.proposed).toBe(formKey(open.s.form!));
  });

  it('"Nu lezen" bij de bon zelf: wie tijdens het lezen invult, houdt zijn invoer als het lezen klaar is', async () => {
    // de keuze om te lezen roept na afloop vanzelf het opnieuw laden aan; dat is geen verzoek om de invoer te vervangen
    const { s, gebeurtenis } = scherm();
    s.form = { ...s.form!, supplier: 'Hornbach', total: 5000 };
    const ingevuld = s.form;
    await gebeurtenis(GELEZEN, undefined, afterReaderDone);
    expect(s.form).toBe(ingevuld);
    expect(s.intussenGelezen).toBe(true);
    expect(s.doc).toBe(GELEZEN);
    // ook wie pas tijdens het ophalen van de gelezen gegevens begint te typen
    const tweede = scherm();
    await tweede.gebeurtenis(GELEZEN, () => {
      tweede.s.form = { ...tweede.s.form!, supplier: 'Gamma' };
    }, afterReaderDone);
    expect(tweede.s.form).toMatchObject({ supplier: 'Gamma', total: null });
    expect(tweede.s.intussenGelezen).toBe(true);
    // niets ingevuld: de gelezen gegevens komen in het formulier
    const derde = scherm();
    await derde.gebeurtenis(GELEZEN, undefined, afterReaderDone);
    expect(derde.s.form).toMatchObject({ supplier: 'Bouwmaat', total: 12100 });
    expect(derde.s.intussenGelezen).toBe(false);
  });

  it('wisselt de gebruiker tijdens het laden van klus 7 naar klus 9, dan blijft klus 9 staan', async () => {
    for (const route of [reloadAfterRead, afterReaderDone, showReadData, afterDecision]) {
      const { s, gebeurtenis } = scherm();
      s.form = { ...s.form!, jobId: 7 };
      await gebeurtenis(GELEZEN, () => {
        s.form = { ...s.form!, jobId: 9 };
      }, route);
      expect(s.form, route.name).toMatchObject({ supplier: 'Bouwmaat', jobId: 9 });
    }
  });

  it('"Gelezen gegevens tonen" vervangt wat er bij het klikken stond, niet wat de gebruiker daarna nog intypt', async () => {
    // de gebruiker had zelf ingevuld, de bon is intussen gelezen en hij kiest ervoor de gelezen gegevens te zien
    const { s, gebeurtenis } = scherm();
    s.form = { ...s.form!, supplier: 'Hornbach', total: 5000, jobId: 3 };
    await gebeurtenis(GELEZEN);
    expect(s.intussenGelezen).toBe(true);
    await gebeurtenis(GELEZEN, undefined, showReadData);
    expect(s.form).toMatchObject({ supplier: 'Bouwmaat', total: 12100, jobId: 3 });
    expect(s.intussenGelezen).toBe(false);
    expect(s.proposed).toBe(formKey(s.form!));

    // na de klik, terwijl de gegevens onderweg zijn, typt hij nog iets: dat blijft staan en de keuze blijft aangeboden
    const tweede = scherm();
    tweede.s.form = { ...tweede.s.form!, supplier: 'Hornbach' };
    await tweede.gebeurtenis(GELEZEN);
    await tweede.gebeurtenis(GELEZEN, () => {
      tweede.s.form = { ...tweede.s.form!, supplier: 'Hornbach Zwolle', total: 4200 };
    }, showReadData);
    expect(tweede.s.form).toMatchObject({ supplier: 'Hornbach Zwolle', total: 4200 });
    expect(tweede.s.intussenGelezen).toBe(true);
    expect(tweede.s.doc).toBe(GELEZEN);
  });

  it('na een keuze bij de bon (bv. "Nee, een gewone aankoop"): het nieuwe voorstel komt in het formulier, tenzij de gebruiker zelf iets had veranderd', async () => {
    const ander = { ...GELEZEN, classification: { categoryKey: 'kantoor', vatCode: 'hoog', business: true } } as unknown as Doc;
    const { s, gebeurtenis } = scherm(GELEZEN);
    await gebeurtenis(ander, undefined, afterDecision);
    expect(s.form).toMatchObject({ supplier: 'Bouwmaat', categoryKey: 'kantoor' });
    // zelf iets veranderd (ook tijdens het laden): dat blijft staan, zonder de melding over lezen
    const tweede = scherm(GELEZEN);
    await tweede.gebeurtenis(ander, () => {
      tweede.s.form = { ...tweede.s.form!, total: 9900 };
    }, afterDecision);
    expect(tweede.s.form).toMatchObject({ total: 9900, categoryKey: 'gereedschap' });
    expect(tweede.s.intussenGelezen).toBe(false);
    expect(tweede.s.doc).toBe(ander);
  });

  it('het voorstel van de app: leeg bij een ongelezen bon, de gelezen gegevens bij een gelezen bon', () => {
    expect(proposedForm(ONGELEZEN)).toEqual({ supplier: '', description: '', date: '', total: null, invoiceNumber: '', vatAmount: null, categoryKey: 'materiaal', vatCode: 'hoog', vatRate: 21, business: true, businessPct: null, paidWith: 'later', jobId: null, splits: null });
    expect(proposedForm({ ...GELEZEN, proposed_paid_with: 'kas' } as Doc)).toMatchObject({ supplier: 'Bouwmaat', paidWith: 'kas', jobId: null });
    // de klus telt niet mee bij de vraag of de gebruiker iets heeft veranderd
    expect(formKey({ ...proposedForm(ONGELEZEN), jobId: 4 })).toBe(formKey(proposedForm(ONGELEZEN)));
  });
});
