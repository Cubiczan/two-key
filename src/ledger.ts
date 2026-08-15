/**
 * One append-only ledger for both keys.
 *
 * The claim the architecture makes is that every decision — the governor's and
 * the chain's — lands in the same record. That is only worth anything if the
 * record cannot be quietly edited afterwards, so each entry carries the hash of
 * the one before it and the chain is signed.
 *
 * Tampering with any entry breaks every hash after it, and re-deriving those
 * requires the signing key. `verify` reports the first entry that fails and
 * why, rather than a bare boolean — an audit log that can only say "invalid"
 * tells you nothing about what happened.
 */

import { createHash } from "node:crypto";

import type { Keypair } from "@stellar/stellar-sdk";

import type { Lane, Reason } from "./governor/types";

/** Where a decision came from. Both keys write here. */
export type Authority = "governor" | "chain";

export interface LedgerEntry {
  seq: number;
  at: string;
  authority: Authority;
  proposalId: string;
  lane: Lane;
  reasons: Reason[];
  /** Set only when the chain settled it. */
  transaction?: string;
  /** Minor units, carried so the ledger reads without the proposal. */
  amountMinor: number;
  currency: string;
  prevHash: string;
  hash: string;
  signature: string;
}

export interface AppendInput {
  authority: Authority;
  proposalId: string;
  lane: Lane;
  reasons: Reason[];
  amountMinor: number;
  currency: string;
  transaction?: string;
}

export interface Ledger {
  append(input: AppendInput): LedgerEntry;
  entries(): readonly LedgerEntry[];
  verify(): VerifyReport;
}

export type VerifyReport =
  | { valid: true; length: number }
  | { valid: false; failedAt: number; reason: string };

const GENESIS = "0".repeat(64);

/** Everything except the signature — the signature covers exactly this. */
function digest(entry: Omit<LedgerEntry, "hash" | "signature">): string {
  const canonical = JSON.stringify([
    entry.seq,
    entry.at,
    entry.authority,
    entry.proposalId,
    entry.lane,
    entry.reasons.map((r) => [r.code, r.detail]),
    entry.transaction ?? null,
    entry.amountMinor,
    entry.currency,
    entry.prevHash,
  ]);
  return createHash("sha256").update(canonical).digest("hex");
}

export interface LedgerOptions {
  /** Signs the chain. Its secret never leaves this process. */
  signer: Keypair;
  /** Injected so entries are deterministic in tests. */
  now?: () => Date;
}

export function createLedger(options: LedgerOptions): Ledger {
  const { signer } = options;
  const now = options.now ?? (() => new Date());
  const log: LedgerEntry[] = [];

  return {
    append(input) {
      const prevHash = log.length > 0 ? log[log.length - 1]!.hash : GENESIS;

      const unsigned = {
        seq: log.length,
        at: now().toISOString(),
        authority: input.authority,
        proposalId: input.proposalId,
        lane: input.lane,
        reasons: input.reasons,
        amountMinor: input.amountMinor,
        currency: input.currency,
        prevHash,
        ...(input.transaction ? { transaction: input.transaction } : {}),
      };

      const hash = digest(unsigned);
      const entry: LedgerEntry = {
        ...unsigned,
        hash,
        signature: signer.sign(Buffer.from(hash, "hex")).toString("base64"),
      };

      log.push(entry);
      return entry;
    },

    entries() {
      return log;
    },

    verify() {
      let prevHash = GENESIS;

      for (const entry of log) {
        if (entry.prevHash !== prevHash) {
          return {
            valid: false,
            failedAt: entry.seq,
            reason: `entry ${entry.seq} points at ${entry.prevHash.slice(0, 12)}… but the previous entry hashes to ${prevHash.slice(0, 12)}…`,
          };
        }

        const { hash, signature, ...rest } = entry;
        if (digest(rest) !== hash) {
          return {
            valid: false,
            failedAt: entry.seq,
            reason: `entry ${entry.seq} does not hash to its recorded hash — its contents changed after signing`,
          };
        }

        if (!signer.verify(Buffer.from(hash, "hex"), Buffer.from(signature, "base64"))) {
          return {
            valid: false,
            failedAt: entry.seq,
            reason: `entry ${entry.seq} carries a signature this key did not produce`,
          };
        }

        prevHash = hash;
      }

      return { valid: true, length: log.length };
    },
  };
}
