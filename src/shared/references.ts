/** Een factuur- of bonnummer uit een bankomschrijving, bv. I-MOL-2026-00344 of 2026-0012; null als er geen is. */
export function referenceIn(text: string | null | undefined): string | null {
  return (text ?? '').match(/\b[A-Z][A-Z0-9]*(?:[-/][A-Z0-9]+)*\d{3,}\b/)?.[0] ?? null;
}
