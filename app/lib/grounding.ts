/**
 * Req 4.4: every number in an answer must come from a tool result.
 * Deterministic check: collect all numbers that appear in tool results, then verify each figure
 * and each number written in the answer text.
 */

export interface Figure {
  label: string;
  value: number;
  unit: string;
  period: string;
  sourceStep: number;
}

export function numbersIn(value: unknown, out = new Set<number>()): Set<number> {
  if (typeof value === "number" && Number.isFinite(value)) out.add(round(value));
  else if (typeof value === "string") {
    const n = Number(value);
    if (value.trim() !== "" && Number.isFinite(n)) out.add(round(n));
  } else if (Array.isArray(value)) value.forEach((v) => numbersIn(v, out));
  else if (value && typeof value === "object") Object.values(value).forEach((v) => numbersIn(v, out));
  return out;
}

const round = (n: number) => Math.round(n * 100) / 100;

/** Numbers written in prose, e.g. "1,234.50", "12%", "$3.2". Years and small ordinals are ignored. */
export function numbersInText(text: string): number[] {
  return [...text.matchAll(/(?<![\w.])\d{1,3}(?:,\d{3})+(?:\.\d+)?|(?<![\w.])\d+(?:\.\d+)?/g)]
    .map((m) => Number(m[0].replace(/,/g, "")))
    .filter((n) => !(Number.isInteger(n) && n >= 1900 && n <= 2100)) // years in periods
    .filter((n) => n > 8 || !Number.isInteger(n)); // "step 3", "top 5" etc.
}

export function checkGrounding(
  answerText: string,
  figures: Figure[],
  stepData: Map<number, unknown>,
): string[] {
  const warnings: string[] = [];
  const all = new Set<number>();
  for (const d of stepData.values()) numbersIn(d, all);

  for (const f of figures) {
    const src = stepData.get(f.sourceStep);
    if (src === undefined) warnings.push(`“${f.label}” cites step ${f.sourceStep}, which does not exist.`);
    else if (!numbersIn(src).has(round(f.value))) warnings.push(`“${f.label}” (${f.value}) is not in the data of step ${f.sourceStep}.`);
    if (!f.period.trim()) warnings.push(`“${f.label}” has no time period.`);
  }
  const figureValues = new Set(figures.map((f) => round(f.value)));
  for (const n of numbersInText(answerText)) {
    const r = round(n);
    if (!all.has(r) && !figureValues.has(r)) warnings.push(`The number ${n} in the answer was not found in any tool result.`);
  }
  return warnings;
}
