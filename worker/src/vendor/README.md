# Opus runtime for Cloudflare Workers

`opusscript.cjs` is the Emscripten glue from **opusscript 0.1.1**, with two
changes required by Workers:

- Disable Node filesystem detection. The Wasm module is imported statically by
  `../opusEncoder.ts` from the installed package.
- Replace the embind `rb` invoker generator (and remove `qb`) with an equivalent
  closure. Upstream uses the Function constructor, which Workers disallows.

The codec binary is unchanged. License notices are included here.
Regenerate from the installed opusscript 0.1.1 with
`python3 scripts/prepare-opus-vendor.py`, then run `npm run test:opus`.
The patched glue and Wasm must come from the same package version.

The native `_encode` bridge expects each little-endian PCM byte widened into a
separate `HEAPU16` slot. It then repacks two slots into one PCM16 sample. Its
second argument controls that repacking loop: pass the sample count, not the
byte count, and allocate two bytes for every input byte. Writing packed PCM to
`HEAPU8` produces valid Opus packets containing corrupted audio.

`tests/fish-opus.test.mjs` verifies every packet against the package's public
encoder API using Fish Audio speech, while `tests/opus-stream.test.mjs` verifies
signal correlation. Merely decoding packets successfully is insufficient.
