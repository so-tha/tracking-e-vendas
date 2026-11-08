import type { Prisma, PrismaClient } from "../../generated/prisma/client.js";
import { IDENTIFIER_FIELDS, type IdentifierField, type Identifiers } from "../tracking/normalize.js";
import type { SessionLookup, SessionRecord } from "./resolve.js";

type Client = Pick<PrismaClient, "trackingSession"> | Pick<Prisma.TransactionClient, "trackingSession">;

const MAX_CANDIDATES = 20;

type Row = Prisma.TrackingSessionGetPayload<object>;

function toRecord(row: Row): SessionRecord {
  const identifiers = Object.fromEntries(IDENTIFIER_FIELDS.map((f) => [f, row[f]])) as Identifiers;
  return {
    id: row.id,
    sessionId: row.sessionId,
    customFields: (row.customFields as Record<string, unknown> | null) ?? null,
    identifiers,
    customerEmail: row.customerEmail,
    firstSeenAt: row.firstSeenAt,
  };
}

export function createSessionLookup(client: Client): SessionLookup {
  return {
    async findBySessionId(sessionId) {
      const row = await client.trackingSession.findUnique({ where: { sessionId } });
      return row ? toRecord(row) : null;
    },
    async findByIdentifier(field: IdentifierField, value: string) {
      const rows = await client.trackingSession.findMany({
        where: { [field]: value },
        orderBy: { firstSeenAt: "asc" },
        take: MAX_CANDIDATES,
      });
      return rows.map(toRecord);
    },
    async findByCustomerEmail(email, from, to) {
      const rows = await client.trackingSession.findMany({
        where: { customerEmail: email, firstSeenAt: { gte: from, lte: to } },
        orderBy: { firstSeenAt: "asc" },
        take: MAX_CANDIDATES,
      });
      return rows.map(toRecord);
    },
  };
}
