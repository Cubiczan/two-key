/**
 * Install the spending-limit policy WASM on Soroban testnet.
 *
 * This is the prerequisite for the gateway's `/policies/:id/deploy-instance`
 * route: a policy instance is a contract deployed *from* an installed WASM, so
 * the WASM has to exist on-chain first and its hash is what instances point at.
 *
 * The contract is Vellar's own (Apache-2.0), built from source rather than
 * vendored — see `npm run policy:build`. Its hash is simply the sha256 of the
 * bytes, so the value printed here can be checked against the file locally
 * without trusting this script.
 *
 *   npm run policy:build && npm run policy:install
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { BASE_FEE, Keypair, Operation, TransactionBuilder, rpc } from "@stellar/stellar-sdk";
import { TESTNET } from "vellar-sdk";

const WASM_PATH = process.env.POLICY_WASM ?? "build/policy/spending-limit.wasm";

const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;

function line(label: string, value: string): void {
  console.log(`  ${label.padEnd(16)} ${value}`);
}

async function fund(publicKey: string): Promise<void> {
  const res = await fetch(`https://friendbot.stellar.org/?addr=${publicKey}`);
  if (!res.ok && res.status !== 400) throw new Error(`friendbot refused: HTTP ${res.status}`);
}

async function main(): Promise<void> {
  console.log(`\n${bold("two-key")} — install the spending-limit policy WASM\n`);

  const wasm = readFileSync(WASM_PATH);
  // The contract id of an installed WASM is its sha256. Computing it here means
  // the hash can be verified against the file without trusting the network.
  const expected = createHash("sha256").update(wasm).digest("hex");

  line("wasm", WASM_PATH);
  line("bytes", wasm.length.toLocaleString());
  line("sha256", expected);

  const uploader = Keypair.random();
  await fund(uploader.publicKey());
  line("uploader", uploader.publicKey());

  const server = new rpc.Server(TESTNET.rpcUrl);
  const account = await server.getAccount(uploader.publicKey());

  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: TESTNET.networkPassphrase,
  })
    .addOperation(Operation.uploadContractWasm({ wasm }))
    .setTimeout(60)
    .build();

  const simulation = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(simulation)) {
    throw new Error(`simulation failed: ${simulation.error}`);
  }
  line("resource fee", `${Number(simulation.minResourceFee).toLocaleString()} stroops`);

  const prepared = rpc.assembleTransaction(tx, simulation).build();
  prepared.sign(uploader);

  const sent = await server.sendTransaction(prepared);
  if (sent.status === "ERROR") {
    throw new Error(`submission rejected: ${sent.errorResult?.result().switch().name ?? "unknown"}`);
  }

  const settled = await server.pollTransaction(sent.hash, { attempts: 30 });
  if (settled.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
    throw new Error(`upload did not succeed (status ${settled.status})`);
  }

  console.log("");
  line("installed", green("yes"));
  line("tx", sent.hash);
  line("wasm hash", green(expected));
  line("explorer", dim(`https://stellar.expert/explorer/testnet/tx/${sent.hash}`));
  console.log(
    `\n  ${dim("Set POLICY_WASM_HASH to this value; the gateway deploys instances from it.")}\n`,
  );
}

main().catch((error: unknown) => {
  console.error("\nfailed:", error instanceof Error ? error.message : error, "\n");
  process.exitCode = 1;
});
