import { describe, expect, it } from "vitest";
import { computeBackoffMs } from "../../src/shared/retry.js";

describe("computeBackoffMs", () => {
  it("cresce exponencialmente (sem jitter: random = 1 dá o valor nominal)", () => {
    const at = (attempt: number) => computeBackoffMs({ attempt, baseMs: 1000, random: () => 1 });
    expect([1, 2, 3, 4].map(at)).toEqual([1000, 2000, 4000, 8000]);
  });

  it("o jitter fica entre 50% e 100% do nominal", () => {
    expect(computeBackoffMs({ attempt: 3, baseMs: 1000, random: () => 0 })).toBe(2000);
    expect(computeBackoffMs({ attempt: 3, baseMs: 1000, random: () => 0.999999 })).toBeLessThanOrEqual(4000);
    expect(computeBackoffMs({ attempt: 3, baseMs: 1000, random: () => 0.999999 })).toBeGreaterThan(3990);
  });

  it("respeita o teto", () => {
    expect(computeBackoffMs({ attempt: 30, baseMs: 1000, maxMs: 60_000, random: () => 1 })).toBe(60_000);
  });

  it("trata tentativa 0 ou negativa como a primeira", () => {
    expect(computeBackoffMs({ attempt: 0, baseMs: 1000, random: () => 1 })).toBe(1000);
  });
});
