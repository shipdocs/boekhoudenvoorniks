import { describe, expect, it } from 'vitest';
import { setup } from './helpers';
import { makeJpeg } from './fixtures/jpeg';
import { WAITING_TO_READ_MESSAGE } from '../src/shared/reading';
import type { OcrProvider } from '../src/intake/ocr';
import type { FetchLike } from '../src/integrations/types';
import { makePdf } from './pdf';

/**
 * Een bon wordt op de achtergrond gelezen en daarna beoordeeld. Het beoordelen wacht op de
 * classificatie; in die tijd kan de gebruiker de bon zelf afhandelen. Wat hij deed, blijft staan.
 */

const DATUM = '2026-10-13';
const REGELS = ['Bouwmaat Utrecht', 'Datum: 13-10-2026', 'Gips 121,00', 'Totaal 121,00'];

const herkenning: OcrProvider = {
  id: 'test',
  label: 'Test-OCR',
  available: async () => true,
  recognize: async () => ({ items: REGELS.map((text, i) => ({ text, page: 1, bbox: [10, 20 + i * 20, 300, 34 + i * 20] as [number, number, number, number], confidence: 0.97 })) }),
};

/** Een administratie waarin de classificatie pas antwoord geeft na `verder()`. */
function metTrageClassificatie() {
  const t = setup();
  t.s.settings.update({ onboardingDone: true });
  const classifier = (t.s.intake as unknown as { classifier: { classify: (...a: unknown[]) => Promise<unknown> } }).classifier;
  const echt = classifier.classify.bind(classifier);
  let traag = false;
  let begonnen: () => void = () => undefined;
  let verder: () => void = () => undefined;
  let bezig = new Promise<void>((r) => (begonnen = r));
  let wacht = new Promise<void>((r) => (verder = r));
  classifier.classify = async (...a: unknown[]) => {
    if (!traag) return echt(...a);
    begonnen();
    await wacht;
    return echt(...a);
  };
  return {
    ...t,
    /** vanaf nu wacht de classificatie; geeft terug wanneer hij begonnen is en hoe hij verder mag */
    vertraag: () => {
      traag = true;
      bezig = new Promise<void>((r) => (begonnen = r));
      wacht = new Promise<void>((r) => (verder = r));
      return { bezig, verder: () => verder() };
    },
    rij: (id: number) => t.db.prepare('SELECT status, confidence, extraction_source, result, classification, issues, decisions, purchase_invoice_id, duplicate_of_document_id FROM documents WHERE id = ?').get(id),
  };
}

describe('bon op de achtergrond lezen: wat de gebruiker intussen deed, blijft staan', () => {
  it('bevestigt de gebruiker de bon terwijl de beoordeling nog loopt, dan blijft hij verwerkt', async () => {
    const t = metTrageClassificatie();
    const foto = makeJpeg('bevestigd tijdens beoordelen');
    const doc = await t.s.intake.add('bon.jpg', foto, DATUM);
    expect(doc).toMatchObject({ extraction_source: 'geen', status: 'controle' });
    t.s.intake.setOcrProvider(herkenning);
    const stap = t.vertraag();
    const lezen = t.s.intake.reread(doc.id, foto, DATUM);
    await stap.bezig;
    // de bon is gelezen, de classificatie loopt nog: nu boekt de gebruiker hem zelf
    t.s.intake.confirm(doc.id, { supplier: 'Hornbach', date: DATUM, total: 5000, invoiceNumber: null, categoryKey: 'materiaal', vatCode: 'hoog', business: true, paidWith: 'kas' });
    const bevestigd = t.rij(doc.id);
    expect(bevestigd).toMatchObject({ status: 'verwerkt' });
    stap.verder();
    const na = await lezen;
    expect(t.rij(doc.id)).toEqual(bevestigd);
    expect(na).toMatchObject({ status: 'verwerkt', outcome: 'nieuwe-aankoop' });
    expect(t.s.purchases.list().map((p) => p.total)).toEqual([5000]);
  });

  it('kiest de gebruiker privé terwijl de beoordeling nog loopt, dan blijft de bon weggelegd', async () => {
    const t = metTrageClassificatie();
    const foto = makeJpeg('prive tijdens beoordelen');
    const doc = await t.s.intake.add('bon.jpg', foto, DATUM);
    t.s.intake.setOcrProvider(herkenning);
    const stap = t.vertraag();
    const lezen = t.s.intake.reread(doc.id, foto, DATUM);
    await stap.bezig;
    t.s.intake.confirm(doc.id, { supplier: 'Hornbach', date: DATUM, total: 5000, invoiceNumber: null, categoryKey: 'materiaal', vatCode: 'hoog', business: false, paidWith: 'prive' });
    const prive = t.rij(doc.id);
    expect(prive).toMatchObject({ status: 'genegeerd' });
    stap.verder();
    await lezen;
    expect(t.rij(doc.id)).toEqual(prive);
    expect(t.s.purchases.list()).toEqual([]);
  });

  it('gaat de administratie dicht terwijl de beoordeling nog loopt, dan blijft de bon op lezen wachten', async () => {
    const t = metTrageClassificatie();
    t.s.intake.setOcrProvider(herkenning);
    const foto = makeJpeg('afsluiten tijdens beoordelen');
    const doc = await t.s.intake.add('bon.jpg', foto, DATUM, { autoConfirm: false, deferOcr: true });
    expect(doc.issues.find((i) => i.field === 'document')!.message).toBe(WAITING_TO_READ_MESSAGE);
    const wachtend = t.rij(doc.id);
    const stap = t.vertraag();
    let dicht = false;
    const lezen = t.s.intake.readLater(doc.id, { data: () => foto, cancelled: () => dicht });
    await stap.bezig;
    dicht = true;
    stap.verder();
    await lezen;
    // niets half: de bon is nog niet gelezen en wordt na de volgende start opnieuw opgepakt
    expect(t.rij(doc.id)).toEqual(wachtend);
    expect(t.s.intake.waitingToRead().map((d) => d.id)).toEqual([doc.id]);
  });

  it('zonder tussenkomst wordt de bon gelezen en beoordeeld zoals altijd', async () => {
    const t = metTrageClassificatie();
    t.s.intake.setOcrProvider(herkenning);
    const foto = makeJpeg('gewoon gelezen');
    const doc = await t.s.intake.add('bon.jpg', foto, DATUM, { autoConfirm: false, deferOcr: true });
    const stap = t.vertraag();
    const lezen = t.s.intake.readLater(doc.id, { data: () => foto });
    await stap.bezig;
    stap.verder();
    expect(await lezen).toMatchObject({ status: 'controle', extraction_source: 'ocr:test', reading: null, result: { total: { value: 12100 } } });
    expect((await lezen).classification).not.toBeNull();
    expect(t.s.intake.waitingToRead()).toEqual([]);
  });

  it('wordt de bon weggelegd terwijl een gewone herbeoordeling loopt, dan blijft hij weggelegd', async () => {
    // hetzelfde wachtpunt zit in elke beoordeling, bv. na "Nee" op de vraag of dit een factuur van je eigen bedrijf is
    const t = metTrageClassificatie();
    t.s.intake.setOcrProvider(herkenning);
    const doc = await t.s.intake.add('bon.jpg', makeJpeg('herbeoordelen'), DATUM, { autoConfirm: false });
    expect(doc).toMatchObject({ status: 'controle', extraction_source: 'ocr:test' });
    const stap = t.vertraag();
    const opnieuw = t.s.intake.evaluate(doc.id, [], DATUM, { autoConfirm: false });
    await stap.bezig;
    t.s.intake.confirm(doc.id, { supplier: 'Bouwmaat Utrecht', date: DATUM, total: 12100, invoiceNumber: null, categoryKey: 'materiaal', vatCode: 'hoog', business: true, paidWith: 'kas' });
    const bevestigd = t.rij(doc.id);
    stap.verder();
    await opnieuw;
    expect(t.rij(doc.id)).toEqual(bevestigd);
  });

  it('boekt de gebruiker een bon in vreemde munt terwijl de koers nog wordt opgehaald, dan blijft dat staan', async () => {
    // het openen van zo'n bon probeert de koers nog een keer (retryRate) en beoordeelt hem daarna opnieuw
    const CSV = ['KEY,FREQ,CURRENCY,CURRENCY_DENOM,EXR_TYPE,EXR_SUFFIX,TIME_PERIOD,OBS_VALUE', 'EXR.D.USD.EUR.SP00.A,D,USD,EUR,SP00,A,2026-05-05,1.0800'].join('\n');
    let online = false;
    let gevraagd: () => void = () => undefined;
    let antwoord: () => void = () => undefined;
    const bezig = new Promise<void>((r) => (gevraagd = r));
    const wacht = new Promise<void>((r) => (antwoord = r));
    const fetch = (async () => {
      if (!online) throw new Error('geen internet');
      gevraagd();
      await wacht;
      return { ok: true, status: 200, json: async () => ({}), text: async () => CSV };
    }) as FetchLike;
    const { s, db } = setup({ fetch });
    const rij = (id: number) => db.prepare('SELECT status, confidence, extraction_source, result, classification, issues, decisions, purchase_invoice_id FROM documents WHERE id = ?').get(id);
    const doc = await s.intake.add('invoice.pdf', makePdf(['Invoice', 'Invoice number ABCD-0005', 'Date of issue May 6, 2026', 'Anthropic, PBC', 'Max plan 1 $90.00', 'Total $90.00', 'Amount due $90.00 USD']), '2026-05-08');
    expect(doc.result?.foreign).toMatchObject({ currency: 'USD', rate: null });
    online = true;
    const opnieuw = s.intake.retryRate(doc.id, '2026-05-08');
    await bezig;
    s.intake.confirm(doc.id, { supplier: 'Anthropic', date: '2026-05-06', total: 8400, invoiceNumber: 'ABCD-0005', categoryKey: 'materiaal', vatCode: 'hoog', business: true, paidWith: 'later' });
    const geboekt = rij(doc.id);
    expect(geboekt).toMatchObject({ status: 'verwerkt' });
    antwoord();
    await opnieuw;
    expect(rij(doc.id)).toEqual(geboekt);
  });
});
