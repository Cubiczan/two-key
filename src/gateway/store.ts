/**
 * The keyId → contractId mapping, and the server-side session records that
 * `/wallet/create` and `/wallet/connect` open.
 *
 * A passkey's credential id is the only thing the browser can produce on a
 * reconnect; the smart-account address is what everything downstream needs. So
 * this mapping is the whole reason `/wallet/connect` exists, and losing it
 * strands a user's wallet even though the account is perfectly fine on-chain.
 *
 * The interface is separated from the implementation because the in-memory
 * store below is honest about being for development: it forgets everything on
 * restart. A durable implementation swaps in without touching the routes.
 */

import type { Network } from "./types";

export interface SessionRecord {
  sessionId: string;
  keyId: string;
  contractId: string;
  network: Network;
  createdAt: string;
}

export interface SessionStore {
  /** Record a freshly deployed wallet. Returns the opened session. */
  create(input: { keyId: string; contractId: string; network: Network }): Promise<SessionRecord>;
  /** Reverse lookup for reconnects. Undefined is a 404, not an error. */
  lookup(input: { keyId: string; network: Network }): Promise<SessionRecord | undefined>;
}

/**
 * Scoped by network as well as keyId. The same passkey used against testnet and
 * mainnet resolves to different smart accounts, and silently returning the
 * wrong one would be a cross-network fund-loss bug rather than a lookup miss.
 */
function key(keyId: string, network: Network): string {
  return `${network}:${keyId}`;
}

export interface MemorySessionStoreOptions {
  /** Injected so tests get deterministic ids and timestamps. */
  newSessionId?: () => string;
  now?: () => Date;
}

export function createMemorySessionStore(options: MemorySessionStoreOptions = {}): SessionStore {
  const newSessionId = options.newSessionId ?? (() => crypto.randomUUID());
  const now = options.now ?? (() => new Date());
  const records = new Map<string, SessionRecord>();

  return {
    async create({ keyId, contractId, network }) {
      const record: SessionRecord = {
        sessionId: newSessionId(),
        keyId,
        contractId,
        network,
        createdAt: now().toISOString(),
      };
      records.set(key(keyId, network), record);
      return record;
    },

    async lookup({ keyId, network }) {
      return records.get(key(keyId, network));
    },
  };
}
