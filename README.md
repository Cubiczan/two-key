# Two-Key

> **A spend is a reflex only when both keys turn.**

An autonomous agent that pays for what it needs over [x402](https://x402.org),
bounded by two independent authorities that must both agree before money moves:

- **Off-chain, a governor decides whether the spend _should_ happen.** Is the
  money well-formed? Is the merchant on policy? Can the agent cite the policy
  that authorizes this class of purchase? A proposal that fails any of these is
  refused before anything is signed.
- **On-chain, a Vellar spending-limit policy decides whether it _can_.** The
  agent holds a scoped ed25519 session key whose authority is enforced inside
  the smart wallet's `__check_auth`. A compromised agent holding that key still
  cannot exceed its budget or pay through unverified code.

Neither layer trusts the other. The governor can be wrong and the chain still
refuses; the chain can be permissive and the governor still refuses. Every
decision from both layers lands in the same signed, append-only ledger.

Built on [`vellar-sdk`](https://github.com/Vellar-Wallet/vellar-sdk) — passkey
smart wallets, programmable on-chain policies, and agentic x402 payments on
Stellar / Soroban.

---

## Status

Built for the VELLAR X STELLAR HACKATHON (**Aug 26–30, 2026**), with work
starting ahead of the window — the git history shows the real dates and this
README does not pretend otherwise. See
[Provenance and timeline](#provenance-and-timeline).

**Both keys work, on Soroban testnet.** Three proposals from one agent: one
clears both keys and settles on-chain, one is refused by the governor and never
reaches the chain, one the governor approves and the chain refuses. All three
land in one signed ledger.

```
  1. both keys turn
     governor       auto
     chain          settled
     tx             7302fee3e903b15e71e57bdaf7606ce1c140e83908dfc5ee1095958a58029eea

  2. the off-chain key refuses — the chain is never asked
     governor       blocked
     reason         merchant_not_allowed
     chain asked    no
     spent          nothing

  3. the governor approves — the on-chain key refuses
     governor       auto
     chain          refused
     reason         resource fee 30591 stroops exceeds this facilitator's ceiling of 1

  one ledger, both authorities
      0  governor p-1  auto
      1  chain    p-1  auto     7302fee3e903…
      2  governor p-2  blocked
      3  governor p-3  auto
      4  chain    p-3  blocked
     chain valid    yes — 5 entries
```

Case 2 is the ordering guarantee, and it is the one worth watching: a spend the
governor refuses costs nothing, because the chain is never asked. A test pins
it — if that ever regresses the system still *looks* right, refusing the same
spends, while paying fees to discover what the governor already knew.

Case 3 is the second key turning. Here it is forced with an absurd fee ceiling
rather than a real spending-limit policy, because the policy needs a passkey
smart wallet. The path the refusal travels is the real one.

**The x402 half in isolation** — `npm run demo:x402`:

```
  1. agent fetches a paid resource
  server             402 payment required

  2. settled
  paid                 yes
  amount               0.1 XLM
  tx                   c6594931c66240e1f49da390a9822b8556f2f2875f67426060ef1c252ce97604
  elapsed              6.6s
  resource             {"report":"Q3 supplier risk index","rows":1284}

  3. the fee ceiling
  quoted fee           30,591 stroops
  hosted (50,000)      allows it
  ceiling (30,590)     refuses it
```

Verified on-chain — [`beeb5774…`](https://stellar.expert/explorer/testnet/tx/beeb5774590ab95a75d454c6173078585eb23156cc374799a49819aa1fcf127b)
settled in ledger 4155333 with 20,554 stroops of fee paid by the sponsor.

```sh
npm install
npm test              # 57 tests, no network
npm run demo          # both keys, against live testnet
npm run demo:x402     # the x402 half in isolation
npm run testnet:check # simulate a transfer, print the network's fee quote
npm run gateway       # http://localhost:8787
```

**What is not built.** The on-chain key is currently a fee ceiling standing in
for a spending-limit policy. The payer is a classic ed25519 account, not a
passkey smart wallet, so nothing runs inside `__check_auth` and no budget is
enforced on-chain. The refusal path is real; the thing doing the refusing is
not yet the policy.

One blocker remains, and it is a shape rather than an unknown. `agents.mint`
and `policies.deploy` are passkey-signed wallet-admin actions — WebAuthn,
browser-only, with no silent-signing path — so they cannot run from a script
and need a small browser page. The policy contracts themselves are public Rust
source in
[Vellar-Wallet/vellar-dapp](https://github.com/Vellar-Wallet/vellar-dapp/tree/main/contracts/policy-templates)
(`spending-limit`, `token-spending-limit`, `verified-recipient`), so the WASM
this gateway needs to deploy an instance can be built rather than waited for.

## Why two keys

The failure mode this exists to close: an agent with a budget is still an agent
with a reason to spend. An on-chain cap alone stops a *runaway*, not a *wrong*
purchase — an agent can burn its entire legitimate budget on something no policy
ever authorized, and the chain will happily settle every transaction.

Conversely, off-chain governance alone is only as trustworthy as the process
holding the keys. If the governor is bypassed, nothing is enforcing anything.

Two keys, held by different kinds of authority, is the smallest arrangement in
which neither failure is sufficient on its own.

## Architecture

```
  agent proposes a spend
          │
          ▼
  ┌───────────────────┐   refuse   ┌──────────────────┐
  │  governor (off-   │───────────▶│  signed ledger   │
  │  chain): money    │            │  (audit trail)   │
  │  well-formed?     │            └──────────────────┘
  │  merchant on      │                     ▲
  │  policy? policy   │                     │
  │  citation?        │                     │
  └─────────┬─────────┘                     │
            │ auto                          │
            ▼                               │
  ┌───────────────────┐                     │
  │  vellar x402:     │   settled / refused │
  │  session key      │─────────────────────┘
  │  signs headlessly │
  └─────────┬─────────┘
            │
            ▼
  ┌───────────────────────────────────────────┐
  │  Soroban smart wallet — __check_auth      │
  │  spending-limit policy  ∧  verified-only  │
  │  the chain refuses above the cap          │
  └───────────────────────────────────────────┘
```

## Infrastructure

`vellar-sdk` never submits transactions itself and never holds secrets, so two
services must exist before any of the above runs. Both are operated, not
submitted — they are the reason this scaffolding predates the event.

### 1. Wallet + policy gateway

Holds an OpenZeppelin Relayer API key and a funded sponsor account, and exposes:

| Route | Purpose |
| --- | --- |
| `POST /wallet/create` | Submit the deployment tx; store keyId→contract |
| `POST /wallet/connect` | Resolve the smart account for a known passkey |
| `POST /wallet/submit` | Submit an already-signed transaction |
| `GET /policies/templates` | Available policy templates |
| `POST /policies/validate` | Validate a policy definition |
| `POST /policies/generate` | Generate policy artifacts |
| `POST /policies/:id/simulate` | Dry-run, no submit |
| `POST /policies/:id/deploy-instance` | Sponsor-funded instance deploy |
| `POST /policies/deploy` | Record the completed attach |

Must CORS-allow the app origin.

### 2. Self-hosted x402 facilitator

Built, and the reason it is self-hosted is worth stating carefully, because the
measurement changed the claim.

Running a policy inside `__check_auth` costs more resource fee than a plain
transfer, and hosted facilitators cap the fee they sponsor — x402.org's default
ceiling is **50,000 stroops**. The inference is that a policy-governed payment
fails there.

What we have actually measured is the floor, not the multiplier. A plain
SEP-41 transfer simulates at **~23,500 stroops**, and the payment settled above
quoted **30,591** — both comfortably inside the hosted ceiling. So the overhead
of running a policy has to exceed roughly **1.6×** to break it. Vellar documents
that it does; we cannot confirm it until a policy is attached to a real smart
wallet, and this repository does not claim otherwise.

The mechanism itself is proven either way: `npm run demo:x402` exercises the
ceiling against a real fee quote and shows the same payment allowed above it and
refused below it.

The facilitator also rebuilds before submitting, which is what a facilitator
fundamentally is. The payer signs an *auth entry*, not an envelope — the
envelope the client produces is sourced by a simulation account that never
signs it. So the invocation, carrying the payer's signed auth entry verbatim, is
lifted into a fresh transaction sourced and signed by the sponsor. The payer's
signature still covers exactly the transfer they authorised; only the fee payer
changes.

## Provenance and timeline

Stated plainly, because the git history is public and judges read it.

**Carried in from prior work:**

- The spend governor — a pure `route()` function over (proposal, policy,
  mandates, grounding, clock), with 78 passing tests — originates in
  [icohangar-ops/metabospend](https://github.com/icohangar-ops/metabospend)
  (MIT, published Aug 3 2026, built for a prior hackathon). It is reused here
  under its own licence and adapted to on-chain enforcement. Its lane model —
  `auto` / `approval` / `blocked` — becomes the off-chain key described above.

**Written for this event, starting before the window opened:**

- Everything else in this repository, beginning with the gateway (Aug 15 2026).
- The Vellar layer specifically — policy generation and deploy, agent-key
  minting, the x402 payment path, and the bridge that reconciles an on-chain
  `PaymentRejectedError` into the same audit trail as an off-chain refusal — is
  new here and carried in from nothing.

The commit dates are what they are, and are stated here rather than left to be
discovered. If the event requires all work inside Aug 26–30, this repository
does not meet that bar and says so plainly.

## Licence

MIT — see [LICENSE](LICENSE).
