#!/usr/bin/env bash
# Build Vellar's spending-limit policy contract from source.
#
# The contract is Apache-2.0 and lives in Vellar-Wallet/vellar-dapp. It is built
# rather than vendored: nothing of theirs is copied into this repository, and
# the provenance of the bytes stays obvious.
#
# Needs the pinned toolchain from their workspace (1.94.0 + wasm32v1-none).
set -euo pipefail

SRC="${POLICY_SRC:-.cache/vellar-dapp}"
OUT="build/policy"

if [ ! -d "$SRC" ]; then
  echo "fetching Vellar policy contracts into $SRC"
  git clone --depth 1 --filter=blob:none --sparse \
    https://github.com/Vellar-Wallet/vellar-dapp "$SRC"
  git -C "$SRC" sparse-checkout set contracts
fi

rustup toolchain install 1.94.0 --profile minimal >/dev/null 2>&1 || true
rustup target add wasm32v1-none --toolchain 1.94.0 >/dev/null 2>&1 || true

( cd "$SRC/contracts" && cargo +1.94.0 build --release --target wasm32v1-none \
    -p vela-spending-limit-policy )

mkdir -p "$OUT"
cp "$SRC/contracts/target/wasm32v1-none/release/vela_spending_limit_policy.wasm" \
   "$OUT/spending-limit.wasm"

echo "built  $OUT/spending-limit.wasm  ($(wc -c < "$OUT/spending-limit.wasm" | tr -d ' ') bytes)"
echo "sha256 $(shasum -a 256 "$OUT/spending-limit.wasm" | cut -d' ' -f1)"
