/**
 * Removes customer personal data from free text before it is logged or sent to the model (req 4.10).
 * The GraphQL queries never request customer fields; this covers free text such as order notes.
 */
const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const PHONE = /(?<![\w-])(?:\+?\d[\d\s().-]{7,}\d)(?![\w-])/g;
const STREET = /\b\d{1,5}[A-Za-z]?\s+(?:[A-Z][\w.'-]*\s){0,4}(?:street|st|road|rd|avenue|ave|boulevard|blvd|lane|ln|drive|dr|way|court|ct|place|pl|đường|phố|ngõ|hẻm)\b\.?/gi;
const POSTCODE = /\b[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\b/g; // UK-style

export function redactPII(text: string | null | undefined): string {
  if (!text) return "";
  return text
    .replace(EMAIL, "[email]")
    .replace(STREET, "[address]")
    .replace(PHONE, "[phone]")
    .replace(POSTCODE, "[postcode]");
}

export function containsPII(text: string): boolean {
  return [EMAIL, PHONE, STREET].some((r) => {
    r.lastIndex = 0;
    const hit = r.test(text);
    r.lastIndex = 0;
    return hit;
  });
}
