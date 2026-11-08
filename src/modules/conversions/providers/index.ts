import type { ProvidersConfig } from "../../../config/env.js";
import { createGoogleSimulator } from "../simulators/google.js";
import { createMetaSimulator } from "../simulators/meta.js";
import { createRedTrackSimulator, type RedTrackSimulator } from "../simulators/redtrack.js";
import { createTikTokSimulator } from "../simulators/tiktok.js";
import { createUtmifySimulator } from "../simulators/utmify.js";
import type { Simulator } from "../simulators/base.js";
import type { ConversionProvider, HttpTransport, ProviderName } from "../types.js";
import { createGoogleProvider } from "./google.js";
import { createMetaProvider } from "./meta.js";
import { createRedTrackProvider } from "./redtrack.js";
import { createTikTokProvider } from "./tiktok.js";
import { createUtmifyProvider } from "./utmify.js";

export type ProviderRegistry = Record<ProviderName, ConversionProvider>;

/** Monta os cinco adaptadores. Cada um recebe o próprio transporte, o que garante o isolamento entre eles. */
export function createProviderRegistry(
  config: ProvidersConfig,
  transports: Record<ProviderName, HttpTransport>,
): ProviderRegistry {
  return {
    META: createMetaProvider(config.meta, transports.META),
    GOOGLE: createGoogleProvider(config.google, transports.GOOGLE),
    TIKTOK: createTikTokProvider(config.tiktok, transports.TIKTOK),
    UTMIFY: createUtmifyProvider(config.utmify, transports.UTMIFY),
    REDTRACK: createRedTrackProvider(config.redtrack, transports.REDTRACK),
  };
}

export interface SimulatedEnvironment {
  registry: ProviderRegistry;
  simulators: { META: Simulator; GOOGLE: Simulator; TIKTOK: Simulator; UTMIFY: Simulator; REDTRACK: RedTrackSimulator };
}

/** Modo simulado (PROVIDER_MODE=simulated): nenhum tráfego real, cada provedor valida o próprio contrato. */
export function createSimulatedEnvironment(
  config: ProvidersConfig,
  options: { now?: () => Date } = {},
): SimulatedEnvironment {
  const simulators = {
    META: createMetaSimulator(options),
    GOOGLE: createGoogleSimulator(),
    TIKTOK: createTikTokSimulator(),
    UTMIFY: createUtmifySimulator(options),
    REDTRACK: createRedTrackSimulator({ trackingDomain: config.redtrack.trackingDomain }),
  };
  const registry = createProviderRegistry(config, {
    META: simulators.META.transport,
    GOOGLE: simulators.GOOGLE.transport,
    TIKTOK: simulators.TIKTOK.transport,
    UTMIFY: simulators.UTMIFY.transport,
    REDTRACK: simulators.REDTRACK.transport,
  });
  return { registry, simulators };
}
