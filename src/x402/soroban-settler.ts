/**
 * A real `Settler` — Soroban RPC, no seam behind it.
 *
 * Two operations on an envelope this process did not build. Neither may modify
 * it: the payer's auth entry is signed and the signature covers exactly these
 * bytes, so the envelope is parsed and passed through, never rebuilt.
 *
 * Simulation is what makes the fee ceiling meaningful. It is also where a
 * policy refusal surfaces: a spending-limit contract declining inside
 * `__check_auth` fails simulation, which means the refusal costs nothing and
 * arrives before submission rather than as a burnt fee.
 */

import {
  BASE_FEE,
  Keypair,
  Operation,
  TransactionBuilder,
  rpc,
  type Transaction,
} from "@stellar/stellar-sdk";

import { PASSPHRASE_BY_CAIP2, type Caip2 } from "./protocol";
import type { Settler, SimulationOutcome } from "./facilitator";

export interface SorobanSettlerOptions {
  /** Soroban RPC endpoints, keyed by the networks this settler will serve. */
  rpcUrls: Partial<Record<Caip2, string>>;
  /** How long to wait for a submitted transaction to close. */
  pollTimeoutMs?: number;
}

const DEFAULT_POLL_TIMEOUT_MS = 30_000;

export function createSorobanSettler(options: SorobanSettlerOptions): Settler {
  const servers = new Map<Caip2, rpc.Server>();

  function serverFor(network: Caip2): rpc.Server {
    const cached = servers.get(network);
    if (cached) return cached;

    const url = options.rpcUrls[network];
    if (!url) {
      throw new Error(`no Soroban RPC configured for ${network}`);
    }
    const server = new rpc.Server(url);
    servers.set(network, server);
    return server;
  }

  function parse(transactionXdr: string, network: Caip2) {
    try {
      return TransactionBuilder.fromXDR(transactionXdr, PASSPHRASE_BY_CAIP2[network]);
    } catch (error) {
      // A malformed envelope is the payer's problem, not an RPC failure, and
      // the distinction matters: one is a refusal, the other is an outage.
      throw new Error(
        `payment envelope is not a valid transaction for ${network}: ` +
          (error instanceof Error ? error.message : String(error)),
      );
    }
  }

  return {
    async simulate({ transactionXdr, network }): Promise<SimulationOutcome> {
      const tx = parse(transactionXdr, network);
      const simulation = await serverFor(network).simulateTransaction(tx);

      if (rpc.Api.isSimulationError(simulation)) {
        return {
          success: false,
          // No fee is charged for a failed simulation, and reporting a quote
          // here would make a refusal look like it cost something.
          feeStroops: 0,
          error: simulation.error,
        };
      }

      // `minResourceFee` is the resource fee alone — the part that scales with
      // running the policy inside __check_auth, and the number the ceiling is
      // actually about.
      const feeStroops = Number(simulation.minResourceFee);
      if (!Number.isFinite(feeStroops)) {
        return {
          success: false,
          feeStroops: 0,
          error: `simulation returned an unreadable resource fee ${JSON.stringify(simulation.minResourceFee)}`,
        };
      }

      return { success: true, feeStroops };
    },

    async submit({ transactionXdr, network }): Promise<{ hash: string }> {
      const tx = parse(transactionXdr, network);
      const server = serverFor(network);

      const sent = await server.sendTransaction(tx);

      if (sent.status === "ERROR") {
        throw new Error(
          `the network rejected the transaction on submission: ${JSON.stringify(sent.errorResult?.result().switch().name ?? "unknown")}`,
        );
      }

      const settled = await server.pollTransaction(sent.hash, {
        attempts: Math.max(1, Math.floor((options.pollTimeoutMs ?? DEFAULT_POLL_TIMEOUT_MS) / 1000)),
      });

      if (settled.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
        // The envelope reached the network and failed there. The hash is real
        // and fees were charged, so this is deliberately not reported as a
        // clean refusal — the caller must not tell a payer nothing happened.
        throw new Error(
          `transaction ${sent.hash} was submitted but did not succeed (status ${settled.status})`,
        );
      }

      return { hash: sent.hash };
    },
  };
}

export interface SponsoredSettlerOptions {
  rpcUrl: string;
  network: Caip2;
  /**
   * The facilitator's own funded account. It sources the submitted envelope
   * and pays the fee — this is what "fees are sponsored" means, and why an
   * offer must declare `areFeesSponsored: true`.
   */
  sponsor: Keypair;
  pollTimeoutMs?: number;
}

/**
 * A settler that rebuilds before submitting.
 *
 * The payer signs an *auth entry*, not an envelope. The envelope the client
 * produced is sourced by a simulation account that never signs it, so it can
 * never be submitted as-is — submission would fail authentication.
 *
 * So the facilitator lifts the invocation, complete with the payer's signed
 * auth entry, into a fresh transaction sourced and signed by its own funded
 * account. The payer's signature still covers exactly the transfer they
 * authorised: it is over the auth entry, which is carried across untouched.
 * What changes is only who pays the fee.
 */
export function createSponsoredSorobanSettler(options: SponsoredSettlerOptions): Settler {
  const { rpcUrl, network, sponsor } = options;
  const server = new rpc.Server(rpcUrl);
  const passphrase = PASSPHRASE_BY_CAIP2[network];

  function parse(transactionXdr: string): Transaction {
    try {
      return TransactionBuilder.fromXDR(transactionXdr, passphrase) as Transaction;
    } catch (error) {
      throw new Error(
        `payment envelope is not a valid transaction for ${network}: ` +
          (error instanceof Error ? error.message : String(error)),
      );
    }
  }

  /** Lift the payer's invocation into a transaction our sponsor can submit. */
  async function rebuild(payerTx: Transaction): Promise<Transaction> {
    const op = payerTx.operations[0];
    if (!op || op.type !== "invokeHostFunction") {
      throw new Error(`expected an invokeHostFunction operation, got ${op?.type ?? "none"}`);
    }

    const account = await server.getAccount(sponsor.publicKey());

    return new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: passphrase })
      .addOperation(
        Operation.invokeHostFunction({
          func: op.func,
          // The signed entries travel verbatim. Re-signing or regenerating
          // them here would invalidate the payer's authorisation.
          auth: op.auth ?? [],
        }),
      )
      .setTimeout(30)
      .build();
  }

  return {
    async simulate({ transactionXdr }): Promise<SimulationOutcome> {
      // Simulated as the sponsor would submit it, so the quoted fee is the
      // fee this facilitator will actually be asked to pay.
      const rebuilt = await rebuild(parse(transactionXdr));
      const simulation = await server.simulateTransaction(rebuilt);

      if (rpc.Api.isSimulationError(simulation)) {
        return { success: false, feeStroops: 0, error: simulation.error };
      }

      const feeStroops = Number(simulation.minResourceFee);
      if (!Number.isFinite(feeStroops)) {
        return {
          success: false,
          feeStroops: 0,
          error: `simulation returned an unreadable resource fee ${JSON.stringify(simulation.minResourceFee)}`,
        };
      }

      return { success: true, feeStroops };
    },

    async submit({ transactionXdr }): Promise<{ hash: string }> {
      const rebuilt = await rebuild(parse(transactionXdr));

      const simulation = await server.simulateTransaction(rebuilt);
      if (rpc.Api.isSimulationError(simulation)) {
        throw new Error(`simulation failed before submission: ${simulation.error}`);
      }

      // assembleTransaction attaches the footprint and resource fee simulation
      // computed; a Soroban transaction cannot be submitted without them.
      const prepared = rpc.assembleTransaction(rebuilt, simulation).build();
      prepared.sign(sponsor);

      const sent = await server.sendTransaction(prepared);
      if (sent.status === "ERROR") {
        throw new Error(
          `the network rejected the transaction on submission: ${sent.errorResult?.result().switch().name ?? "unknown"}`,
        );
      }

      const settled = await server.pollTransaction(sent.hash, {
        attempts: Math.max(1, Math.floor((options.pollTimeoutMs ?? DEFAULT_POLL_TIMEOUT_MS) / 1000)),
      });

      if (settled.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
        throw new Error(
          `transaction ${sent.hash} was submitted but did not succeed (status ${settled.status})`,
        );
      }

      return { hash: sent.hash };
    },
  };
}
