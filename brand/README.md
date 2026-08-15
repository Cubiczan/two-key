# Brand

Two keyholes, lit in two different colours — the mark is the thesis. Neither
keyhole is the primary one; a spend is a reflex only when both turn.

| File | Use |
| --- | --- |
| `logo.svg` | Source of truth for the mark. Scales to any size. |
| `logo-1024.png` `logo-512.png` `logo-256.png` | Submission and profile uploads. |
| `wordmark.svg` | Source of truth for the horizontal lockup. |
| `wordmark-1360.png` | Banners, slide headers, README headers. |

## Colour

| Token | Hex | Meaning |
| --- | --- | --- |
| Ground | `#131A2E` → `#080C18` | Background gradient. |
| Off-chain key | `#FFC978` → `#F0912B` | The governor: whether the spend *should* happen. |
| On-chain key | `#7BF3DC` → `#22B99E` | The Vellar policy: whether it *can*. |
| Text | `#F4F6FB` | Wordmark. |
| Muted text | `#8A97B4` | Tagline. |

The two key colours are load-bearing, not decorative — they map to the two
authorities described in the root README, and the same pairing is used
consistently wherever the two layers are shown side by side. Do not recolour one
without the other.

## Regenerating the PNGs

No SVG rasteriser is assumed; macOS Quick Look does the work.

```sh
cd brand
for s in 1024 512 256; do qlmanage -t -s $s -o . logo.svg && mv logo.svg.png logo-$s.png; done
```

The wordmark needs a square wrapper first, because the thumbnailer always emits
a square canvas and places a wide image ambiguously within it. Wrap `wordmark.svg`
centred in a 1360×1360 canvas, render at 1360, then `sips -c 360 1360`.
