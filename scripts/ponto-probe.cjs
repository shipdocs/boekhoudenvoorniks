'use strict';

/**
 * Veilig Ponto-probe-script (WP2, #244).
 *
 * Leest credentials uitsluitend uit de omgeving (PONTO_CLIENT_ID en PONTO_CLIENT_SECRET) en
 * print een samenvatting zonder geheimen of volledige IBAN's: scope; rekeningnaam en laatste
 * vier IBAN-tekens; accountDetails- en transactiesynchronisatiemetadata apart;
 * saldo/verloop/availability; pagina-aantal en eerste/laatste datum in ontvangen volgorde;
 * null-velden en een geanonimiseerd fixturevoorbeeld. Het script trekt geen conclusie over
 * historische dekking uit de eerste transactiedatum.
 *
 *   npm run build:main && PONTO_CLIENT_ID=… PONTO_CLIENT_SECRET=… node scripts/ponto-probe.cjs
 *
 * De formatter-functies zijn puur en worden met nep-antwoorden getest in tests/ponto.test.ts;
 * er wordt nooit een echte API-call in tests gedaan.
 */

const fs = require('node:fs');
const path = require('node:path');

const FIXTURE_PATH = path.join(__dirname, '..', 'tests', 'fixtures', 'ponto-transaction.json');

/** Laatste vier tekens van een IBAN-vormige tekenreeks; alles anders → 'null'. */
function maskIban(iban) {
  if (typeof iban !== 'string') return 'null';
  const compact = iban.replace(/\s+/g, '').toUpperCase();
  return /^[A-Z]{2}\d{2}[A-Z0-9]{1,30}$/.test(compact) ? `…${compact.slice(-4)}` : 'null';
}

/** Maskt IBAN-achtige reeksen in vrije tekst (bijv. het fixturevoorbeeld). */
function maskIbansInText(text) {
  return String(text)
    .replace(/\b[A-Z]{2}\d{2}(?:\s+[A-Z0-9]{2,4}){3,8}\b/gi, (m) => `…${m.replace(/\s+/g, '').slice(-4).toUpperCase()}`)
    .replace(/\b[A-Z]{2}\d{2}[A-Z0-9]{1,30}\b/gi, (m) => `…${m.slice(-4).toUpperCase()}`);
}

/** Velden van de rekening die null (of onbruikbaar) zijn. */
function nullFields(account) {
  const out = [];
  for (const field of ['iban', 'holder', 'subtype', 'availability', 'balance', 'balanceAt', 'detailsSynchronizedAt', 'expiresAt']) {
    if (account[field] === null || account[field] === undefined) out.push(field);
  }
  return out;
}

function formatAccount(account) {
  const lines = [];
  lines.push(`Rekening: ${account.name} (IBAN ${maskIban(account.iban)})`);
  lines.push(`  Saldo: ${account.balance === null || account.balance === undefined ? 'null' : `${account.balance} cent`}${account.balanceAt ? `, per ${account.balanceAt}` : ''}`);
  lines.push(`  Verloop (expiresAt): ${account.expiresAt ?? 'null'}; details gesynchroniseerd: ${account.detailsSynchronizedAt ?? 'null'}`);
  lines.push(`  Availability: ${account.availability ?? 'null'}`);
  const empty = nullFields(account);
  lines.push(`  Null-velden: ${empty.length === 0 ? 'geen' : empty.join(', ')}`);
  return lines;
}

/** Synchronisatiemetadata, per subtype apart. */
function formatSync(label, sync) {
  if (sync === null) return [`${label}: niet beschikbaar`];
  if (Object.hasOwn(sync, 'synchronizedAt')) {
    return [`${label}: synchronizedAt=${sync.synchronizedAt ?? 'null'}`];
  }
  const errorSummary = sync.errors.length === 0 ? 'geen' : `${sync.errors.length} fout(en), inhoud niet getoond`;
  return [`${label}: id=${sync.id} status=${sync.status} subtype=${sync.subtype} errors=${errorSummary}`];
}

function formatRead(entry) {
  if (entry.read === null) return [`Transacties: mislukt (${entry.error ?? 'geen details'})`];
  const read = entry.read;
  const first = read.transactions.length > 0 ? read.transactions[0].date : 'null';
  const last = read.transactions.length > 0 ? read.transactions[read.transactions.length - 1].date : 'null';
  const lines = [];
  lines.push(`Transacties: ${read.transactions.length} regels op ${read.pages} pagina('s); volledig gelezen: ${read.complete ? 'ja' : 'nee'}; overgeslagen niet-EUR: ${read.skippedForeign}`);
  lines.push(`  Eerste datum (in ontvangen volgorde): ${first}; laatste datum (in ontvangen volgorde): ${last}`);
  lines.push(`  synchronizedAt: ${read.synchronizedAt ?? 'null'}`);
  const latest = read.latestSynchronization;
  const latestText = latest === null
    ? 'null'
    : `id=${latest.id} status=${latest.status} subtype=${latest.subtype} errors=${latest.errors.length === 0 ? 'geen' : `${latest.errors.length} fout(en), inhoud niet getoond`}`;
  lines.push(`  latestSynchronization: ${latestText}`);
  return lines;
}

/** Bouwt het volledige, veilige probe-rapport uit al opgehaalde (nep- of echte) antwoorden. */
function buildReport(input) {
  const lines = [];
  lines.push(`Scope: ${input.scope}`);
  for (const account of input.accounts) lines.push(...formatAccount(account));
  for (const sync of input.syncs) {
    lines.push(...formatSync('Synchronisatie accountDetails', sync.details));
    lines.push(...formatSync('Synchronisatie transacties', sync.transactions));
  }
  for (const entry of input.reads) lines.push(...formatRead(entry));
  lines.push('Let op: dit rapport trekt geen conclusie over historische dekking uit de eerste transactiedatum.');
  if (input.fixtureExample !== null && input.fixtureExample !== undefined) {
    lines.push('Voorbeeld (geanonimiseerd fixture):');
    for (const line of maskIbansInText(input.fixtureExample).split('\n')) lines.push(`  ${line}`);
  }
  return maskIbansInText(lines.join('\n'));
}

function fixtureExample() {
  try {
    return fs.readFileSync(FIXTURE_PATH, 'utf8');
  } catch {
    return null;
  }
}

async function main() {
  const clientId = process.env.PONTO_CLIENT_ID;
  const clientSecret = process.env.PONTO_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    console.error('Stel PONTO_CLIENT_ID en PONTO_CLIENT_SECRET in (uitsluitend via de omgeving).');
    return 1;
  }
  if (typeof fetch !== 'function') {
    console.error('Dit script heeft Node 22 nodig (met een ingebouwde fetch).');
    return 1;
  }
  let PontoClient;
  try {
    ({ PontoClient } = require(path.join(__dirname, '..', 'dist', 'main', 'integrations', 'ponto.js')));
  } catch {
    console.error('De Ponto-client is niet gebouwd; draai eerst: npm run build:main');
    return 1;
  }
  const client = new PontoClient((url, init) => fetch(url, init), { clientId, clientSecret });
  try {
    const { accounts, scope } = await client.accounts();
    const syncs = [];
    const reads = [];
    for (const account of accounts) {
      let read = null;
      let error = null;
      try {
        read = await client.transactions(account.id);
      } catch (readError) {
        error = readError instanceof Error && readError.name === 'PontoError' ? readError.message : 'onverwachte fout (geen details)';
      }
      reads.push({ read, error });
      syncs.push({
        details: { synchronizedAt: account.detailsSynchronizedAt },
        transactions: read === null ? null : read.latestSynchronization,
      });
    }
    console.log(buildReport({ scope, accounts, syncs, reads, fixtureExample: fixtureExample() }));
    return 0;
  } catch (error) {
    console.error(error instanceof Error && error.name === 'PontoError' ? error.message : 'Onverwachte fout (geen details).');
    return 1;
  }
}

if (require.main === module) {
  main().then((code) => { process.exitCode = code; });
}

module.exports = { maskIban, maskIbansInText, nullFields, formatAccount, formatSync, formatRead, buildReport };
