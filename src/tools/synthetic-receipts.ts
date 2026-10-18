/**
 * Synthetische benchmarkset (#8): Nederlandse bonnen en facturen met bekende juiste waarden.
 *
 * Geen echte documenten nodig (en dus geen privacy-risico): de generator maakt reproduceerbaar
 * (vaste seed) HTML-documenten in de stijl van bouwmarkten, tankstations, groothandels, telecom en
 * webshops, met variatie in opmaak, datumnotatie, btw-tarieven, kortingen en "slechte foto"-effecten
 * (scheef, wazig, weinig contrast, gekreukt, afgesneden rand). `render-benchmark.ts` maakt er
 * afbeeldingen van; `ocr-benchmark.ts` meet daarna een OCR-engine tegen de .json-bestanden.
 *
 * Beperking: synthetisch is niet echt. Handschrift, thermisch vervaagde bonnen en echte
 * kreukels zijn benaderd, niet nagebootst. Gebruik de uitkomst om engines te vergelijken, niet als
 * absolute nauwkeurigheid.
 */

export interface Truth {
  supplier: string;
  date: string;
  total: number;
  vat: { rate: number; amount: number }[];
  lines?: { description: string; amount: number }[];
}

export interface SyntheticDoc {
  id: string;
  kind: 'bon' | 'factuur';
  html: string;
  truth: Truth;
  /** gebruikte vervorming, voor de rapportage per soort */
  distortion: string;
}

/** Kleine deterministische random (mulberry32). */
function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (min: number, max: number) => min + Math.floor(next() * (max - min + 1)),
    pick: <T,>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)]!,
  };
}

interface Shop {
  name: string;
  address: string;
  kind: 'bon' | 'factuur';
  items: [string, number, number][]; // omschrijving, prijs incl. (centen), tarief
}

const SHOPS: Shop[] = [
  { name: 'GAMMA', address: 'Ravenswade 4, Nieuwegein', kind: 'bon', items: [['Gipsplaat 12,5mm', 895, 21], ['Voegmiddel 5kg', 1250, 21], ['Kwast set', 1299, 21], ['Afplaktape 50m', 549, 21], ['Muurverf wit 10L', 4995, 21], ['Schroeven 4x40 200st', 799, 21]] },
  { name: 'PRAXIS', address: 'Weg der Verenigde Naties 1, Utrecht', kind: 'bon', items: [['Kit transparant', 699, 21], ['Latex mat 5L', 3499, 21], ['Plamuurmes', 499, 21], ['Chips paprika', 189, 9], ['Koffie bonen 1kg', 1299, 9]] },
  { name: 'HORNBACH', address: 'Kolenmijnweg 1, Kerkrade', kind: 'bon', items: [['Zaagblad 48T', 3995, 21], ['Accuboormachine', 12900, 21], ['Waterpas 60cm', 1899, 21], ['Bouwemmer 12L', 399, 21]] },
  { name: 'Bouwmaat', address: 'Atoomweg 50, Utrecht', kind: 'bon', items: [['Knauf Goldband 25kg', 1295, 21], ['Hoekprofiel 3m', 245, 21], ['Stucloper 1x25m', 2450, 21], ['Primer 10L', 3895, 21]] },
  { name: 'Toolstation', address: 'Europalaan 12, Utrecht', kind: 'bon', items: [['Schroefbits set', 1499, 21], ['Werkhandschoenen', 399, 21], ['Kabelgoot 2m', 649, 21]] },
  { name: 'Shell', address: 'A12 Oudenrijn', kind: 'bon', items: [['Diesel 45,21 L', 8412, 21], ['Koffie', 350, 9], ['Broodje kaas', 425, 9]] },
  { name: 'TotalEnergies', address: 'Rijksweg 3, Houten', kind: 'bon', items: [['Euro 95 38,02 L', 7489, 21], ['Ruitenvloeistof', 599, 21]] },
  { name: 'Wasco', address: 'Postbus 55, Deventer', kind: 'factuur', items: [['Pers-T-stuk 15mm', 1210, 21], ['Koperbuis 15mm 5m', 2855, 21], ['Kogelkraan 1/2"', 1690, 21]] },
  { name: 'Technische Unie', address: 'Postbus 1150, Amstelveen', kind: 'factuur', items: [['Installatiekabel 3x2,5 100m', 11990, 21], ['Wandcontactdoos', 845, 21], ['Lasdoppen 100st', 1375, 21]] },
  { name: 'KPN B.V.', address: 'Postbus 30000, 2500 GA Den Haag', kind: 'factuur', items: [['Zakelijk Mobiel september', 3500, 21], ['Internet Zakelijk', 5495, 21]] },
  { name: 'Coolblue', address: 'Weena 664, Rotterdam', kind: 'factuur', items: [['Laptop 14 inch', 79900, 21], ['USB-C adapter', 2999, 21]] },
];

const MONTHS = ['januari', 'februari', 'maart', 'april', 'mei', 'juni', 'juli', 'augustus', 'september', 'oktober', 'november', 'december'];

const euro = (c: number) => (c / 100).toFixed(2).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, '.');
const round = (n: number) => Math.round(n);

const DISTORTIONS: [string, string][] = [
  ['schoon', ''],
  ['scheef', 'transform: rotate(-2.5deg);'],
  ['wazig', 'filter: blur(0.9px);'],
  ['weinig-contrast', 'filter: contrast(0.45) brightness(1.15);'],
  ['gekreukt', 'background: repeating-linear-gradient(115deg, #fff 0 40px, #eee 40px 55px, #fff 55px 110px);'],
  ['afgesneden', 'margin-left: -14px;'],
];

export function generateDocs(count: number, seed = 2026): SyntheticDoc[] {
  const r = rng(seed);
  const out: SyntheticDoc[] = [];
  for (let n = 0; n < count; n++) {
    const shop = r.pick(SHOPS);
    const day = r.int(1, 28);
    const month = r.int(1, 12);
    const date = `2026-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const dateText = r.pick([
      `${String(day).padStart(2, '0')}-${String(month).padStart(2, '0')}-2026`,
      `${String(day).padStart(2, '0')}/${String(month).padStart(2, '0')}/26`,
      `${day} ${MONTHS[month - 1]} 2026`,
    ]);
    // 1 tot 5 artikelen, soms een aantal, soms korting
    const lineCount = r.int(1, Math.min(5, shop.items.length));
    const chosen = [...shop.items].sort(() => r.next() - 0.5).slice(0, lineCount);
    const lines = chosen.map(([desc, price, rate]) => {
      const qty = r.next() < 0.3 ? r.int(2, 6) : 1;
      return { desc, qty, price, rate, amount: qty * price };
    });
    const discount = shop.kind === 'bon' && r.next() < 0.15 ? r.int(1, 5) * 100 : 0;
    if (discount && lines[0]!.amount > discount * 2) lines[0]!.amount -= discount;
    const total = lines.reduce((s, l) => s + l.amount, 0);
    const byRate = new Map<number, number>();
    for (const l of lines) byRate.set(l.rate, (byRate.get(l.rate) ?? 0) + l.amount);
    const vat = [...byRate.entries()].sort((a, b) => b[0] - a[0]).map(([rate, gross]) => {
      const amount = gross - round((gross * 100) / (100 + rate));
      return { rate, base: gross - amount, amount };
    });
    const [distortionName, distortionCss] = r.pick(DISTORTIONS);
    const invoiceNo = `${r.int(100000, 999999)}`;
    const html = shop.kind === 'bon' ? receiptHtml() : invoiceHtml();
    out.push({
      id: `synth-${String(n + 1).padStart(3, '0')}`,
      kind: shop.kind,
      html,
      distortion: distortionName,
      truth: {
        supplier: shop.name,
        date,
        total: total / 100,
        vat: vat.map((v) => ({ rate: v.rate, amount: v.amount / 100 })),
        lines: lines.map((l) => ({ description: l.desc, amount: l.amount / 100 })),
      },
    });

    function receiptHtml(): string {
      const font = r.pick(['"Courier New", monospace', '"DejaVu Sans Mono", monospace', 'Arial, sans-serif']);
      const rows = lines
        .map((l, i) => {
          const qtyLine = l.qty > 1 ? `<div>${l.qty} x ${euro(l.price)}</div>` : '';
          const disc = i === 0 && discount ? `<div class="row"><span>Korting</span><span>-${euro(discount)}</span></div>` : '';
          return `${qtyLine}<div class="row"><span>${l.desc}</span><span>${euro(l.qty * l.price)}</span></div>${disc}`;
        })
        .join('');
      const vatRows = vat.map((v) => `<div class="row"><span>BTW ${v.rate}% ${euro(v.base)}</span><span>${euro(v.amount)}</span></div>`).join('');
      return page(
        `width: 300px; font-family: ${font}; font-size: 14px; padding: 18px; ${distortionCss}`,
        `<div class="c"><b>${shop.name}</b><br>${shop.address}</div>
<div>Datum: ${dateText} ${String(r.int(8, 19)).padStart(2, '0')}:${String(r.int(0, 59)).padStart(2, '0')}</div>
<div>Bon nr ${invoiceNo}</div><hr>${rows}<hr>
<div class="row"><b>Totaal</b><b>${euro(total)}</b></div>
<div class="row"><span>PIN</span><span>${euro(total)}</span></div><hr>${vatRows}
<div class="c">Bedankt en tot ziens!</div>`,
      );
    }

    function invoiceHtml(): string {
      const due = r.pick([14, 30]);
      const rows = lines
        .map((l) => {
          const net = round((l.amount * 100) / (100 + l.rate));
          return `<tr><td>${l.desc}</td><td>${l.qty}</td><td>${euro(round(net / l.qty))}</td><td>${l.rate}%</td><td>${euro(net)}</td></tr>`;
        })
        .join('');
      const subtotal = vat.reduce((s, v) => s + v.base, 0);
      return page(
        `width: 680px; font-family: Arial, sans-serif; font-size: 13px; padding: 36px; ${distortionCss}`,
        `<div class="row"><div><b style="font-size:20px">${shop.name}</b><br>${shop.address}<br>KvK 12345678 · BTW NL001234567B01</div><div><b>FACTUUR</b></div></div>
<p>Factuurnummer: F${invoiceNo}<br>Factuurdatum: ${dateText}<br>Betalen binnen ${due} dagen</p>
<table><tr><th>Omschrijving</th><th>Aantal</th><th>Prijs</th><th>BTW</th><th>Bedrag</th></tr>${rows}</table>
<div class="row"><span>Subtotaal</span><span>${euro(subtotal)}</span></div>
${vat.map((v) => `<div class="row"><span>BTW ${v.rate}% over ${euro(v.base)}</span><span>${euro(v.amount)}</span></div>`).join('')}
<div class="row"><b>Totaal te betalen</b><b>${euro(total)}</b></div>
<p>IBAN NL91 ABNA 0417 1643 00 o.v.v. F${invoiceNo}</p>`,
      );
    }
  }
  return out;
}

function page(bodyCss: string, inner: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
html { background: #fff; }
body { margin: 0; color: #111; ${bodyCss} }
.row { display: flex; justify-content: space-between; gap: 12px; }
.c { text-align: center; margin: 6px 0; }
hr { border: 0; border-top: 1px dashed #666; }
table { width: 100%; border-collapse: collapse; margin: 12px 0; }
th, td { text-align: left; padding: 3px 4px; border-bottom: 1px solid #ccc; }
</style></head><body>${inner}</body></html>`;
}

/** Tekst zoals een perfecte OCR hem zou lezen (voor de parser-basislijn in de tests). */
export function htmlToLines(html: string): string[] {
  return html
    .replace(/<style[\s\S]*?<\/style>/g, '')
    .replace(/<\/(div|p|tr|hr)>|<br>|<hr>/g, '\n')
    .replace(/<\/t[dh]>|<\/span>/g, ' ')
    .replace(/<[^>]+>/g, '')
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}
