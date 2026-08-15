/**
 * Both keys, on testnet.
 *
 * Three proposals from the same agent. One clears both keys and settles
 * on-chain. One is refused by the governor and never reaches the chain at all.
 * One the governor approves and the chain refuses. All three land in one
 * signed, append-only ledger, which is verified at the end.
 *
 *   npm run demo
 */

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { Keypair } from "@stellar/stellar-sdk";
import { TESTNET, createX402Client } from "vellar-sdk";

import { execute } from "@/bridge";
import type { AgentPolicy, Grounding, Mandate, SpendProposal } from "@/governor/types";
import { createLedger } from "@/ledger";
import { createClassicAccountSigner } from "@/x402/classic-signer";
import { createFacilitator } from "@/x402/facilitator";
import type { PaymentRequirements } from "@/x402/protocol";
import { createPaywall } from "@/x402/resource";
import { createSponsoredSorobanSettler } from "@/x402/soroban-settler";

const NETWORK = "stellar:testnet" as const;
const PRICE_STROOPS = 1_000_000n; // 0.1 XLM per fetch

const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const amber = (s: string) => `\x1b[33m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;

function line(label: string, value: string): void {
  console.log(`     ${label.padEnd(14)} ${value}`);
}

async function fund(publicKey: string): Promise<void> {
  const res = await fetch(`https://friendbot.stellar.org/?addr=${publicKey}`);
  if (!res.ok && res.status !== 400) throw new Error(`friendbot refused: HTTP ${res.status}`);
}

const policy: AgentPolicy = {
  agent: "research-agent",
  autoExecuteCap: "25.00",
  currency: "USD",
  allowedMerchants: ["127.0.0.1"],
  requiresGroundedPolicy: true,
};

const grounded: Grounding = {
  cited: true,
  citations: [{ source: "procurement-policy-v4", excerpt: "Market data subscriptions under $25 are pre-authorized." }],
};

function proposal(over: Partial<SpendProposal>): SpendProposal {
  return {
    id: "p-1",
    agent: "research-agent",
    kind: "purchase",
    merchant: { name: "Supplier Risk API", url: "http://127.0.0.1/reports", country: "US" },
    total: "10.00",
    currency: "USD",
    items: [{ description: "Q3 supplier risk index", unit_price: "10.00", quantity: 1 }],
    rationale: "Quarterly supplier review needs the current risk index.",
    ...over,
  };
}

async function main(): Promise<void> {
  console.log(`\n${bold("two-key")} — both keys, on Soroban testnet\n`);

  const payer = Keypair.random();
  const merchant = Keypair.random();
  const sponsor = Keypair.random();
  const auditor = Keypair.random(); // signs the ledger

  await Promise.all([fund(payer.publicKey()), fund(merchant.publicKey()), fund(sponsor.publicKey())]);
  line("payer", payer.publicKey());
  line("cap", `${policy.autoExecuteCap} ${policy.currency} per spend, merchants: ${String(policy.allowedMerchants)}`);

  const price: PaymentRequirements = {
    scheme: "exact",
    network: NETWORK,
    asset: TESTNET.nativeTokenContractId,
    amount: PRICE_STROOPS.toString(),
    payTo: merchant.publicKey(),
    maxTimeoutSeconds: 60,
    extra: { areFeesSponsored: true },
  };

  const settler = createSponsoredSorobanSettler({ rpcUrl: TESTNET.rpcUrl, network: NETWORK, sponsor });

  /** A resource server. `ceiling` lets us stand up a stingy one for case 3. */
  async function serve(ceiling?: number): Promise<string> {
    const paywall = createPaywall({
      price,
      facilitator: createFacilitator({
        settler,
        network: NETWORK,
        ...(ceiling === undefined ? {} : { maxFeeStroops: ceiling }),
      }),
    });

    const server = createServer((req, res) => {
      void (async () => {
        const h = req.headers["payment-signature"];
        const r = await paywall.gate(typeof h === "string" ? h : undefined);
        res.writeHead(r.allowed ? 200 : 402, { ...r.headers, "content-type": "application/json" });
        res.end(JSON.stringify(r.allowed ? { report: "Q3 supplier risk index", rows: 1284 } : { error: "payment required" }));
      })();
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    servers.push(server);
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}/reports`;
  }

  const servers: ReturnType<typeof createServer>[] = [];
  const generousUrl = await serve();

  const client = createX402Client({
    signer: createClassicAccountSigner({ keypair: payer }),
    rpcUrl: TESTNET.rpcUrl,
    network: "testnet",
    simulationSourceAccount: sponsor.publicKey(),
  });

  const ledger = createLedger({ signer: auditor });
  const now = new Date();

  const mandates: Mandate[] = [
    {
      id: "m-1",
      scope: "listed",
      merchantUrl: "http://127.0.0.1/reports",
      remaining: "500.00",
      currency: "USD",
      validUntil: new Date(now.getTime() + 30 * 864e5).toISOString(),
      frequency: "monthly",
    },
  ];

  const pay = (url: string) => async () =>
    client.fetch(url, { maxAmount: 5_000_000n }).then((r) => ({
      paid: r.paid,
      ...(r.settlement ? { settlement: { transaction: r.settlement.transaction } } : {}),
    }));

  // --- 1. Both keys agree -------------------------------------------------
  console.log(`\n${bold("  1. both keys turn")}`);
  const ok = await execute(
    { ledger },
    { proposal: proposal({ id: "p-1" }), policy, mandates, grounding: grounded, now },
    pay(generousUrl),
  );
  line("governor", ok.decision.lane === "auto" ? green("auto") : ok.decision.lane);
  line("chain", ok.kind === "settled" ? green("settled") : red(ok.kind));
  if (ok.kind === "settled") {
    line("tx", green(ok.transaction));
    line("explorer", dim(`https://stellar.expert/explorer/testnet/tx/${ok.transaction}`));
  }

  // --- 2. The governor refuses -------------------------------------------
  console.log(`\n${bold("  2. the off-chain key refuses — the chain is never asked")}`);
  let chainWasAsked = false;
  const blocked = await execute(
    { ledger },
    {
      proposal: proposal({
        id: "p-2",
        merchant: { name: "Unknown Vendor", url: "http://malicious.example/data", country: "US" },
      }),
      policy,
      mandates,
      grounding: grounded,
      now,
    },
    async () => {
      chainWasAsked = true;
      return { paid: false };
    },
  );
  line("governor", amber(blocked.decision.lane));
  line("reason", dim(blocked.decision.reasons.map((r) => r.code).join(", ")));
  line("chain asked", chainWasAsked ? red("yes — bug") : green("no"));
  line("spent", green("nothing"));

  // --- 3. The chain refuses ----------------------------------------------
  console.log(`\n${bold("  3. the governor approves — the on-chain key refuses")}`);
  const stingyUrl = await serve(1); // a ceiling no real fee can clear
  const onChain = await execute(
    { ledger },
    { proposal: proposal({ id: "p-3" }), policy, mandates, grounding: grounded, now },
    pay(stingyUrl),
  );
  line("governor", green(onChain.decision.lane));
  line("chain", onChain.kind === "refused-on-chain" ? amber("refused") : red(onChain.kind));
  if (onChain.kind === "refused-on-chain") {
    line("reason", dim(onChain.reason.replace(/\s+/g, " ").slice(0, 110)));
  }

  // --- The ledger ---------------------------------------------------------
  console.log(`\n${bold("  one ledger, both authorities")}`);
  for (const e of ledger.entries()) {
    const tx = e.transaction ? ` ${dim(e.transaction.slice(0, 12) + "…")}` : "";
    console.log(
      `     ${String(e.seq).padStart(2)}  ${e.authority.padEnd(8)} ${e.proposalId}  ${e.lane.padEnd(8)}${tx}`,
    );
  }

  const report = ledger.verify();
  line("", "");
  line("chain valid", report.valid ? green(`yes — ${report.length} entries`) : red(report.reason));

  for (const s of servers) s.close();
  console.log("");
}

main().catch((error: unknown) => {
  console.error(`\n${red("failed:")}`, error instanceof Error ? error.stack : error, "\n");
  process.exitCode = 1;
});
