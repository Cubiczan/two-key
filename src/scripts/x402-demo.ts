/**
 * An x402 payment, end to end, against Soroban testnet.
 *
 * Everything here is real: a resource server that refuses without payment, a
 * payment built and signed by vellar-sdk's own x402 client, a facilitator that
 * simulates and enforces its fee ceiling, and a transaction that settles on
 * testnet and comes back with a hash you can look up.
 *
 * What is NOT here is the second key. The payer is a classic ed25519 account,
 * not a passkey smart wallet, so no policy runs inside __check_auth and
 * nothing caps the spend on-chain. This demonstrates the x402 half honestly.
 *
 *   npm run demo:x402
 */

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { Keypair } from "@stellar/stellar-sdk";
import { TESTNET, createX402Client } from "vellar-sdk";

import { createClassicAccountSigner } from "@/x402/classic-signer";
import { createFacilitator, HOSTED_DEFAULT_MAX_FEE_STROOPS } from "@/x402/facilitator";
import { createPaywall } from "@/x402/resource";
import { createSponsoredSorobanSettler } from "@/x402/soroban-settler";
import type { PaymentRequirements } from "@/x402/protocol";

const NETWORK = "stellar:testnet" as const;
const PRICE_STROOPS = 1_000_000n; // 0.1 XLM

const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;

function line(label: string, value: string): void {
  console.log(`  ${label.padEnd(20)} ${value}`);
}

async function fund(publicKey: string): Promise<void> {
  const res = await fetch(`https://friendbot.stellar.org/?addr=${publicKey}`);
  if (!res.ok && res.status !== 400) {
    throw new Error(`friendbot refused ${publicKey}: HTTP ${res.status}`);
  }
}

async function main(): Promise<void> {
  console.log(`\n${bold("two-key")} — x402 payment on Soroban testnet\n`);

  // --- Accounts -----------------------------------------------------------
  const payer = Keypair.random();
  const merchant = Keypair.random();
  const sponsor = Keypair.random();

  await Promise.all([fund(payer.publicKey()), fund(merchant.publicKey()), fund(sponsor.publicKey())]);

  line("payer", payer.publicKey());
  line("merchant", merchant.publicKey());
  line("sponsor", `${sponsor.publicKey()} ${dim("(pays the fee)")}`);
  line("asset", `XLM ${dim(TESTNET.nativeTokenContractId)}`);

  // --- The resource server ------------------------------------------------
  const price: PaymentRequirements = {
    scheme: "exact",
    network: NETWORK,
    asset: TESTNET.nativeTokenContractId,
    amount: PRICE_STROOPS.toString(),
    payTo: merchant.publicKey(),
    maxTimeoutSeconds: 60,
    extra: { areFeesSponsored: true },
  };

  const settler = createSponsoredSorobanSettler({
    rpcUrl: TESTNET.rpcUrl,
    network: NETWORK,
    sponsor,
  });

  const paywall = createPaywall({
    price,
    facilitator: createFacilitator({ settler, network: NETWORK }),
  });

  const server = createServer((req, res) => {
    void (async () => {
      const header = req.headers["payment-signature"];
      const result = await paywall.gate(typeof header === "string" ? header : undefined);

      if (!result.allowed) {
        console.log(
          `  ${dim("server")}             402 ${result.reason ? red(result.reason) : dim("payment required")}`,
        );
        res.writeHead(402, { ...result.headers, "content-type": "application/json" });
        res.end(JSON.stringify({ error: "payment required" }));
        return;
      }

      res.writeHead(200, { ...result.headers, "content-type": "application/json" });
      res.end(JSON.stringify({ report: "Q3 supplier risk index", rows: 1284 }));
    })();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${port}/reports/supplier-risk`;

  // --- The agent ----------------------------------------------------------
  // vellar-sdk's own client. It decodes the 402, builds the SEP-41 transfer,
  // checks the auth entry against what it intended to pay, signs, and retries.
  const client = createX402Client({
    signer: createClassicAccountSigner({ keypair: payer }),
    rpcUrl: TESTNET.rpcUrl,
    network: "testnet",
    // Deliberately NOT the payer. When the payer also sources the envelope,
    // Soroban authorises implicitly via source-account credentials and emits
    // no address-credential entry — so there is nothing for the signer to
    // sign, and the SDK reports "no wallet auth entry found". A separate
    // source forces the payer's authorisation to be explicit.
    simulationSourceAccount: sponsor.publicKey(),
  });

  console.log(`\n${bold("  1. agent fetches a paid resource")}`);
  const started = Date.now();
  const { response, paid, settlement } = await client.fetch(url, {
    maxAmount: 5_000_000n, // 0.5 XLM client-side guard
  });

  const body = (await response.json()) as Record<string, unknown>;

  console.log(`\n${bold("  2. settled")}`);
  line("paid", paid ? green("yes") : "no");
  line("amount", `${Number(PRICE_STROOPS) / 1e7} XLM`);
  line("tx", green(settlement?.transaction ?? "(none)"));
  line("elapsed", `${((Date.now() - started) / 1000).toFixed(1)}s`);
  line("resource", JSON.stringify(body));
  if (settlement?.transaction) {
    line("explorer", dim(`https://stellar.expert/explorer/testnet/tx/${settlement.transaction}`));
  }

  // --- The fee ceiling, measured -----------------------------------------
  // Sign a second payment but do not send it: createPayment signs without
  // transport, so the ceiling can be exercised without spending again.
  console.log(`\n${bold("  3. the fee ceiling")}`);

  const unsent = await client.createPayment(price, { maxAmount: 5_000_000n });

  const quote = await createFacilitator({ settler, network: NETWORK }).verify(unsent.header, price);
  const fee = quote.feeStroops ?? 0;
  line("quoted fee", `${fee.toLocaleString()} stroops`);

  // What the hosted default would do with THIS payment. Honest answer: allow
  // it. A plain classic-account transfer is the cheap case.
  const hosted = await createFacilitator({
    settler,
    network: NETWORK,
    maxFeeStroops: HOSTED_DEFAULT_MAX_FEE_STROOPS,
  }).verify(unsent.header, price);

  line(
    `hosted (${HOSTED_DEFAULT_MAX_FEE_STROOPS.toLocaleString()})`,
    hosted.isValid ? "allows it" : red("refuses it"),
  );

  // The mechanism itself, exercised against a ceiling below the real quote.
  const tight = await createFacilitator({
    settler,
    network: NETWORK,
    maxFeeStroops: Math.max(1, fee - 1),
  }).verify(unsent.header, price);

  line(`ceiling (${Math.max(1, fee - 1).toLocaleString()})`, tight.isValid ? "allows it" : green("refuses it"));
  if (!tight.isValid) line("reason", dim((tight.invalidReason ?? "").slice(0, 120)));

  console.log(
    `\n  ${dim("A plain transfer clears the hosted ceiling with room to spare — measured,")}\n` +
      `  ${dim("not assumed. The ceiling is expected to bite only once a spending-limit")}\n` +
      `  ${dim("policy runs inside __check_auth, which needs a passkey smart wallet.")}\n` +
      `  ${dim("That multiplier is not measured yet, and this demo does not claim it.")}`,
  );

  server.close();
  console.log("");
}

main().catch((error: unknown) => {
  console.error(`\n${red("failed:")}`, error instanceof Error ? error.stack : error, "\n");
  process.exitCode = 1;
});
