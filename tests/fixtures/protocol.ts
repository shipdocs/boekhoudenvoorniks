import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * De voorbeelden van het protocol van de bonnenscanner als vaste testgegevens: een bestand per onderwerp in
 * tests/fixtures/protocol/. Elk bestand bestaat uit blokken van een kopregel `== sleutel ==` met daaronder de
 * tekst van het voorbeeld, letterlijk (dezelfde bytes, dezelfde volgorde van sleutels in de JSON). De tests
 * lezen ze als tekst en verwerken ze zelf, zoals een telefoon ze zou zien.
 *
 * tests/protocol-document.test.ts kan deze gegevens vergelijken met de volledige technische beschrijving.
 */
const MAP = join(__dirname, 'protocol');
const KOP = /^== ([a-z0-9-]+) ==$/;

/** De onderwerpen waarvoor testgegevens bestaan (de bestandsnamen zonder extensie), op alfabet. */
export function protocolOnderwerpen(): string[] {
  return readdirSync(MAP)
    .filter((naam) => naam.endsWith('.txt'))
    .map((naam) => naam.slice(0, -'.txt'.length))
    .sort();
}

/** De voorbeelden van een onderwerp, in de volgorde van het bestand: sleutel → letterlijke tekst. */
export function protocolVoorbeelden(onderwerp: string): Record<string, string> {
  // op Windows kan het bestand met \r\n uitgecheckt zijn
  const regels = readFileSync(join(MAP, `${onderwerp}.txt`), 'utf8').replace(/\r\n/g, '\n').split('\n');
  const uit: Record<string, string> = {};
  let sleutel: string | null = null;
  let tekst: string[] = [];
  const sluit = () => {
    if (sleutel === null) return;
    const waarde = tekst.join('\n').trim();
    if (!waarde) throw new Error(`${onderwerp}.txt: het voorbeeld ${sleutel} is leeg`);
    uit[sleutel] = waarde;
  };
  for (const regel of regels) {
    const kop = KOP.exec(regel);
    if (!kop) {
      if (sleutel === null && regel.trim()) throw new Error(`${onderwerp}.txt: tekst vóór de eerste kopregel`);
      tekst.push(regel);
      continue;
    }
    sluit();
    sleutel = kop[1]!;
    if (Object.hasOwn(uit, sleutel)) throw new Error(`${onderwerp}.txt: de sleutel ${sleutel} staat er twee keer in`);
    tekst = [];
  }
  sluit();
  if (Object.keys(uit).length === 0) throw new Error(`${onderwerp}.txt: geen voorbeelden gevonden`);
  return uit;
}

/** Een voorbeeld; een onbekende sleutel is een fout in de test, geen lege tekst. */
export function protocolVoorbeeld(onderwerp: string, sleutel: string): string {
  const waarde = protocolVoorbeelden(onderwerp)[sleutel];
  if (waarde === undefined) throw new Error(`${onderwerp}.txt: geen voorbeeld met de sleutel ${sleutel}`);
  return waarde;
}
