import { describe, expect, it } from 'vitest';
import { setup } from './helpers';
import { jobWords } from '../src/shared/job-term';

describe('term voor een klus (#320)', () => {
  it('klus: standaard, "de"-woord', () => {
    expect(jobWords('klus')).toMatchObject({ s: 'klus', S: 'Klus', p: 'klussen', P: 'Klussen', de: 'de klus', dit: 'deze klus', welke: 'welke', andere: 'andere', die: 'die' });
  });
  it('project: "het"-woord, dus welk/ander/dat/dit', () => {
    expect(jobWords('project')).toMatchObject({ s: 'project', P: 'Projecten', de: 'het project', dit: 'dit project', welke: 'welk', andere: 'ander', die: 'dat' });
  });
  it('opdracht: "de"-woord', () => {
    expect(jobWords('opdracht')).toMatchObject({ p: 'opdrachten', de: 'de opdracht', dit: 'deze opdracht', welke: 'welke' });
  });
  it('een onbekende waarde valt terug op klus', () => {
    expect(jobWords('iets anders').s).toBe('klus');
    expect(jobWords(undefined).p).toBe('klussen');
  });
  it('de instelling staat standaard op klus, is te wijzigen en weigert andere waarden', () => {
    const { s } = setup();
    expect(s.settings.get().jobTerm).toBe('klus');
    s.settings.update({ jobTerm: 'project' });
    expect(s.settings.get().jobTerm).toBe('project');
    expect(() => s.settings.update({ jobTerm: 'werk' as never })).toThrow(/term/);
    expect(s.settings.get().jobTerm).toBe('project');
  });
});

describe('klussen verbergen (#320)', () => {
  it('staat standaard aan en weigert iets anders dan ja of nee', () => {
    const { s } = setup();
    expect(s.settings.get().jobsEnabled).toBe(true);
    expect(() => s.settings.update({ jobsEnabled: 'nee' as never })).toThrow(/klussen/);
  });
  it('een klus die klaar is geeft een taak op Vandaag; met klussen uit verdwijnt die, de klus blijft bestaan', () => {
    const { s, klant } = setup();
    const q = s.quotes.create({ relationId: klant.id, reference: 'Schilderen', lines: [{ description: 'Schilderen', quantity: 1, unit: 'totaal', unitPrice: 10000, vatCode: 'hoog' }] });
    const job = s.jobs.acceptQuote(q.id);
    s.jobs.setStatus(job.id, 'klaar');
    expect(s.inbox.tasks('2026-09-25').some((t) => t.kind === 'job-done')).toBe(true);
    s.settings.update({ jobsEnabled: false });
    expect(s.inbox.tasks('2026-09-25').some((t) => t.kind === 'job-done')).toBe(false);
    expect(s.jobs.get(job.id)).toMatchObject({ status: 'klaar' });
    s.settings.update({ jobsEnabled: true });
    expect(s.inbox.tasks('2026-09-25').some((t) => t.kind === 'job-done')).toBe(true);
  });
  it('zonder klussen kan een offerte op akkoord en daarna naar een factuur, zonder klus', () => {
    const { s, klant } = setup();
    s.settings.update({ jobsEnabled: false });
    const q = s.quotes.create({ relationId: klant.id, reference: 'Schilderen', lines: [{ description: 'Schilderen', quantity: 1, unit: 'totaal', unitPrice: 10000, vatCode: 'hoog' }] });
    s.quotes.setStatus(q.id, 'geaccepteerd');
    const inv = s.quotes.convertToInvoice(q.id);
    expect(inv.lines).toHaveLength(1);
    expect(s.jobs.list({}).length).toBe(0);
  });
});
