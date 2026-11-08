import type { Alert, ConflictDetail } from "../attribution/resolve.js";

const UNATTRIBUTED: Record<string, string> = {
  NO_EVIDENCE:
    "O webhook não trouxe nenhuma evidência utilizável (sessionId, identificador de clique ou e-mail do cliente). fbp e ttp sozinhos não atribuem.",
  NO_MATCHING_SESSION: "O webhook trouxe evidências, mas nenhuma sessão de tracking correspondente foi encontrada.",
  AMBIGUOUS_PLATFORM_IDENTIFIER:
    "Mais de uma sessão corresponde aos identificadores próprios (utmifyId ou redtrackClickId). Nenhuma foi escolhida, para não atribuir a venda ao visitante errado.",
  AMBIGUOUS_CLICK_ID:
    "Mais de uma sessão corresponde aos identificadores de clique. Nenhuma foi escolhida, para não atribuir a venda ao visitante errado.",
  AMBIGUOUS_CUSTOMER_WINDOW:
    "Mais de uma sessão do mesmo cliente está dentro da janela de tempo. Nenhuma foi escolhida, para não atribuir a venda ao visitante errado.",
};

export function explainUnattributed(reason: string | null): string | null {
  if (reason === null) return null;
  return UNATTRIBUTED[reason] ?? `Motivo desconhecido: ${reason}.`;
}

export function explainAttribution(level: number | null, method: string | null): string {
  const how: Record<string, string> = {
    SESSION_ID: "pelo sessionId informado no webhook (nível 1)",
    PLATFORM_IDENTIFIER: "por um identificador próprio, utmifyId ou redtrackClickId (nível 2)",
    CLICK_ID: "por um identificador de clique de rede de anúncios (nível 3)",
    CUSTOMER_WINDOW: "pelo e-mail do cliente dentro da janela de tempo, único candidato (nível 4)",
  };
  return method && how[method] ? `Atribuída ${how[method]}.` : `Atribuída (nível ${level ?? "?"}).`;
}

export function explainSkip(reason: string | null): string | null {
  if (reason === null) return null;
  if (reason === "EVENT_TOO_OLD") return "O evento tem mais de 7 dias, e o provedor não aceita eventos tão antigos. Não foi enviado.";
  const identifier = /^MISSING_REQUIRED_IDENTIFIER:(.+)$/.exec(reason);
  if (identifier) {
    const fields = identifier[1]!.split("|");
    const listed = fields.length > 1 ? `${fields.slice(0, -1).join(", ")} ou ${fields.at(-1)}` : fields[0];
    return `Faltou um identificador obrigatório deste provedor (${listed}). Não foi enviado.`;
  }
  const field = /^MISSING_REQUIRED_FIELD:(.+)$/.exec(reason);
  if (field) return `Faltou um campo obrigatório deste provedor (${field[1]}). Não foi enviado.`;
  return `Não enviado: ${reason}.`;
}

export function explainFailure(reason: string | null): string | null {
  if (reason === null) return null;
  if (reason === "RETRIES_EXHAUSTED") return "Todas as tentativas falharam por erros transitórios. Não há novas tentativas automáticas.";
  if (reason === "EVENT_TOO_OLD") return "O evento passou de 7 dias durante as tentativas, e o provedor não o aceita mais.";
  const rejected = /^PROVIDER_REJECTED:(.+)$/.exec(reason);
  if (rejected) {
    return `O provedor rejeitou o envio (HTTP ${rejected[1]}). É um erro permanente, então não há nova tentativa automática.`;
  }
  const contract = /^CONTRACT_ERROR:(.+)$/.exec(reason);
  if (contract) return `O evento não cabe no contrato do provedor (${contract[1]}). Nada foi enviado.`;
  return `Falhou: ${reason}.`;
}

const EVENT_STATUS: Record<string, string> = {
  RECEIVED: "Recebido e aguardando processamento.",
  PROCESSED: "Processado: o pedido foi criado.",
  IGNORED_UNSUPPORTED: "Tipo de evento não processado por este sistema. Registrado e ignorado.",
  DUPLICATE_ORDER: "Já existia um pedido com este orderId (criado por outro evento). Nenhum pedido novo foi criado.",
  FAILED: "Falhou no processamento.",
};
export const explainEventStatus = (status: string): string => EVENT_STATUS[status] ?? status;

function explainConflict(detail: ConflictDetail): string {
  switch (detail.kind) {
    case "OTHER_SESSION_EVIDENCE":
      return `Evidência do nível ${detail.level} (${detail.method}) aponta para outra sessão: ${detail.sessionIds.join(", ")}. Foi mantida a sessão do nível mais alto.`;
    case "IDENTIFIER_MISMATCH":
      return `O identificador ${detail.field} do webhook difere do registrado na sessão. Foi usado o da sessão.`;
    case "EMAIL_MISMATCH":
      return "O e-mail do webhook difere do registrado na sessão. Nenhum dado pessoal da sessão foi usado nas conversões.";
  }
}

export function explainAlert(alert: Alert): { code: string; explanation: string; details: unknown } {
  if (alert.code === "ATTRIBUTION_CONFLICT") {
    return { code: alert.code, explanation: alert.details.map(explainConflict).join(" "), details: alert.details };
  }
  return {
    code: alert.code,
    explanation: "Webhook e sessão trazem customFields diferentes. Foi usado o objeto do webhook, sem mesclar.",
    details: alert.details,
  };
}

export function explainConversion(input: {
  status: string;
  provider: string;
  skipReason: string | null;
  failureReason: string | null;
  attemptCount: number;
  nextAttemptAt: Date | null;
}): string {
  switch (input.status) {
    case "DELIVERED":
      return `Entregue ao provedor na tentativa ${input.attemptCount}.`;
    case "SKIPPED":
      return explainSkip(input.skipReason) ?? "Não enviado.";
    case "FAILED_PERMANENT":
      return explainFailure(input.failureReason) ?? "Falha permanente.";
    default:
      return input.nextAttemptAt
        ? `Aguardando nova tentativa (próxima em ${input.nextAttemptAt.toISOString()}). Tentativas feitas: ${input.attemptCount}.`
        : `Aguardando a primeira entrega. Tentativas feitas: ${input.attemptCount}.`;
  }
}
