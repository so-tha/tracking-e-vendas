import { describe, expect, it } from "vitest";
import {
  hashOrNull,
  isSha256Hex,
  maskEmail,
  maskPhone,
  normalizeEmailBasic,
  normalizeEmailGoogle,
  normalizePhoneE164,
  normalizePhoneMeta,
  sha256Hex,
} from "../../src/shared/pii.js";

describe("sha256Hex", () => {
  it("gera hexadecimal minúsculo de 64 caracteres, com vetores de teste conhecidos", () => {
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(isSha256Hex(sha256Hex("qualquer coisa"))).toBe(true);
  });
  it("usa os bytes UTF-8 do texto", () => {
    expect(sha256Hex("josé@exemplo.com")).toBe(sha256Hex(Buffer.from("josé@exemplo.com", "utf8").toString("utf8")));
    expect(sha256Hex("é")).not.toBe(sha256Hex("e"));
  });
});

describe("normalizeEmailBasic (Meta, TikTok)", () => {
  it("remove espaços das pontas e coloca em minúsculas", () => {
    expect(normalizeEmailBasic("  John_Smith@Gmail.com ")).toBe("john_smith@gmail.com");
  });
  it("NÃO aplica as regras do Gmail: pontos e + permanecem", () => {
    expect(normalizeEmailBasic("Jane.Doe+Shop@Gmail.com")).toBe("jane.doe+shop@gmail.com");
  });
  it.each([[""], ["   "], ["sem-arroba"], ["@sem-usuario.com"]])("rejeita %j", (v) => {
    expect(normalizeEmailBasic(v)).toBeNull();
  });
});

describe("normalizeEmailGoogle (regra oficial)", () => {
  it.each([
    ["Jane.Doe+Shopping@googlemail.com", "janedoe@googlemail.com"],
    ["jane.doe@gmail.com", "janedoe@gmail.com"],
    ["  JANE.DOE+x+y@GMAIL.COM  ", "janedoe@gmail.com"],
    ["user.name+NYC@Example.com", "user.name+nyc@example.com"],
    ["nome.sobrenome@empresa.com.br", "nome.sobrenome@empresa.com.br"],
  ])("%s -> %s", (input, expected) => {
    expect(normalizeEmailGoogle(input)).toBe(expected);
  });
  it("rejeita quando o usuário fica vazio depois da normalização", () => {
    expect(normalizeEmailGoogle("+tag@gmail.com")).toBeNull();
    expect(normalizeEmailGoogle("...@gmail.com")).toBeNull();
  });
  it("gmail e outro domínio com o mesmo texto geram hashes diferentes na regra do Google", () => {
    expect(sha256Hex(normalizeEmailGoogle("a.b@gmail.com")!)).not.toBe(sha256Hex(normalizeEmailGoogle("a.b@outro.com")!));
  });
});

describe("telefone", () => {
  it("Meta: só dígitos com código do país, sem o +", () => {
    expect(normalizePhoneMeta("+5511999999999")).toBe("5511999999999");
    expect(normalizePhoneMeta("+16505551212")).toBe("16505551212");
  });
  it("Google e TikTok: E.164 com +", () => {
    expect(normalizePhoneE164("+5511999999999")).toBe("+5511999999999");
  });
  it.each([["11999999999"], ["+0123456789"], ["+55"], ["abc"], [""]])("rejeita %j", (v) => {
    expect(normalizePhoneMeta(v)).toBeNull();
    expect(normalizePhoneE164(v)).toBeNull();
  });
});

describe("hashOrNull e máscaras", () => {
  it("valor ausente nunca é hasheado (evita enviar o hash de texto vazio)", () => {
    expect(hashOrNull(null)).toBeNull();
    expect(hashOrNull("")).toBeNull();
  });
  it("mascara e-mail e telefone para exibição (ADR-019)", () => {
    expect(maskEmail("cliente@email.com")).toBe("c***@email.com");
    expect(maskPhone("+5511999999999")).toBe("**********9999");
    expect(maskEmail("sem-arroba")).toBe("***");
    expect(maskPhone("123")).toBe("***");
  });
});
