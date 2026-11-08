import { createSimulator, json, type Simulator } from "./base.js";

export interface RedTrackSimulator extends Simulator {
  /** Conversões registradas pelo RedTrack. Com a deduplicação por rdtk_event_id, repetições não entram. */
  recorded: { clickid: string; sum: string; type: string; eventId: string | null }[];
}

/**
 * Simulador do postback do RedTrack. Reproduz o modo oficial "ignorar postbacks duplicados por event id":
 * a segunda chamada com o mesmo rdtk_event_id responde 200 e não cria outra conversão.
 */
export function createRedTrackSimulator(options: { trackingDomain: string }): RedTrackSimulator {
  const recorded: RedTrackSimulator["recorded"] = [];
  const seenEventIds = new Set<string>();

  const simulator = createSimulator((request) => {
    const url = new URL(request.fullUrl);
    if (url.host !== options.trackingDomain || url.pathname !== "/postback") return json(404, "Not Found");
    if (request.method !== "GET") return json(405, "Method Not Allowed");

    const clickid = url.searchParams.get("clickid");
    const sum = url.searchParams.get("sum");
    const type = url.searchParams.get("type");
    const eventId = url.searchParams.get("rdtk_event_id");

    if (!clickid) return json(400, "clickid is required");
    if (!sum || !/^\d+(\.\d+)?$/.test(sum)) return json(400, "sum must be a decimal number");
    if (!type) return json(400, "type is required");

    if (eventId && seenEventIds.has(eventId)) return json(200, "OK (duplicate ignored)");
    if (eventId) seenEventIds.add(eventId);
    recorded.push({ clickid, sum, type, eventId });
    return json(200, "OK");
  }) as RedTrackSimulator;

  simulator.recorded = recorded;
  const baseReset = simulator.reset;
  simulator.reset = () => {
    baseReset();
    recorded.length = 0;
    seenEventIds.clear();
  };
  return simulator;
}
