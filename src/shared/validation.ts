export function normalizeIban(iban: string): string {
  return iban.replace(/\s+/g, '').toUpperCase();
}

/** IBAN-controle volgens ISO 13616 (mod 97). */
export function isValidIban(input: string): boolean {
  const iban = normalizeIban(input);
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(iban)) return false;
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  let remainder = 0;
  for (const ch of rearranged) {
    const value = /[A-Z]/.test(ch) ? String(ch.charCodeAt(0) - 55) : ch;
    for (const digit of value) remainder = (remainder * 10 + Number(digit)) % 97;
  }
  return remainder === 1;
}

export function formatIban(input: string): string {
  return normalizeIban(input).replace(/(.{4})/g, '$1 ').trim();
}

export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

/** NL btw-id: NL + 9 cijfers + B + 2 cijfers. Andere EU-landen: alleen grove vormcontrole. */
export function isValidVatNumber(input: string): boolean {
  const v = input.replace(/[\s.]/g, '').toUpperCase();
  if (v.startsWith('NL')) return /^NL\d{9}B\d{2}$/.test(v);
  return /^[A-Z]{2}[A-Z0-9+*]{2,13}$/.test(v);
}

export function isValidKvk(input: string): boolean {
  return /^\d{8}$/.test(input.replace(/\s/g, ''));
}

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}
