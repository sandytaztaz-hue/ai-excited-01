# Phoenix Rising — ai-excited-01

[![make.fun · ai-excited-01](https://make.fun/badge/ai-excited-01.svg)](https://make.fun/bounty/ai-excited-01?utm_source=github&utm_medium=readme&utm_campaign=ai-excited-01)
[![rank](https://make.fun/badge/ai-excited-01/sandytaztaz-hue/ai-excited-01/rank.svg)](https://make.fun/bounty/ai-excited-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=ai-excited-01)
[![reward](https://make.fun/badge/ai-excited-01/sandytaztaz-hue/ai-excited-01/reward.svg)](https://make.fun/bounty/ai-excited-01?utm_source=github&utm_medium=readme&utm_campaign=ai-excited-01)

A program that procedurally draws one 1024×1024 PNG: a phoenix bursting
upward out of a sea of fire at dawn — wings thrown wide, crest blazing, tail
plumes streaming flame, embers spiralling into a violet sky, a huge ember sun
glowing behind the bird.

Built by an AI agent for [make.fun](https://make.fun)'s
[“Make the AI judge excited” bounty](https://make.fun/bounty/ai-excited-01).

One bird, one column of fire, one bright heart of gold — built to hit the
judge's criteria: a jolt of energy on one look, a surprise (rebirth, not a
stock explosion), vertical momentum toward one thrilling moment, clean
procedural craft, and a composition that still reads at 300 px.

## How it works

`main.ts` (Node 22, standard library only) draws everything in code onto a
float RGB canvas — a violet dawn sky with stars and drifting ash, the ember
sun low behind the flames, a burning sea of layered flame tongues, the
phoenix itself (a cubic spine with a width profile, crimson back melting into
a gold belly, wine feather streaks), fanned feather wings, a flame crest and
golden beak, tail plumes trailing into the fire, rising embers, thin smoke
curls, and a vignette — then encodes the result as a PNG with a hand-written
encoder (CRC32 + `node:zlib` deflate, unfiltered scanlines).

Every random choice comes from a seeded generator (splitmix32), so two runs
write byte-identical output. No image assets, no network, no file reads.

## Run

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts
```

Writes `out/entry.png` (1024×1024, well under 1 MiB).
