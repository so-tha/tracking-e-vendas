const VALID_CURRENCIES = new Set(Intl.supportedValuesOf("currency"));

export function isValidCurrency(code: string): boolean {
  return /^[A-Z]{3}$/.test(code) && VALID_CURRENCIES.has(code);
}

/** Casas decimais da moeda (USD 2, JPY 0, KWD 3), segundo os dados do runtime (CLDR). */
export function currencyExponent(code: string): number {
  if (!isValidCurrency(code)) throw new RangeError(`moeda inválida: ${code}`);
  return new Intl.NumberFormat("en", { style: "currency", currency: code }).resolvedOptions()
    .maximumFractionDigits as number;
}

/** 25500n USD -> "255.00"; 5n USD -> "0.05"; 1234n KWD -> "1.234"; 100n JPY -> "100". */
export function minorUnitsToDecimalString(minor: bigint, currency: string): string {
  const exponent = currencyExponent(currency);
  const negative = minor < 0n;
  const digits = (negative ? -minor : minor).toString();
  const sign = negative ? "-" : "";
  if (exponent === 0) return `${sign}${digits}`;
  const padded = digits.padStart(exponent + 1, "0");
  return `${sign}${padded.slice(0, -exponent)}.${padded.slice(-exponent)}`;
}
