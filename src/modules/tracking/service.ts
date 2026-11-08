import type { Prisma } from "../../generated/prisma/client.js";
import type { PrismaClient } from "../../shared/db.js";
import { mergeSession, type Change, type Conflict, type SessionState } from "./merge.js";
import { IDENTIFIER_FIELDS, type CustomFields, type Identifiers, type NormalizedSession } from "./normalize.js";

export interface UpsertResult {
  created: boolean;
  complementedFields: string[];
  conflictFields: string[];
  warnings: string[];
}

type SessionRow = Prisma.TrackingSessionGetPayload<object>;

function toState(row: SessionRow): SessionState {
  const identifiers = Object.fromEntries(
    IDENTIFIER_FIELDS.map((field) => [field, row[field]]),
  ) as Identifiers;
  return {
    pageUrl: row.pageUrl,
    customFields: (row.customFields as CustomFields | null) ?? null,
    identifiers,
    customerEmail: row.customerEmail,
    customerPhone: row.customerPhone,
  };
}

const json = (value: unknown): Prisma.InputJsonValue => value as Prisma.InputJsonValue;

/**
 * Cria ou atualiza a sessão de forma controlada.
 *
 * O lock consultivo serializa requisições do mesmo sessionId: sem ele, duas requisições
 * simultâneas leriam o mesmo estado e ambas decidiriam "complementar" o mesmo campo.
 * A constraint única de sessionId continua como rede de segurança.
 */
export async function upsertSession(
  prisma: PrismaClient,
  incoming: NormalizedSession,
  now: Date,
): Promise<UpsertResult> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${incoming.sessionId}, 0))`;

    const existing = await tx.trackingSession.findUnique({ where: { sessionId: incoming.sessionId } });

    let changes: Change[] = [];
    let conflicts: Conflict[] = [];
    let sessionRefId: string;

    if (!existing) {
      const created = await tx.trackingSession.create({
        data: {
          sessionId: incoming.sessionId,
          pageUrl: incoming.pageUrl,
          customFields: incoming.customFields ? json(incoming.customFields) : undefined,
          ...incoming.identifiers,
          customerEmail: incoming.customerEmail,
          customerPhone: incoming.customerPhone,
          firstSeenAt: now,
          lastSeenAt: now,
        },
      });
      sessionRefId = created.id;
    } else {
      const current = toState(existing);
      const merged = mergeSession(current, {
        pageUrl: incoming.pageUrl,
        customFields: incoming.customFields,
        identifiers: incoming.identifiers,
        customerEmail: incoming.customerEmail,
        customerPhone: incoming.customerPhone,
      });
      changes = merged.changes;
      conflicts = merged.conflicts;
      sessionRefId = existing.id;

      await tx.trackingSession.update({
        where: { id: existing.id },
        data: {
          customFields: merged.next.customFields ? json(merged.next.customFields) : undefined,
          ...merged.next.identifiers,
          customerEmail: merged.next.customerEmail,
          customerPhone: merged.next.customerPhone,
          lastSeenAt: now,
        },
      });
    }

    await tx.trackingSessionRevision.create({
      data: {
        sessionRefId,
        receivedAt: now,
        // Só dados já normalizados: valores inválidos de e-mail e telefone não são gravados em lugar nenhum.
        incomingPayload: json({
          sessionId: incoming.sessionId,
          pageUrl: incoming.pageUrl,
          customFields: incoming.customFields,
          identifiers: incoming.identifiers,
          customer: { email: incoming.customerEmail, phone: incoming.customerPhone },
        }),
        appliedChanges: json({ created: !existing, complemented: changes, warnings: incoming.warnings }),
        conflicts: json(conflicts),
      },
    });

    return {
      created: !existing,
      complementedFields: changes.map((c) => c.field),
      conflictFields: conflicts.map((c) => c.field),
      warnings: incoming.warnings,
    };
  });
}
