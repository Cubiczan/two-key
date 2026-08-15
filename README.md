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

**Pre-event scaffolding.** The VELLAR X STELLAR HACKATHON runs **Aug 26–30, 2026**.

This repository currently contains infrastructure and design only. The product
— the governor bridge, the agent, the x402 payment path, and the demo — is
built during the event window. See [Provenance and timeline](#provenance-and-timeline)
for exactly what predates the event and what does not.

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

Running a policy inside `__check_auth` costs more resource fee than a plain
transfer. Hosted facilitators cap the fee they sponsor — x402.org's default
ceiling is **50,000 stroops** — so every policy-governed payment fails against
the default facilitator. Since policy-governed payments are the entire point
here, the facilitator is self-hosted with a raised ceiling.

This is the single most likely thing to sink a weekend build, which is why it
is stood up first.

## Provenance and timeline

Stated plainly, because the git history is public and judges read it.

**Predates the event, disclosed:**

- The spend governor — a pure `route()` function over (proposal, policy,
  mandates, grounding, clock), with 78 passing tests — originates in
  [icohangar-ops/metabospend](https://github.com/icohangar-ops/metabospend)
  (MIT, published Aug 3 2026, built for a prior hackathon). It is reused here
  under its own licence and adapted to on-chain enforcement.
- This scaffolding, the gateway, and the facilitator (Aug 2026, pre-window).

**Built during the event window (Aug 26–30 2026):**

- The Vellar integration: policy generation and deploy, agent-key minting, the
  x402 payment path.
- The bridge between the governor's decision and on-chain settlement, including
  reconciling an on-chain `PaymentRejectedError` into the same audit trail as
  an off-chain refusal.
- The agent, the demo, and the documentation of both.

Nothing about the Vellar layer is carried in from prior work.

## Licence

MIT — see [LICENSE](LICENSE).
