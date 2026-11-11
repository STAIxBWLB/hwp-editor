/** A unit control keeps source text so exponent and leading-dot forms cannot reach the queue. */
export function isPlainDecimal(value: string): boolean {
  const text = value.trim();
  return /^\d+(\.\d+)?$/.test(text) && Number.isFinite(Number(text));
}
