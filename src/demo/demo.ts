import type { Services } from '../services';
import { tx } from '../db/database';
import { addDays, today, type IsoDate } from '../shared/dates';
import type { NormalizedTransaction } from '../import/types';
import { ONBOARDING_STEPS, markSeen } from '../shared/onboarding';

export const DEMO_COMPANY = 'Demo Stukadoorsbedrijf';

/**
 * Vult een lege administratie met een herkenbare, samenhangende demo: klanten, offertes, facturen
 * (betaald, open en vervallen), een klus, bonnetjes en een bankafschrift. Alles loopt via de gewone
 * services, dus de boekingen kloppen precies zoals bij echt gebruik. Datums liggen rond `asOf`.
 *
 * Alleen voor een lege database: `demoMode` zorgt dat er niets naar buiten gaat (geen e-mail) en dat
 * de app een balk "Je bekijkt de demo" toont met een knop om schoon te beginnen.
 * Alles in één transactie: gaat er iets mis, dan blijft de administratie leeg (en kan het opnieuw).
 */
export function seedDemo(s: Services, asOf: IsoDate = today()): void {
  tx(s.db, () => fillDemo(s, asOf));
}

function fillDemo(s: Services, asOf: IsoDate): void {
  const d = (days: number) => addDays(asOf, -days);
  const hasData = s.db.prepare('SELECT (SELECT COUNT(*) FROM invoices) + (SELECT COUNT(*) FROM bank_transactions) + (SELECT COUNT(*) FROM relations) AS n').get() as { n: number };
  if (hasData.n > 0) throw new Error('De demo kan alleen in een lege administratie');

  const iban = 'NL91ABNA0417164300';
  const settings = s.settings.update({
    demoMode: true,
    onboardingDone: true,
    company: {
      name: DEMO_COMPANY,
      address: 'Voorbeeldstraat 1',
      postcode: '1234 AB',
      city: 'Utrecht',
      country: 'NL',
      email: 'demo@example.nl',
      phone: '030 123 45 67',
      website: '',
      kvkNumber: '12345678',
      vatNumber: 'NL123456789B01',
      iban,
      bic: 'ABNANL2A',
    },
    profile: { trade: 'stukadoor', worksAlone: true, hasBusinessAccount: true, firstName: 'Sam' },
    carUse: 'zakelijk',
    phoneInternetBusinessPct: 75,
    homeWorkspace: 'thuis',
    startYear: Number(asOf.slice(0, 4)) - 1,
    startersaftrekUsed: { count: 1, asOfYear: Number(asOf.slice(0, 4)) },
    smtp: { host: '', port: 587, secure: false, user: '', fromName: DEMO_COMPANY, fromEmail: 'demo@example.nl', bcc: '', replyTo: '' },
  });
  s.settings.update({ onboardingSteps: markSeen(settings, ONBOARDING_STEPS.map((st) => st.id)) });

  const bankAccount = s.bank.ensureDefaultAccount(iban);
  s.bank.updateAccount(bankAccount.id, { iban });
  s.bank.setOpeningBalance(bankAccount.id, 2_500_00, d(90));

  const jansen = s.relations.create({ name: 'Familie Jansen', email: 'jansen@example.nl', address: 'Dorpsstraat 5', postcode: '3511 AA', city: 'Utrecht', iban: 'NL44RABO0123456789' });
  const devries = s.relations.create({ name: 'Bouwbedrijf De Vries BV', email: 'info@devries.example', address: 'Industrieweg 9', postcode: '3500 BB', city: 'Utrecht', vat_number: 'NL999999999B01', kvk_number: '87654321', iban: 'NL02ABNA0123456789', payment_term_days: 30 });
  const cafe = s.relations.create({ name: 'Café De Hoek', contact_name: 'Anouk', email: 'anouk@dehoek.example', address: 'Marktplein 12', postcode: '3512 CD', city: 'Utrecht' });

  const stuc = (m2: number) => ({ description: 'Stucwerk wanden (sausklaar)', quantity: m2, unit: 'm²', unitPrice: 18_50, vatCode: 'hoog' as const });
  const voorrij = { description: 'Voorrijkosten', quantity: 1, unit: null, unitPrice: 35_00, vatCode: 'hoog' as const };

  // betaald, betaald, vervallen, open en een concept
  const inv1 = s.invoices.finalize(s.invoices.createDraft({ relationId: jansen.id, invoiceDate: d(75), reference: 'Woonkamer', lines: [stuc(42.5), voorrij] }).id);
  const inv2 = s.invoices.finalize(
    s.invoices.createDraft({
      relationId: devries.id,
      invoiceDate: d(40),
      reference: 'Nieuwbouw Parkzicht, blok B',
      lines: [
        { description: 'Wanden stucen', quantity: 120, unit: 'm²', unitPrice: 16_00, vatCode: 'hoog' },
        { description: 'Hoekprofielen plaatsen', quantity: 36, unit: 'm', unitPrice: 4_50, vatCode: 'hoog' },
      ],
    }).id,
  );
  s.invoices.finalize(s.invoices.createDraft({ relationId: cafe.id, invoiceDate: d(35), dueDate: d(21), reference: 'Plafond toiletten', lines: [{ description: 'Plafond spuiten', quantity: 18, unit: 'm²', unitPrice: 12_50, vatCode: 'hoog' }, voorrij] }).id);
  s.invoices.finalize(s.invoices.createDraft({ relationId: jansen.id, invoiceDate: d(6), reference: 'Slaapkamer boven', lines: [stuc(28), voorrij] }).id);
  s.invoices.createDraft({ relationId: devries.id, invoiceDate: d(1), reference: 'Nieuwbouw Parkzicht, blok C', lines: [{ description: 'Wanden stucen', quantity: 80, unit: 'm²', unitPrice: 16_00, vatCode: 'hoog' }] });

  // offerte die geaccepteerd is en nu een klus is, plus een verstuurde offerte
  const q1 = s.quotes.create({ relationId: cafe.id, quoteDate: d(12), reference: 'Keuken café', lines: [{ description: 'Keukenwand tegelklaar maken', quantity: 22, unit: 'm²', unitPrice: 21_00, vatCode: 'hoog' }, voorrij] });
  s.quotes.markSent(q1.id);
  const job = s.jobs.acceptQuote(q1.id);
  s.jobs.update(job.id, { startDate: d(3) });
  s.jobs.setStatus(job.id, 'bezig');
  s.jobs.addWorkItem(job.id, { date: d(2), description: 'Extra: scheur in plafond herstellen', quantity: 2, unit: 'uur', unitPrice: 55_00, vatCode: 'hoog' });
  const q2 = s.quotes.create({ relationId: jansen.id, quoteDate: d(4), reference: 'Badkamer', lines: [{ description: 'Badkamer wanden en plafond', quantity: 26, unit: 'm²', unitPrice: 22_00, vatCode: 'hoog' }] });
  s.quotes.markSent(q2.id);

  // bonnetjes: twee via de bank (worden gekoppeld), één contant
  s.quick.recordExpense({ date: d(50), supplierName: 'Gamma Utrecht', description: 'Stucloper, gips en hoekprofielen', categoryKey: 'materiaal', grossAmount: 186_34, vatCode: 'hoog', paidWith: 'bank', jobId: null });
  s.quick.recordExpense({ date: d(20), supplierName: 'Shell Utrecht', description: 'Tanken bus', categoryKey: 'brandstof', grossAmount: 78_50, vatCode: 'hoog', paidWith: 'bank' });
  // bedrijfsmiddel (afschrijving + investeringsaftrek), een zakelijke lunch en uren buiten de werkbon
  s.quick.recordExpense({ date: d(80), supplierName: 'Bouwmaat', description: 'Steigerset en rolsteiger', categoryKey: 'investering', grossAmount: 4235_00, vatCode: 'hoog', paidWith: 'prive' });
  s.quick.recordExpense({ date: d(15), supplierName: 'Café De Hoek', description: 'Lunch met aannemer De Vries', categoryKey: 'representatie', grossAmount: 64_50, vatCode: 'geen', paidWith: 'kas' });
  s.hours.add({ date: d(7), hours: 6, description: 'Offertes en administratie' });
  s.quick.recordExpense({ date: d(30), supplierName: 'Werkkleding Direct', description: 'Werkbroek en schoenen', categoryKey: 'werkkleding', grossAmount: 124_95, vatCode: 'hoog', paidWith: 'kas' });

  const t = (days: number, amount: number, counterName: string, description: string, counterIban: string | null = null): NormalizedTransaction => ({
    date: d(days),
    amount,
    counterName,
    counterIban,
    description,
    ownIban: iban,
    bankId: `demo-${days}-${amount}`,
  });
  s.bank.import(
    {
      source: 'csv',
      warnings: [],
      transactions: [
        t(62, inv1.totals.total, jansen.name, `Factuur ${inv1.number}`, jansen.iban),
        t(49, -186_34, 'Gamma Utrecht', 'Betaalautomaat Gamma Utrecht'),
        t(45, -35_00, 'KPN B.V.', 'Mobiel abonnement', 'NL56INGB0000012345'),
        t(33, -150_00, 'S. de Boer', 'Naar spaarrekening privé', 'NL69INGB0123456789'),
        t(25, inv2.totals.total, devries.name, `Betaling ${inv2.number}`, devries.iban),
        t(19, -78_50, 'Shell Utrecht', 'Betaalautomaat Shell'),
        t(10, -12_50, 'ABN AMRO', 'Kosten zakelijk betalen'),
      ],
    },
    { filename: 'demo-afschrift.csv', bankAccountId: bankAccount.id },
  );
  s.inbox.autoProcess();
}
