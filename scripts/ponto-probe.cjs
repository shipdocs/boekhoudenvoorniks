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
  return String(text).replace(/\b[A-Z]{2}\d{2}[A-Z0-9]{1,30}\b/g, (m) => `…${m.slice(-4)}`);
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
  const errors = sync.errors.length === 0 ? 'geen' : sync.errors.join(' | ');
  return [`${label}: id=${sync.id} status=${sync.status} subtype=${sync.subtype} errors=${errors}`];
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
    : `id=${latest.id} status=${latest.status} subtype=${latest.subtype} errors=${latest.errors.length === 0 ? 'geen' : latest.errors.join(' | ')}`;
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
  return lines.join('\n');
}

/** Pollt een synchronisatie tot 'success' of 'error'; null als die binnen de wachttijd niet komt. */
async function pollSynchronization(client, id, { attempts = 15, delayMs = 2000 } = {}) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const sync = await client.synchronization(id);
    if (sync.status === 'success' || sync.status === 'error') return sync;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return null;
}

/** Start één synchronisatie en wacht op het eindresultaat; fouten blijven veilig en compact. */
async function syncMetadata(client, accountId, subtype, customerIp) {
  try {
    const started = await client.startSynchronization(accountId, subtype, customerIp);
    const finished = await pollSynchronization(client, started.id);
    return {
      id: started.id,
      subtype,
      status: finished === null ? 'niet voltooid binnen de wachttijd' : finished.status,
      errors: finished === null ? [] : finished.errors,
    };
  } catch (error) {
    return { id: null, subtype, status: 'mislukt', errors: [error instanceof Error && error.name === 'PontoError' ? error.message : 'onverwachte fout (geen details)'] };
  }
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
  const customerIp = process.env.PONTO_CUSTOMER_IP || '127.0.0.1';
  const client = new PontoClient((url, init) => fetch(url, init), { clientId, clientSecret });
  try {
    const { accounts, scope } = await client.accounts();
    const syncs = [];
    const reads = [];
    for (const account of accounts) {
      syncs.push({
        details: await syncMetadata(client, account.id, 'accountDetails', customerIp),
        transactions: await syncMetadata(client, account.id, 'accountTransactions', customerIp),
      });
      let read = null;
      let error = null;
      try {
        read = await client.transactions(account.id);
      } catch (readError) {
        error = readError instanceof Error && readError.name === 'PontoError' ? readError.message : 'onverwachte fout (geen details)';
      }
      reads.push({ read, error });
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
