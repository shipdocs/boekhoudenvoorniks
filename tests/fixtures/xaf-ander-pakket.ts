export const IBAN = 'NL44RABO0123456789';

/** Zoals een ander pakket het maakt: geen RGS, openstaande posten in de openingsbalans, btw per regel. */
const tr = (nr: string, date: string, desc: string, lines: string) => `<transaction><nr>${nr}</nr><desc>${desc}</desc><trDt>${date}</trDt>${lines}</transaction>`;
const ln = (acc: string, amount: string, tp: 'D' | 'C', extra = '') => `<trLine><accID>${acc}</accID><amnt>${amount}</amnt><amntTp>${tp}</amntTp>${extra}</trLine>`;
export const OTHER_PACKAGE = `<?xml version="1.0" encoding="UTF-8"?>
<auditfile xmlns="http://www.auditfiles.nl/XAF/3.2">
  <header><fiscalYear>2026</fiscalYear><startDate>2026-01-01</startDate><endDate>2026-08-31</endDate><curCode>EUR</curCode><softwareDesc>SnelBoek</softwareDesc><softwareVersion>12</softwareVersion></header>
  <company>
    <companyIdent>12345678</companyIdent><companyName>Klusbedrijf Test</companyName>
    <customersSuppliers>
      <customerSupplier><custSupID>C1</custSupID><custSupName>Bakker Bouw</custSupName><commerceNr>87654321</commerceNr><custSupTp>C</custSupTp><streetAddress><streetname>Dorpsstraat</streetname><number>1</number><city>Utrecht</city><postalCode>3511 AA</postalCode><country>NL</country></streetAddress></customerSupplier>
      <customerSupplier><custSupID>S1</custSupID><custSupName>Gamma Utrecht</custSupName><custSupTp>S</custSupTp></customerSupplier>
    </customersSuppliers>
    <generalLedger>
      <ledgerAccount><accID>0100</accID><accDesc>Bestelbus</accDesc><accTp>B</accTp></ledgerAccount>
      <ledgerAccount><accID>0110</accID><accDesc>Afschrijving bestelbus</accDesc><accTp>B</accTp></ledgerAccount>
      <ledgerAccount><accID>0500</accID><accDesc>Eigen vermogen</accDesc><accTp>B</accTp></ledgerAccount>
      <ledgerAccount><accID>0900</accID><accDesc>Lening Rabobank</accDesc><accTp>B</accTp></ledgerAccount>
      <ledgerAccount><accID>1000</accID><accDesc>Kas</accDesc><accTp>B</accTp></ledgerAccount>
      <ledgerAccount><accID>1100</accID><accDesc>Rabobank zakelijk</accDesc><accTp>B</accTp></ledgerAccount>
      <ledgerAccount><accID>1300</accID><accDesc>Debiteuren</accDesc><accTp>B</accTp></ledgerAccount>
      <ledgerAccount><accID>1500</accID><accDesc>Te betalen omzetbelasting hoog</accDesc><accTp>B</accTp></ledgerAccount>
      <ledgerAccount><accID>1520</accID><accDesc>Voorbelasting</accDesc><accTp>B</accTp></ledgerAccount>
      <ledgerAccount><accID>1600</accID><accDesc>Crediteuren</accDesc><accTp>B</accTp></ledgerAccount>
      <ledgerAccount><accID>1998</accID><accDesc>Diversen</accDesc><accTp>B</accTp></ledgerAccount>
      <ledgerAccount><accID>4100</accID><accDesc>Brandstof</accDesc><accTp>P</accTp></ledgerAccount>
      <ledgerAccount><accID>4500</accID><accDesc>Afschrijvingskosten</accDesc><accTp>P</accTp></ledgerAccount>
      <ledgerAccount><accID>4600</accID><accDesc>Telefoonkosten</accDesc><accTp>P</accTp></ledgerAccount>
      <ledgerAccount><accID>7000</accID><accDesc>Inkoop materialen</accDesc><accTp>P</accTp></ledgerAccount>
      <ledgerAccount><accID>8000</accID><accDesc>Omzet 21%</accDesc><accTp>P</accTp></ledgerAccount>
    </generalLedger>
    <openingBalance>
      <opBalDate>2026-01-01</opBalDate><linesCount>10</linesCount><totalDebit>26510.00</totalDebit><totalCredit>26510.00</totalCredit>
      <obLine><nr>1</nr><accID>1000</accID><amnt>200.00</amnt><amntTp>D</amntTp></obLine>
      <obLine><nr>2</nr><accID>1100</accID><amnt>5000.00</amnt><amntTp>D</amntTp></obLine>
      <obLine><nr>3</nr><accID>1300</accID><amnt>1210.00</amnt><amntTp>D</amntTp></obLine>
      <obLine><nr>4</nr><accID>0100</accID><amnt>20000.00</amnt><amntTp>D</amntTp></obLine>
      <obLine><nr>5</nr><accID>1998</accID><amnt>100.00</amnt><amntTp>D</amntTp></obLine>
      <obLine><nr>6</nr><accID>0110</accID><amnt>8000.00</amnt><amntTp>C</amntTp></obLine>
      <obLine><nr>7</nr><accID>0900</accID><amnt>5000.00</amnt><amntTp>C</amntTp></obLine>
      <obLine><nr>8</nr><accID>1500</accID><amnt>500.00</amnt><amntTp>C</amntTp></obLine>
      <obLine><nr>9</nr><accID>0500</accID><amnt>13010.00</amnt><amntTp>C</amntTp></obLine>
      <obSubledgers><obSubledger><sbType>C</sbType><obSbLine><nr>1</nr><accID>1300</accID><custSupID>C1</custSupID><invRef>2025-050</invRef><invDt>2025-12-15</invDt><invDueDt>2025-12-29</invDueDt><amnt>1210.00</amnt><amntTp>D</amntTp></obSbLine></obSubledger></obSubledgers>
    </openingBalance>
    <transactions>
      <journal><jrnID>BNK</jrnID><desc>Bank</desc><jrnTp>B</jrnTp><bankAccNr>${IBAN}</bankAccNr>
        ${tr('1', '2026-01-20', 'Ontvangst Bakker', ln('1100', '1210.00', 'D') + ln('1300', '1210.00', 'C', '<custSupID>C1</custSupID><invRef>2025-050</invRef>'))}
        ${tr('2', '2026-01-25', 'Btw Q4', ln('1500', '500.00', 'D') + ln('1100', '500.00', 'C'))}
        ${tr('3', '2026-04-15', 'Ontvangst Bakker', ln('1100', '2420.00', 'D') + ln('1300', '2420.00', 'C', '<custSupID>C1</custSupID><invRef>2026-001</invRef>'))}
        ${tr('4', '2026-05-01', 'Tanken', ln('4100', '100.00', 'D', '<vat><vatID>1</vatID><vatPerc>21</vatPerc><vatAmnt>21.00</vatAmnt><vatAmntTp>D</vatAmntTp></vat>') + ln('1520', '21.00', 'D') + ln('1100', '121.00', 'C'))}
        ${tr('5', '2026-06-30', 'Telefoon', ln('4600', '50.00', 'D') + ln('1100', '50.00', 'C'))}
      </journal>
      <journal><jrnID>VRK</jrnID><desc>Verkoop</desc><jrnTp>S</jrnTp>
        ${tr('10', '2026-03-10', 'Factuur 2026-001', ln('1300', '2420.00', 'D', '<custSupID>C1</custSupID><invRef>2026-001</invRef>') + ln('8000', '2000.00', 'C', '<vat><vatID>1</vatID><vatPerc>21</vatPerc><vatAmnt>420.00</vatAmnt><vatAmntTp>C</vatAmntTp></vat>') + ln('1500', '420.00', 'C'))}
        ${tr('11', '2026-07-20', 'Factuur 2026-002', ln('1300', '1210.00', 'D', '<custSupID>C1</custSupID><invRef>2026-002</invRef>') + ln('8000', '1000.00', 'C', '<vat><vatID>1</vatID><vatPerc>21</vatPerc><vatAmnt>210.00</vatAmnt><vatAmntTp>C</vatAmntTp></vat>') + ln('1500', '210.00', 'C'))}
        ${tr('12', '2026-08-20', 'Factuur 2026-003', ln('1300', '605.00', 'D', '<custSupID>C1</custSupID><invRef>2026-003</invRef>') + ln('8000', '500.00', 'C') + ln('1500', '105.00', 'C'))}
      </journal>
      <journal><jrnID>INK</jrnID><desc>Inkoop</desc><jrnTp>P</jrnTp>
        ${tr('20', '2026-07-25', 'Gamma G-9', ln('7000', '300.00', 'D', '<vat><vatID>2</vatID><vatPerc>21</vatPerc><vatAmnt>63.00</vatAmnt><vatAmntTp>D</vatAmntTp></vat>') + ln('1520', '63.00', 'D') + ln('1600', '363.00', 'C', '<custSupID>S1</custSupID><invRef>G-9</invRef>'))}
      </journal>
      <journal><jrnID>MEM</jrnID><desc>Memoriaal</desc><jrnTp>G</jrnTp>
        ${tr('30', '2026-06-30', 'Afschrijving', ln('4500', '2000.00', 'D') + ln('0110', '2000.00', 'C'))}
      </journal>
    </transactions>
  </company>
</auditfile>`;

/** Dezelfde auditfile voor een ander jaar (voor de e2e-tests, die met het huidige jaar werken). */
export function otherPackage(year: number): string {
  return OTHER_PACKAGE.replace(/2026/g, String(year)).replace(/2025/g, String(year - 1));
}
