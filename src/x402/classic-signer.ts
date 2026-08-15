/**
 * An x402 signer backed by a plain ed25519 keypair.
 *
 * `SmartAccountX402Signer` is structural — the SDK's own comment says callers
 * may supply their own — so this satisfies it with a classic `G…` account
 * instead of a passkey smart wallet. That lets the real `createX402Client`
 * from vellar-sdk drive a payment with no browser and no WebAuthn.
 *
 * What it deliberately is NOT: the on-chain budget. A classic account carries
 * no policy contracts, so nothing runs inside `__check_auth` and nothing caps
 * the spend. This proves the x402 half of the system end to end; the second
 * key arrives with the smart wallet.
 */

import { Keypair, authorizeEntry, xdr } from "@stellar/stellar-sdk";
import type { SmartAccountX402Signer } from "vellar-sdk";

export interface ClassicSignerOptions {
  /** The account that pays. Its secret never leaves this process. */
  keypair: Keypair;
}

export function createClassicAccountSigner(options: ClassicSignerOptions): SmartAccountX402Signer {
  const { keypair } = options;

  return {
    address: keypair.publicKey(),

    async signAuthEntry(entryXdr, { networkPassphrase, expirationLedger }) {
      const entry = xdr.SorobanAuthorizationEntry.fromXDR(entryXdr, "base64");

      // authorizeEntry sets the signature-expiration ledger and signs the
      // credential preimage. The SDK checked the entry's invocation against
      // what it intended to pay before handing it here, so this signs exactly
      // the transfer that was reviewed.
      const signed = await authorizeEntry(entry, keypair, expirationLedger, networkPassphrase);

      return signed.toXDR("base64");
    },
  };
}
