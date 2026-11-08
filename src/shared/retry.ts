export interface BackoffOptions {
  /** Número da tentativa que acabou de falhar (1 = primeira). */
  attempt: number;
  baseMs: number;
  maxMs?: number;
  /** Injetável para testes. Deve devolver um valor em [0, 1). */
  random?: () => number;
}

/**
 * Backoff exponencial com jitter: o atraso nominal é base * 2^(tentativa - 1), limitado por maxMs.
 * O atraso real fica entre 50% e 100% do nominal, para que falhas simultâneas não voltem todas juntas.
 */
export function computeBackoffMs({ attempt, baseMs, maxMs = 3_600_000, random = Math.random }: BackoffOptions): number {
  const nominal = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt - 1));
  return Math.round(nominal * (0.5 + random() * 0.5));
}
