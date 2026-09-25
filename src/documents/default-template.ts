/** Standaard A4-layout voor facturen en offertes. Kleuren/lettertype/teksten komen uit het template. */
export const DEFAULT_HTML_TEMPLATE = `<!doctype html>
<html lang="nl">
<head>
<meta charset="utf-8">
<title>{{doc.title}} {{doc.number}}</title>
<style>
  @page { size: A4; margin: 18mm 16mm 20mm 16mm; }
  * { box-sizing: border-box; }
  body { font-family: {{{style.font}}}; color: {{style.text}}; font-size: 10pt; line-height: 1.45; margin: 0; }
  .top { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 28px; }
  .logo img { max-height: 70px; max-width: 220px; }
  .company { text-align: right; font-size: 9pt; color: {{style.muted}}; }
  .company strong { color: {{style.text}}; font-size: 11pt; }
  h1 { color: {{style.primary}}; font-size: 22pt; margin: 0 0 18px; font-weight: 600; letter-spacing: .5px; }
  .parties { display: flex; justify-content: space-between; margin-bottom: 24px; }
  .meta td { padding: 1px 0 1px 16px; }
  .meta td:first-child { color: {{style.muted}}; padding-left: 0; }
  .intro { margin-bottom: 16px; }
  table.lines { width: 100%; border-collapse: collapse; margin-bottom: 12px; }
  table.lines th { text-align: left; font-weight: 600; border-bottom: 2px solid {{style.primary}}; padding: 6px 4px; font-size: 9pt; }
  table.lines td { padding: 6px 4px; border-bottom: 1px solid #e5e5e5; vertical-align: top; }
  .num { text-align: right; white-space: nowrap; }
  .totals { margin-left: auto; width: 45%; border-collapse: collapse; }
  .totals td { padding: 3px 4px; }
  .totals tr.grand td { border-top: 2px solid {{style.primary}}; font-weight: 700; font-size: 11pt; padding-top: 6px; }
  .blocks { margin-top: 28px; display: grid; gap: 12px; }
  .block h3 { font-size: 9pt; text-transform: uppercase; letter-spacing: .6px; color: {{style.primary}}; margin: 0 0 4px; }
  .notice { margin-top: 16px; padding: 8px 10px; background: {{style.accentBg}}; border-left: 3px solid {{style.primary}}; }
  @media screen { body { padding: 28px 32px 60px; } footer { position: static !important; margin-top: 30px; } }
  footer { position: fixed; bottom: 0; left: 0; right: 0; font-size: 8pt; color: {{style.muted}}; text-align: center; border-top: 1px solid #e5e5e5; padding-top: 6px; }
</style>
</head>
<body>
  <div class="top">
    <div class="logo">{{#style.logo}}<img src="{{style.logo}}" alt="">{{/style.logo}}{{^style.logo}}<strong style="font-size:16pt;color:{{style.primary}}">{{company.name}}</strong>{{/style.logo}}</div>
    <div class="company">
      <strong>{{company.name}}</strong><br>
      {{company.address}}<br>{{company.postcode}} {{company.city}}<br>
      {{#company.phone}}{{company.phone}}<br>{{/company.phone}}
      {{#company.email}}{{company.email}}<br>{{/company.email}}
      {{#company.website}}{{company.website}}{{/company.website}}
    </div>
  </div>

  <h1>{{doc.title}}</h1>

  <div class="parties">
    <div>
      <strong>{{customer.name}}</strong><br>
      {{#customer.contact_name}}t.a.v. {{customer.contact_name}}<br>{{/customer.contact_name}}
      {{customer.address}}<br>{{customer.postcode}} {{customer.city}}
      {{#customer.vat_number}}<br>BTW-nr: {{customer.vat_number}}{{/customer.vat_number}}
    </div>
    <table class="meta">
      <tr><td>{{doc.numberLabel}}</td><td>{{doc.number}}</td></tr>
      <tr><td>Datum</td><td>{{doc.date}}</td></tr>
      {{#doc.dueDate}}<tr><td>Vervaldatum</td><td>{{doc.dueDate}}</td></tr>{{/doc.dueDate}}
      {{#doc.validUntil}}<tr><td>Geldig tot</td><td>{{doc.validUntil}}</td></tr>{{/doc.validUntil}}
      {{#doc.reference}}<tr><td>Referentie</td><td>{{doc.reference}}</td></tr>{{/doc.reference}}
      {{#doc.creditOf}}<tr><td>Creditering van</td><td>{{doc.creditOf}}</td></tr>{{/doc.creditOf}}
    </table>
  </div>

  {{#doc.intro}}<div class="intro">{{{doc.introHtml}}}</div>{{/doc.intro}}

  <table class="lines">
    <thead><tr><th>Omschrijving</th><th class="num">Aantal</th><th class="num">Prijs</th><th class="num">BTW</th><th class="num">Bedrag</th></tr></thead>
    <tbody>
      {{#lines}}<tr><td>{{description}}</td><td class="num">{{quantity}} {{unit}}</td><td class="num">{{unitPrice}}</td><td class="num">{{vatLabel}}</td><td class="num">{{net}}</td></tr>{{/lines}}
    </tbody>
  </table>

  <table class="totals">
    <tr><td>Subtotaal</td><td class="num">{{totals.subtotal}}</td></tr>
    {{#totals.groups}}<tr><td>{{label}} over {{net}}</td><td class="num">{{vat}}</td></tr>{{/totals.groups}}
    <tr class="grand"><td>Totaal</td><td class="num">{{totals.total}}</td></tr>
  </table>

  {{#doc.verlegd}}<div class="notice">BTW verlegd{{#customer.vat_number}} — btw-nummer afnemer: {{customer.vat_number}}{{/customer.vat_number}}</div>{{/doc.verlegd}}
  {{#doc.kor}}<div class="notice">Vrijgesteld van BTW op grond van de kleineondernemersregeling.</div>{{/doc.kor}}
  {{#doc.isInvoice}}{{^doc.isCredit}}<div class="notice">Gelieve {{totals.total}} vóór {{doc.dueDate}} over te maken op {{company.iban}} t.n.v. {{company.name}} o.v.v. {{doc.number}}.</div>{{/doc.isCredit}}{{/doc.isInvoice}}

  {{#doc.notes}}<div class="intro" style="margin-top:16px">{{{doc.notesHtml}}}</div>{{/doc.notes}}

  <div class="blocks">
    {{#blocks}}<div class="block"><h3>{{title}}</h3><div>{{{html}}}</div></div>{{/blocks}}
  </div>

  <footer>{{company.name}}{{#company.kvkNumber}} · KvK {{company.kvkNumber}}{{/company.kvkNumber}}{{#company.vatNumber}} · BTW {{company.vatNumber}}{{/company.vatNumber}}{{#company.iban}} · IBAN {{company.iban}}{{/company.iban}}</footer>
</body>
</html>`;
