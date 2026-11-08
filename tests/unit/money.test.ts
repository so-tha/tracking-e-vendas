import { describe, expect, it } from "vitest";
import { currencyExponent, isValidCurrency, minorUnitsToDecimalString } from "../../src/shared/money.js";

describe("isValidCurrency", () => {
  it.each(["USD", "BRL", "EUR", "JPY", "KWD"])("aceita %s", (c) => expect(isValidCurrency(c)).toBe(true));
  it.each(["usd", "US", "USDD", "ZZZ", "", "123", "U$D"])("rejeita %j", (c) => expect(isValidCurrency(c)).toBe(false));
});

describe("currencyExponent (ADR-017: não assumir 2 casas)", () => {
  it.each([["USD", 2], ["BRL", 2], ["JPY", 0], ["KWD", 3]] as const)("%s tem %i casas", (c, e) => {
    expect(currencyExponent(c)).toBe(e);
  });
  it("lança erro para moeda inválida", () => expect(() => currencyExponent("ZZZ")).toThrow(RangeError));
});

describe("minorUnitsToDecimalString (sem ponto flutuante)", () => {
  it.each([
    [25500n, "USD", "255.00"],
    [5n, "USD", "0.05"],
    [0n, "USD", "0.00"],
    [100n, "USD", "1.00"],
    [1n, "USD", "0.01"],
    [100n, "JPY", "100"],
    [0n, "JPY", "0"],
    [1234n, "KWD", "1.234"],
    [1n, "KWD", "0.001"],
    [-250n, "USD", "-2.50"],
  ] as const)("%s %s -> %s", (minor, currency, expected) => {
    expect(minorUnitsToDecimalString(minor, currency)).toBe(expected);
  });

  it("mantém precisão acima do limite seguro do number (2^53)", () => {
    expect(minorUnitsToDecimalString(9007199254740993n, "USD")).toBe("90071992547409.93");
  });

  it("evita o erro clássico de ponto flutuante", () => {
    // 0.1 + 0.2 em ponto flutuante dá 0.30000000000000004. Aqui 30 centavos são exatamente "0.30".
    expect(minorUnitsToDecimalString(30n, "USD")).toBe("0.30");
  });
});
