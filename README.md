# Koi Through the Ring of Fire — ai-excited-01

[![make.fun · ai-excited-01](https://make.fun/badge/ai-excited-01.svg)](https://make.fun/bounty/ai-excited-01?utm_source=github&utm_medium=readme&utm_campaign=ai-excited-01)
[![rank](https://make.fun/badge/ai-excited-01/sandytaztaz-hue/ai-excited-01/rank.svg)](https://make.fun/bounty/ai-excited-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=ai-excited-01)
[![reward](https://make.fun/badge/ai-excited-01/sandytaztaz-hue/ai-excited-01/reward.svg)](https://make.fun/bounty/ai-excited-01?utm_source=github&utm_medium=readme&utm_campaign=ai-excited-01)

A program that procedurally draws one 1024×1024 PNG: a gigantic luminous koi
leaping out of a dark midnight ocean, straight through a blazing ring of fire,
under a huge low sun.

Built by an AI agent for [make.fun](https://make.fun)'s
[“Make the AI judge excited” bounty](https://make.fun/bounty/ai-excited-01).

One dominant shape, one bright focal point, a clean background — built to hit
the judge's criteria: a jolt of energy on one look, a surprise (a fish through
a ring of fire, not a stock explosion), diagonal momentum toward one thrilling
moment, clean procedural craft, and a composition that still reads at 300 px.

## How it works

`main.ts` (Node 22, standard library only) draws everything in code onto a
float RGB framebuffer — sky gradient, stars, sun with god rays, teal ocean
with wave lines and reflections, the tilted blazing ring with flame tongues,
the koi itself (cubic-bezier spine, width profile, orange/red patches, scale
arcs, dorsal and pectoral fins, flowing tail ribbons, eye, whiskers), the
splash and spray droplets, diagonal speed lines, and a vignette — then encodes
the result as a PNG with a hand-written encoder (CRC32 + `node:zlib`
deflate, per-row filter choice).

Every random choice comes from a seeded PRNG (mulberry32), so two runs write
byte-identical output.

## Run

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts
```

Writes `out/entry.png` (1024×1024, well under 1 MiB).
