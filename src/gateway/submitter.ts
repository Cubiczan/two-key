/**
 * The submission seam.
 *
 * `vellar-sdk` never submits and never holds secrets — that is the point of the
 * whole arrangement. The relayer API key and the funded sponsor account live
 * here, on the server, and every signed transaction the browser produces is
 * handed to this interface to reach the network.
 *
 * It is an interface rather than a function so the routes can be tested without
 * a relayer, and so the failure mode when credentials are missing is a typed
 * 503 at the boundary instead of a stack trace from deep inside an HTTP client.
 */

import { NotConfiguredError, type Network } from "./types";

export interface Submitter {
  /**
   * Submit an already-signed transaction envelope and resolve to its network
   * hash. Implementations must not mutate the envelope: it is signed, and the
   * signature covers exactly these bytes.
   */
  submit(input: { signedXdr: string; network: Network }): Promise<{ hash: string }>;
}

export interface RelayerConfig {
  /** OpenZeppelin Relayer API key. Server-side only, never sent to a browser. */
  apiKey: string;
  /** Relayer base URL. */
  url: string;
}

/**
 * Reads relayer configuration from the environment, or returns undefined when
 * it is absent. Absent is a legitimate state — the gateway still starts, still
 * serves reads, and refuses submission with a clear 503 — because a gateway
 * that refuses to boot without a funded mainnet sponsor is useless in
 * development.
 */
export function relayerConfigFromEnv(env: NodeJS.ProcessEnv = process.env): RelayerConfig | undefined {
  const apiKey = env.RELAYER_API_KEY?.trim();
  const url = env.RELAYER_URL?.trim();
  if (!apiKey || !url) return undefined;
  return { apiKey, url };
}

/**
 * The submitter used when no relayer is configured. It exists so the shape of
 * the system is complete and every route is reachable in tests; it refuses
 * loudly rather than pretending a transaction went out.
 */
export function createUnconfiguredSubmitter(): Submitter {
  return {
    async submit() {
      throw new NotConfiguredError("Transaction submission (RELAYER_API_KEY, RELAYER_URL)");
    },
  };
}

export interface HttpRelayerOptions {
  config: RelayerConfig;
  fetchImpl?: typeof fetch;
}

/**
 * Submits through an OpenZeppelin Relayer.
 *
 * The relayer sponsors the fee, so the user never holds XLM — that sponsorship
 * is the reason this hop exists at all rather than the browser talking straight
 * to Soroban RPC.
 */
export function createHttpRelayerSubmitter(options: HttpRelayerOptions): Submitter {
  const { config } = options;
  const doFetch = options.fetchImpl ?? fetch;
  const base = config.url.replace(/\/+$/, "");

  return {
    async submit({ signedXdr, network }) {
      const res = await doFetch(`${base}/transactions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({ signedXdr, network }),
      });

      const payload: unknown = await res.json().catch(() => ({}));

      if (!res.ok) {
        const detail =
          typeof payload === "object" && payload !== null && "message" in payload
            ? String((payload as { message: unknown }).message)
            : `relayer responded ${res.status}`;
        throw new Error(`submission rejected: ${detail}`);
      }

      const hash =
        typeof payload === "object" && payload !== null && "hash" in payload
          ? (payload as { hash: unknown }).hash
          : undefined;

      if (typeof hash !== "string" || hash.length === 0) {
        throw new Error("relayer accepted the transaction but returned no hash");
      }

      return { hash };
    },
  };
}
