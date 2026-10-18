/** Hoe de app een klus noemt (#320): klus (standaard), project of opdracht. Eén plek voor lidwoorden en meervouden. */
export type JobTerm = 'klus' | 'project' | 'opdracht';

export const JOB_TERMS: readonly JobTerm[] = ['klus', 'project', 'opdracht'];

export interface JobWords {
  /** "klus" */ s: string;
  /** "Klus" */ S: string;
  /** "klussen" */ p: string;
  /** "Klussen" */ P: string;
  /** "de klus" / "het project" */ de: string;
  /** "deze klus" / "dit project" */ dit: string;
  /** "welke" / "welk": "Voor welke klus was dit?" */ welke: string;
  /** "andere" / "ander": "Naar andere klus", "Naar ander project" */ andere: string;
  /** "die" / "dat": "de klus die loopt", "het project dat loopt" */ die: string;
}

const WORDS: Record<JobTerm, { s: string; p: string; het: boolean }> = {
  klus: { s: 'klus', p: 'klussen', het: false },
  project: { s: 'project', p: 'projecten', het: true },
  opdracht: { s: 'opdracht', p: 'opdrachten', het: false },
};

const cap = (w: string) => w.charAt(0).toUpperCase() + w.slice(1);

export function isJobTerm(value: unknown): value is JobTerm {
  return typeof value === 'string' && (JOB_TERMS as readonly string[]).includes(value);
}

/** De woorden voor de gekozen term; een onbekende waarde valt terug op "klus". */
export function jobWords(term: unknown): JobWords {
  const t = WORDS[isJobTerm(term) ? term : 'klus'];
  return {
    s: t.s, S: cap(t.s), p: t.p, P: cap(t.p),
    de: `${t.het ? 'het' : 'de'} ${t.s}`,
    dit: `${t.het ? 'dit' : 'deze'} ${t.s}`,
    welke: t.het ? 'welk' : 'welke',
    andere: t.het ? 'ander' : 'andere',
    die: t.het ? 'dat' : 'die',
  };
}
