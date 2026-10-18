/**
 * Drie auditfiles van één bedrijf dat in 2024 begon: een per jaar, zoals je ze uit je vorige
 * programma haalt. 2024 zonder beginbalans (net gestart), 2025 en 2026 met de eindstand van het jaar
 * ervoor als beginbalans; 2026 loopt tot en met augustus.
 *
 * Eindstand 2025 (= startstand op 1 januari 2026): bank 8.500, bus 20.000 − 7.000, inventaris
 * 1.500 − 300, lening 10.000, btw 210 te betalen, factuur 2025-099 van 1.210 open, eigen vermogen 13.700.
 */
const tr = (nr: string, date: string, desc: string, lines: string) => `<transaction><nr>${nr}</nr><desc>${desc}</desc><trDt>${date}</trDt>${lines}</transaction>`;
const ln = (acc: string, amount: string, tp: 'D' | 'C', extra = '') => `<trLine><accID>${acc}</accID><amnt>${amount}</amnt><amntTp>${tp}</amntTp>${extra}</trLine>`;
const ob = (nr: number, acc: string, amount: string, tp: 'D' | 'C') => `<obLine><nr>${nr}</nr><accID>${acc}</accID><amnt>${amount}</amnt><amntTp>${tp}</amntTp></obLine>`;

const LEDGER = `
      <ledgerAccount><accID>0100</accID><accDesc>Bestelbus</accDesc><accTp>B</accTp></ledgerAccount>
      <ledgerAccount><accID>0110</accID><accDesc>Afschrijving bestelbus</accDesc><accTp>B</accTp></ledgerAccount>
      <ledgerAccount><accID>0200</accID><accDesc>Inventaris</accDesc><accTp>B</accTp></ledgerAccount>
      <ledgerAccount><accID>0210</accID><accDesc>Afschrijving inventaris</accDesc><accTp>B</accTp></ledgerAccount>
      <ledgerAccount><accID>0500</accID><accDesc>Eigen vermogen</accDesc><accTp>B</accTp></ledgerAccount>
      <ledgerAccount><accID>0900</accID><accDesc>Lening Rabobank</accDesc><accTp>B</accTp></ledgerAccount>
      <ledgerAccount><accID>1100</accID><accDesc>Rabobank zakelijk</accDesc><accTp>B</accTp></ledgerAccount>
      <ledgerAccount><accID>1300</accID><accDesc>Debiteuren</accDesc><accTp>B</accTp></ledgerAccount>
      <ledgerAccount><accID>1500</accID><accDesc>Te betalen omzetbelasting hoog</accDesc><accTp>B</accTp></ledgerAccount>
      <ledgerAccount><accID>4500</accID><accDesc>Afschrijvingskosten</accDesc><accTp>P</accTp></ledgerAccount>
      <ledgerAccount><accID>8000</accID><accDesc>Omzet 21%</accDesc><accTp>P</accTp></ledgerAccount>`;

const file = (year: number, end: string, opening: string, transactions: string) => `<?xml version="1.0" encoding="UTF-8"?>
<auditfile xmlns="http://www.auditfiles.nl/XAF/3.2">
  <header><fiscalYear>${year}</fiscalYear><startDate>${year}-01-01</startDate><endDate>${end}</endDate><curCode>EUR</curCode><softwareDesc>SnelBoek</softwareDesc><softwareVersion>12</softwareVersion></header>
  <company>
    <companyIdent>12345678</companyIdent><companyName>Klusbedrijf Test</companyName>
    <customersSuppliers>
      <customerSupplier><custSupID>C1</custSupID><custSupName>Bakker Bouw</custSupName><custSupTp>C</custSupTp></customerSupplier>
    </customersSuppliers>
    <generalLedger>${LEDGER}
    </generalLedger>
    ${opening}
    <transactions>
      <journal><jrnID>MEM</jrnID><desc>Memoriaal</desc><jrnTp>G</jrnTp>
        ${transactions}
      </journal>
    </transactions>
  </company>
</auditfile>`;

export const XAF_2024 = file(
  2024,
  '2024-12-31',
  '',
  tr('1', '2024-01-05', 'Inbreng', ln('1100', '10000.00', 'D') + ln('0500', '10000.00', 'C')) +
    tr('2', '2024-03-15', 'Bus gekocht', ln('0100', '20000.00', 'D') + ln('1100', '10000.00', 'C') + ln('0900', '10000.00', 'C')) +
    tr('3', '2024-06-10', 'Factuur 2024-001', ln('1300', '12100.00', 'D', '<custSupID>C1</custSupID><invRef>2024-001</invRef>') + ln('8000', '10000.00', 'C') + ln('1500', '2100.00', 'C')) +
    tr('4', '2024-07-10', 'Ontvangst 2024-001', ln('1100', '12100.00', 'D') + ln('1300', '12100.00', 'C', '<custSupID>C1</custSupID><invRef>2024-001</invRef>')) +
    tr('5', '2024-12-31', 'Afschrijving', ln('4500', '3000.00', 'D') + ln('0110', '3000.00', 'C')),
);

export const XAF_2025 = file(
  2025,
  '2025-12-31',
  `<openingBalance><opBalDate>2025-01-01</opBalDate>
      ${ob(1, '1100', '12100.00', 'D')}${ob(2, '0100', '20000.00', 'D')}${ob(3, '0110', '3000.00', 'C')}${ob(4, '0900', '10000.00', 'C')}${ob(5, '1500', '2100.00', 'C')}${ob(6, '0500', '17000.00', 'C')}
    </openingBalance>`,
  tr('1', '2025-01-20', 'Btw betaald', ln('1500', '2100.00', 'D') + ln('1100', '2100.00', 'C')) +
    tr('2', '2025-06-01', 'Steigermateriaal', ln('0200', '1500.00', 'D') + ln('1100', '1500.00', 'C')) +
    tr('3', '2025-11-20', 'Factuur 2025-099', ln('1300', '1210.00', 'D', '<custSupID>C1</custSupID><invRef>2025-099</invRef>') + ln('8000', '1000.00', 'C') + ln('1500', '210.00', 'C')) +
    tr('4', '2025-12-31', 'Afschrijving', ln('4500', '4300.00', 'D') + ln('0110', '4000.00', 'C') + ln('0210', '300.00', 'C')),
);

export const XAF_2026 = file(
  2026,
  '2026-08-31',
  `<openingBalance><opBalDate>2026-01-01</opBalDate>
      ${ob(1, '1100', '8500.00', 'D')}${ob(2, '0100', '20000.00', 'D')}${ob(3, '0110', '7000.00', 'C')}${ob(4, '0200', '1500.00', 'D')}${ob(5, '0210', '300.00', 'C')}${ob(6, '0900', '10000.00', 'C')}${ob(7, '1500', '210.00', 'C')}${ob(8, '1300', '1210.00', 'D')}${ob(9, '0500', '13700.00', 'C')}
      <obSubledgers><obSubledger><sbType>C</sbType><obSbLine><nr>1</nr><accID>1300</accID><custSupID>C1</custSupID><invRef>2025-099</invRef><invDt>2025-11-20</invDt><amnt>1210.00</amnt><amntTp>D</amntTp></obSbLine></obSubledger></obSubledgers>
    </openingBalance>`,
  tr('1', '2026-02-10', 'Ontvangst 2025-099', ln('1100', '1210.00', 'D') + ln('1300', '1210.00', 'C', '<custSupID>C1</custSupID><invRef>2025-099</invRef>')),
);

/** Dezelfde drie bestanden, verschoven zodat het jongste in `year` valt (voor de e2e-tests). */
export function xafJaren(year: number): [string, string, string] {
  const shift = (xml: string) => xml.replace(/\b(2024|2025|2026)(?=-|\b)/g, (y) => String(Number(y) + year - 2026));
  return [shift(XAF_2024), shift(XAF_2025), shift(XAF_2026)];
}
