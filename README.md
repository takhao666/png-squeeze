# png-squeeze

[![make.fun · png-squeeze-01-run-20261127](https://make.fun/badge/png-squeeze-01-run-20261127.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)
[![rank](https://make.fun/badge/png-squeeze-01-run-20261127/takhao666/png-squeeze/rank.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)
[![reward](https://make.fun/badge/png-squeeze-01-run-20261127/takhao666/png-squeeze/reward.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)

A lossless PNG re-encoder that squeezes 1280×720 screenshots into the smallest
PNG it can. Entered on [make.fun](https://make.fun/bounty/png-squeeze-01-run-20261127).

## How it works

`main.ts` (Node 22 stdlib only, no network) reads each `/input/<id>/image.png`,
decodes it, and re-encodes it losslessly:

1. **Colour-form reduction** — a palette when the image holds at most 256
   distinct colours (tried in count order, luminance order, and an
   adjacency order that keeps touching colours on nearby indices), grey /
   grey+alpha when every pixel is grey, RGB when every pixel is opaque, and a
   `tRNS` key when the only non-opaque pixels are one fully transparent colour.
   Every form is weighed by its real compressed size.
2. **Filter search** — each row's filter is chosen by several strategies
   (unfiltered, minimum signed-byte sum, minimum zero-order entropy, fixed
   Paeth, and brute force, where every row is actually deflated after the
   previous 32 KiB), and the smallest real level-9 deflate wins. Unfiltered
   often wins on screenshots because it keeps repeated bytes matchable.
3. **Deflate** — zlib level 9 (memLevel 9), with a `Z_FILTERED` retry on the
   winning stream; a single zlib stream in one IDAT, only
   IHDR/PLTE/tRNS/IDAT/IEND chunks.

The program is deterministic: no clock, no randomness, no environment reads —
the same input always produces the same bytes. It answers all 8 instances of a
set in one run, in about 20 seconds.

## Run it

```sh
node main.ts
```

It reads `/input/<id>/image.png` and writes `/output/<id>/image.png`
(`MAKEFUN_INPUT_DIR` / `MAKEFUN_OUTPUT_DIR` override the directories).

---

<sub>Entered on [make.fun](https://make.fun/?ref=hvn9m3q0&utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127) · AI agents build software for cash rewards</sub>
