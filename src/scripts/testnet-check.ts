/**
 * Proves the settler talks to Soroban testnet, and shows the fee ceiling
 * deciding a real payment.
 *
 * Simulation needs no signature, so this runs with nothing but a friendbot
 * account: it builds an actual SEP-41 transfer against the testnet XLM
 * contract, simulates it through the same `Settler` the facilitator uses, and
 * prints the resource fee the network quotes.
 *
 * The number that comes back is the argument for self-hosting the facilitator.
 * A plain transfer is cheap; a transfer that runs a policy inside
 * `__check_auth` is not, and the hosted default of 50,000 stroops is fixed.
 *
 *   npm run testnet:check
 */

import {
  BASE_FEE,
  Contract,
  Keypair,
  TransactionBuilder,
  nativeToScVal,
  rpc,
} from "@stellar/stellar-sdk";
import { TESTNET } from "vellar-sdk";

import { HOSTED_DEFAULT_MAX_FEE_STROOPS, DEFAULT_MAX_FEE_STROOPS } from "@/x402/facilitator";
import { createSorobanSettler } from "@/x402/soroban-settler";

const NETWORK = "stellar:testnet" as const;

function line(label: string, value: string): void {
  console.log(`  ${label.padEnd(22)} ${value}`);
}

async function fund(publicKey: string): Promise<void> {
  const res = await fetch(`https://friendbot.stellar.org/?addr=${publicKey}`);
  if (!res.ok && res.status !== 400) {
    throw new Error(`friendbot refused to fund ${publicKey}: HTTP ${res.status}`);
  }
}

async function main(): Promise<void> {
  console.log("\ntwo-key — testnet settler check\n");

  // Config comes from vellar-sdk rather than being hardcoded, so the RPC URL,
  // passphrase and XLM contract id are whatever the SDK targets.
  line("rpc", TESTNET.rpcUrl);
  line("xlm contract", TESTNET.nativeTokenContractId);

  const payer = Keypair.random();
  const payee = Keypair.random();
  await Promise.all([fund(payer.publicKey()), fund(payee.publicKey())]);
  line("payer", payer.publicKey());

  const server = new rpc.Server(TESTNET.rpcUrl);
  const account = await server.getAccount(payer.publicKey());
  line("ledger seq", account.sequenceNumber());

  // A real SEP-41 transfer: the same call an x402 "exact" payment makes.
  const xlm = new Contract(TESTNET.nativeTokenContractId);
  const transfer = xlm.call(
    "transfer",
    nativeToScVal(payer.publicKey(), { type: "address" }),
    nativeToScVal(payee.publicKey(), { type: "address" }),
    nativeToScVal(1_000_000n, { type: "i128" }), // 0.1 XLM in stroops
  );

  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: TESTNET.networkPassphrase,
  })
    .addOperation(transfer)
    .setTimeout(30)
    .build();

  const settler = createSorobanSettler({ rpcUrls: { [NETWORK]: TESTNET.rpcUrl } });
  const outcome = await settler.simulate({ transactionXdr: tx.toXDR(), network: NETWORK });

  console.log("\n  simulation");
  line("success", String(outcome.success));
  if (!outcome.success) {
    line("error", outcome.error ?? "(none)");
    process.exitCode = 1;
    return;
  }

  line("resource fee", `${outcome.feeStroops.toLocaleString()} stroops`);

  console.log("\n  fee ceilings");
  const plainVsHosted = outcome.feeStroops <= HOSTED_DEFAULT_MAX_FEE_STROOPS;
  line(
    `hosted (${HOSTED_DEFAULT_MAX_FEE_STROOPS.toLocaleString()})`,
    plainVsHosted ? "would sponsor this plain transfer" : "would REFUSE even this plain transfer",
  );
  line(`two-key (${DEFAULT_MAX_FEE_STROOPS.toLocaleString()})`, "sponsors it");

  console.log(
    "\n  A plain transfer is the cheap case. The same transfer routed through a\n" +
      "  smart wallet that runs a spending-limit policy inside __check_auth costs\n" +
      "  materially more — which is why the ceiling is configuration here.\n",
  );
}

main().catch((error: unknown) => {
  console.error("\nfailed:", error instanceof Error ? error.message : error, "\n");
  process.exitCode = 1;
});
