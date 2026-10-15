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
