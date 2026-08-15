/**
 * The x402 wire and the facilitator's two decisions.
 *
 * The fee-ceiling cases are the ones that matter most: they encode the single
 * reason this facilitator is self-hosted at all.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DEFAULT_MAX_FEE_STROOPS,
  HOSTED_DEFAULT_MAX_FEE_STROOPS,
  createFacilitator,
  type Settler,
} from "@/x402/facilitator";
import {
  ProtocolError,
  assertOffer,
  decodePaymentSignature,
  encodeHeader,
  paymentRequired,
  settled,
  type PaymentRequirements,
} from "@/x402/protocol";

const ASSET = "CA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ";
const PAY_TO = "GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ";
const HASH = "a".repeat(64);

function offer(over: Partial<PaymentRequirements> = {}): PaymentRequirements {
  return {
    scheme: "exact",
    network: "stellar:testnet",
    asset: ASSET,
    amount: "1000000",
    payTo: PAY_TO,
    maxTimeoutSeconds: 120,
    extra: { areFeesSponsored: true },
    ...over,
  } as PaymentRequirements;
}

function header(over: Partial<PaymentRequirements> = {}, transaction = "AAAAenvelope"): string {
  return encodeHeader({ x402Version: 2, accepted: offer(over), payload: { transaction } });
}

function settler(over: Partial<Settler> & { fee?: number; ok?: boolean; error?: string } = {}): Settler {
  return {
    async simulate() {
      return {
        success: over.ok ?? true,
        feeStroops: over.fee ?? 120_000,
        ...(over.error ? { error: over.error } : {}),
      };
    },
    async submit() {
      return { hash: HASH };
    },
    ...over,
  };
}

describe("protocol — the rules the SDK enforces silently", () => {
  it("refuses an offer that omits areFeesSponsored", () => {
    // The client drops such offers and reports "no usable payment option",
    // naming nothing. Better to fail here, at the field.
    assert.throws(
      () => assertOffer({ ...offer(), extra: {} } as PaymentRequirements),
      /areFeesSponsored/,
    );
  });

  it("refuses areFeesSponsored: false just as firmly", () => {
    assert.throws(
      () => assertOffer({ ...offer(), extra: { areFeesSponsored: false } } as never),
      /areFeesSponsored/,
    );
  });

  it("refuses the SDK's own network name in place of CAIP-2", () => {
    assert.throws(() => assertOffer(offer({ network: "testnet" as never })), /CAIP-2/);
  });

  it("refuses a decimal amount, which parseAmount would reject downstream", () => {
    assert.throws(() => assertOffer(offer({ amount: "1.5" })), /integer/);
  });

  it("refuses a zero amount", () => {
    assert.throws(() => assertOffer(offer({ amount: "0" })), /greater than zero/);
  });

  it("round-trips a challenge", () => {
    const body = paymentRequired([offer()]);
    assert.equal(body.accepts.length, 1);
    assert.equal(body.accepts[0]!.extra.areFeesSponsored, true);
  });

  it("refuses a challenge offering nothing", () => {
    assert.throws(() => paymentRequired([]), /at least one/);
  });

  it("refuses a settlement hash the client would call indeterminate", () => {
    // A success carrying a malformed hash is the worst outcome available: the
    // payer cannot tell whether their money moved.
    assert.throws(() => settled("not-a-hash"), /64 hex/);
    assert.deepEqual(settled(HASH), { success: true, transaction: HASH });
  });

  it("refuses a payment signature at the wrong protocol version", () => {
    const bad = encodeHeader({ x402Version: 1, accepted: offer(), payload: { transaction: "x" } });
    assert.throws(() => decodePaymentSignature(bad), ProtocolError);
  });

  it("refuses a payment signature carrying no envelope", () => {
    const bad = encodeHeader({ x402Version: 2, accepted: offer(), payload: {} });
    assert.throws(() => decodePaymentSignature(bad), /transaction/);
  });
});

describe("facilitator — the fee ceiling", () => {
  it("is configured an order of magnitude above the hosted default", () => {
    // The premise of the project: a policy-governed payment cannot settle
    // against a facilitator using the hosted ceiling.
    assert.ok(DEFAULT_MAX_FEE_STROOPS > HOSTED_DEFAULT_MAX_FEE_STROOPS * 5);
  });

  it("refuses a policy-governed fee that would pass on a plain transfer", async () => {
    const f = createFacilitator({
      settler: settler({ fee: 120_000 }),
      network: "stellar:testnet",
      maxFeeStroops: HOSTED_DEFAULT_MAX_FEE_STROOPS,
    });

    const result = await f.verify(header());
    assert.equal(result.isValid, false);
    assert.match(result.invalidReason!, /exceeds this facilitator's ceiling/);
    assert.match(result.invalidReason!, /FACILITATOR_MAX_FEE_STROOPS/);
  });

  it("accepts the same payment once the ceiling is raised", async () => {
    const f = createFacilitator({
      settler: settler({ fee: 120_000 }),
      network: "stellar:testnet",
    });

    const result = await f.verify(header());
    assert.equal(result.isValid, true);
    assert.equal(result.feeStroops, 120_000);
  });

  it("refuses to be built with a nonsense ceiling", () => {
    assert.throws(
      () => createFacilitator({ settler: settler(), network: "stellar:testnet", maxFeeStroops: 0 }),
      /positive integer/,
    );
  });
});

describe("facilitator — verify", () => {
  const f = () => createFacilitator({ settler: settler(), network: "stellar:testnet" });

  it("reports an on-chain policy refusal as a refusal, not a fault", async () => {
    const withRefusal = createFacilitator({
      settler: settler({ ok: false, error: "policy: daily limit exceeded", fee: 118_000 }),
      network: "stellar:testnet",
    });

    const result = await withRefusal.verify(header());
    assert.equal(result.isValid, false);
    assert.equal(result.invalidReason, "policy: daily limit exceeded");
  });

  it("refuses a payment for another network", async () => {
    const result = await f().verify(header({ network: "stellar:pubnet" }));
    assert.equal(result.isValid, false);
    assert.match(result.invalidReason!, /settles stellar:testnet/);
  });

  it("refuses an offer the payer wrote for themselves", async () => {
    // Without comparing against what we offered, a payer could sign a transfer
    // of one stroop to their own address and it would verify perfectly.
    const result = await f().verify(header({ amount: "1", payTo: PAY_TO }), {
      amount: "1000000",
      asset: ASSET,
    });

    assert.equal(result.isValid, false);
    assert.match(result.invalidReason!, /amount does not match the offer/);
  });

  it("accepts a payment matching the offer exactly", async () => {
    const result = await f().verify(header(), { amount: "1000000", asset: ASSET, payTo: PAY_TO });
    assert.equal(result.isValid, true);
  });

  it("refuses a malformed header without throwing", async () => {
    const result = await f().verify("not base64 json at all");
    assert.equal(result.isValid, false);
    assert.ok(result.invalidReason);
  });
});

describe("facilitator — settle", () => {
  it("returns a hash the client will read as settled", async () => {
    const f = createFacilitator({ settler: settler(), network: "stellar:testnet" });
    const result = await f.settle(header());

    assert.equal(result.success, true);
    assert.equal(result.transaction, HASH);
  });

  it("never submits when verification fails, and says so without a hash", async () => {
    let submitted = 0;
    const f = createFacilitator({
      settler: {
        ...settler({ fee: 900_000 }),
        async submit() {
          submitted++;
          return { hash: HASH };
        },
      },
      network: "stellar:testnet",
    });

    const result = await f.settle(header());

    assert.equal(submitted, 0);
    assert.equal(result.success, false);
    // No hash: the client classifies this as "not spent" rather than
    // "fees were charged".
    assert.equal(result.transaction, undefined);
  });

  it("distinguishes a submission failure from a refusal", async () => {
    const f = createFacilitator({
      settler: {
        ...settler(),
        async submit() {
          throw new Error("rpc timeout");
        },
      },
      network: "stellar:testnet",
    });

    const result = await f.settle(header());
    assert.equal(result.success, false);
    assert.match(result.errorReason!, /submission failed after verification/);
  });

  it("advertises what it will sponsor", () => {
    const f = createFacilitator({
      settler: settler(),
      network: "stellar:testnet",
      maxFeeStroops: 750_000,
    });

    assert.deepEqual(f.capabilities(), {
      network: "stellar:testnet",
      scheme: "exact",
      maxFeeStroops: 750_000,
    });
  });
});
