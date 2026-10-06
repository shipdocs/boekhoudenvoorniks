/**
 * Minimale, afhankelijkheidsvrije Mustache-subset voor factuur/offerte-templates.
 *   {{pad.naar.waarde}}    HTML-escaped
 *   {{{pad}}}              onge-escaped (alleen voor door de app zelf opgebouwde HTML)
 *   {{#sectie}}…{{/sectie}} lijst herhalen of tonen als waarde truthy is
 *   {{^sectie}}…{{/sectie}} tonen als waarde falsy/leeg is
 */
export function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Platte tekst → veilige HTML met regeleinden. */
export function textToHtml(text: string | null | undefined): string {
  return escapeHtml(text ?? '').replace(/\r?\n/g, '<br>');
}

type Ctx = Record<string, unknown>;

function lookup(stack: unknown[], path: string): unknown {
  if (path === '.') return stack[stack.length - 1];
  const parts = path.split('.');
  for (let i = stack.length - 1; i >= 0; i--) {
    const frame = stack[i];
    if (frame !== null && typeof frame === 'object' && parts[0]! in (frame as Ctx)) {
      let value: unknown = frame;
      for (const p of parts) {
        if (value === null || typeof value !== 'object') return undefined;
        value = (value as Ctx)[p];
      }
      return value;
    }
  }
  return undefined;
}

const TAG = /\{\{\{\s*([\w.]+)\s*\}\}\}|\{\{\s*([#^/]?)\s*([\w.]+)\s*\}\}/g;

export function renderTemplate(template: string, data: Ctx): string {
  return renderSection(template, [data]);
}

function renderSection(template: string, stack: unknown[]): string {
  let out = '';
  let pos = 0;
  TAG.lastIndex = 0;
  const re = new RegExp(TAG.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(template))) {
    out += template.slice(pos, m.index);
    pos = re.lastIndex;
    if (m[1]) {
      out += String(lookup(stack, m[1]) ?? '');
      continue;
    }
    const kind = m[2];
    const name = m[3]!;
    if (kind === '') {
      out += escapeHtml(lookup(stack, name));
      continue;
    }
    if (kind === '/') throw new Error(`Template: onverwachte sluittag {{/${name}}}`);
    // zoek de bijbehorende sluittag, rekening houdend met nesting van dezelfde naam
    const openRe = new RegExp(`\\{\\{\\s*[#^]\\s*${name.replace(/\./g, '\\.')}\\s*\\}\\}|\\{\\{\\s*/\\s*${name.replace(/\./g, '\\.')}\\s*\\}\\}`, 'g');
    openRe.lastIndex = pos;
    let depth = 1;
    let inner = '';
    let close: RegExpExecArray | null;
    while ((close = openRe.exec(template))) {
      if (close[0].includes('/')) depth--;
      else depth++;
      if (depth === 0) {
        inner = template.slice(pos, close.index);
        pos = openRe.lastIndex;
        break;
      }
    }
    if (depth !== 0) throw new Error(`Template: sluittag {{/${name}}} ontbreekt`);
    re.lastIndex = pos;
    const value = lookup(stack, name);
    const truthy = Array.isArray(value) ? value.length > 0 : Boolean(value);
    if (kind === '^') {
      if (!truthy) out += renderSection(inner, stack);
    } else if (Array.isArray(value)) {
      for (const item of value) out += renderSection(inner, [...stack, item]);
    } else if (truthy) {
      out += renderSection(inner, typeof value === 'object' ? [...stack, value] : stack);
    }
  }
  return out + template.slice(pos);
}
