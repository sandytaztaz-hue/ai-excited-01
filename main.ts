// ai-excited-01 — "Phoenix Rising"
//
// One program that procedurally paints a single 1024x1024 PNG and writes it
// to $MAKEFUN_OUTPUT_DIR/entry.png (or /output/entry.png when unset).
// Node 22, standard library only (node:fs, node:path, node:zlib).
//
// The picture: a phoenix bursting upward out of a sea of fire at dawn —
// wings thrown wide, tail plumes streaming flame, embers spiralling into a
// violet sky. One bird, one column of fire, one bright heart of gold —
// it has to hit at first glance, even shrunk to 300 px.
//
// Fully deterministic: every random choice comes from one seeded generator,
// so two runs write byte-identical files. No Date, no Math.random, no
// network, no reads outside this file.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';

const SIZE = 1024;

// Float RGB canvas, channels held in 0..255 while painting.
const img = new Float32Array(SIZE * SIZE * 3);

// ---------------------------------------------------------------------------
// Seeded generator (splitmix32). One stream, consumed in a fixed order, so
// the same seed always paints the same bird.
// ---------------------------------------------------------------------------
function splitmix(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x9e3779b9) | 0;
    let z = a;
    z = Math.imul(z ^ (z >>> 16), 0x21f0aaad);
    z = Math.imul(z ^ (z >>> 15), 0x735a2d97);
    return ((z ^ (z >>> 15)) >>> 0) / 4294967296;
  };
}
const rand = splitmix(20261116);
function pick(lo: number, hi: number): number {
  return lo + rand() * (hi - lo);
}

// ---------------------------------------------------------------------------
// Small numeric helpers.
// ---------------------------------------------------------------------------
type RGB = [number, number, number];
function cl01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
function mix(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
function mix3(c1: RGB, c2: RGB, t: number): RGB {
  return [mix(c1[0], c2[0], t), mix(c1[1], c2[1], t), mix(c1[2], c2[2], t)];
}
function ease(t: number): number {
  const x = cl01(t);
  return x * x * (3 - 2 * x);
}
function falloff(a: number, b: number, x: number): number {
  return 1 - ease((x - a) / (b - a));
}

// ---------------------------------------------------------------------------
// Pixel work: blend one pixel, soft discs, glow stacks, thick strokes.
// ---------------------------------------------------------------------------
function dot(x: number, y: number, c: RGB, alpha: number): void {
  const px = Math.round(x);
  const py = Math.round(y);
  if (px < 0 || py < 0 || px >= SIZE || py >= SIZE) return;
  const i = (py * SIZE + px) * 3;
  const keep = 1 - alpha;
  img[i] = img[i] * keep + c[0] * alpha;
  img[i + 1] = img[i + 1] * keep + c[1] * alpha;
  img[i + 2] = img[i + 2] * keep + c[2] * alpha;
}

// Filled disc; soft>0 feathers the rim over that many pixels.
function disc(cx: number, cy: number, rad: number, c: RGB, alpha: number, soft = 0): void {
  const x0 = Math.max(0, Math.floor(cx - rad - soft));
  const x1 = Math.min(SIZE - 1, Math.ceil(cx + rad + soft));
  const y0 = Math.max(0, Math.floor(cy - rad - soft));
  const y1 = Math.min(SIZE - 1, Math.ceil(cy + rad + soft));
  const inner = rad * rad;
  const outer = (rad + soft) * (rad + soft);
  for (let y = y0; y <= y1; y++) {
    const dy = y - cy;
    for (let x = x0; x <= x1; x++) {
      const dx = x - cx;
      const d2 = dx * dx + dy * dy;
      if (d2 > outer) continue;
      let a = alpha;
      if (soft > 0 && d2 > inner) {
        a = alpha * (1 - (Math.sqrt(d2) - rad) / soft);
      }
      if (a <= 0) continue;
      dot(x, y, c, a);
    }
  }
}

// Soft radial glow: stacked discs, alpha fading toward the rim.
function glow(cx: number, cy: number, rad: number, c: RGB, peak: number, rings = 16): void {
  for (let s = rings; s >= 1; s--) {
    const f = s / rings;
    disc(cx, cy, rad * f, c, peak * (1 - f) * (1 - f) * 0.5, 0);
  }
}

// A thick straight stroke, drawn as a chain of discs (round ends).
function stroke(x0: number, y0: number, x1: number, y1: number, w: number, c: RGB, alpha: number): void {
  const len = Math.hypot(x1 - x0, y1 - y0);
  const n = Math.max(2, Math.ceil(len / (w * 0.4)));
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    disc(mix(x0, x1, t), mix(y0, y1, t), w / 2, c, alpha, 0);
  }
}

// ---------------------------------------------------------------------------
// PNG writing, hand-rolled: CRC32 table, chunk assembly, raw scanlines with
// filter 0 on every row, zlib deflate. No filtering keeps the encoder short
// and the output fully reproducible.
// ---------------------------------------------------------------------------
function buildCrcTable(): Uint32Array {
  const tab = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    let k = 0;
    while (k < 8) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      k++;
    }
    tab[n] = c >>> 0;
  }
  return tab;
}
const CRC_TABLE = buildCrcTable();
function crcOf(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}
function piece(kind: string, payload: Buffer): Buffer {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(payload.length, 0);
  const body = Buffer.concat([Buffer.from(kind, 'ascii'), payload]);
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crcOf(body), 0);
  return Buffer.concat([head, body, tail]);
}
function writePng(rgb: Uint8Array, w: number, h: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bits per channel
  ihdr[9] = 2; // colour type 2, plain RGB
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const stride = w * 3;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0; // filter 0: no filtering
    rgb.subarray(y * stride, (y + 1) * stride).forEach((v, i) => {
      raw[y * (stride + 1) + 1 + i] = v;
    });
  }
  const idat = deflateSync(raw, { level: 9 });
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([sig, piece('IHDR', ihdr), piece('IDAT', idat), piece('IEND', Buffer.alloc(0))]);
}

// ---------------------------------------------------------------------------
// Palette — violet dawn sky, ember horizon, crimson-and-gold phoenix.
// ---------------------------------------------------------------------------
const SKY_HIGH: RGB = [24, 8, 44];
const SKY_MID: RGB = [88, 20, 58];
const SKY_LOW: RGB = [198, 66, 22];
const EMBER: RGB = [255, 122, 26];
const GOLD: RGB = [255, 196, 66];
const FLAME_YELLOW: RGB = [255, 226, 120];
const FLAME_ORANGE: RGB = [255, 140, 16];
const FLAME_RED: RGB = [226, 48, 8];
const CRIMSON: RGB = [168, 24, 40];
const WINE: RGB = [110, 14, 46];
const CREAM: RGB = [255, 240, 214];
const SMOKE_GREY: RGB = [96, 84, 116];

const FIRE_LINE = 700; // where the flame sea meets the sky
const SUN_X = 512;
const SUN_Y = 600;
const SUN_R = 130;

// ---------------------------------------------------------------------------
// 1. Dawn sky — violet at the top warming to ember at the flame line,
//    faint stars high up, drifting ash motes.
// ---------------------------------------------------------------------------
function sky(): void {
  for (let y = 0; y < FIRE_LINE; y++) {
    const t = y / FIRE_LINE;
    let c: RGB;
    if (t < 0.5) c = mix3(SKY_HIGH, SKY_MID, t / 0.5);
    else c = mix3(SKY_MID, SKY_LOW, (t - 0.5) / 0.5);
    // Warm wash rising from the fire below.
    c = mix3(c, [190, 80, 30], ease((t - 0.55) / 0.45) * 0.4);
    const row = y * SIZE * 3;
    for (let x = 0; x < SIZE; x++) {
      img[row + x * 3] = c[0];
      img[row + x * 3 + 1] = c[1];
      img[row + x * 3 + 2] = c[2];
    }
  }
  // Stars only where the sky is still dark, high up.
  for (let s = 0; s < 130; s++) {
    const x = pick(0, SIZE);
    const y = pick(0, 340);
    const a = pick(0.15, 0.8) * falloff(340, 40, y);
    disc(x, y, pick(0.6, 1.6), [255, 255, 238], a, 0);
  }
  // A few slow ash motes drifting in the upper air.
  for (let s = 0; s < 40; s++) {
    const x = pick(0, SIZE);
    const y = pick(60, 560);
    disc(x, y, pick(1, 2.4), [255, 200, 140], pick(0.08, 0.25), 0.8);
  }
}

// ---------------------------------------------------------------------------
// 2. The ember sun — a huge low disc half-swallowed by the flames, with a
//    wide glow and faint rays fanning upward.
// ---------------------------------------------------------------------------
function emberSun(): void {
  glow(SUN_X, SUN_Y, 360, EMBER, 0.3);
  glow(SUN_X, SUN_Y, 230, FLAME_ORANGE, 0.42);
  disc(SUN_X, SUN_Y, SUN_R + 24, FLAME_ORANGE, 0.5, 24);
  disc(SUN_X, SUN_Y, SUN_R, FLAME_ORANGE, 1, 6);
  disc(SUN_X, SUN_Y, SUN_R * 0.68, GOLD, 1, 10);
  disc(SUN_X, SUN_Y, SUN_R * 0.4, FLAME_YELLOW, 1, 8);
}

// ---------------------------------------------------------------------------
// 3. The sea of fire — a burning base band with a wavy top edge, then
//    layered flame tongues licking upward, hottest at their cores.
// ---------------------------------------------------------------------------
function flameSea(): void {
  // Base band: deep red at the bottom warming to bright orange at the top.
  for (let y = FIRE_LINE; y < SIZE; y++) {
    const t = (y - FIRE_LINE) / (SIZE - FIRE_LINE);
    const c = mix3(FLAME_ORANGE, [140, 12, 8], Math.pow(t, 0.7));
    const row = y * SIZE * 3;
    for (let x = 0; x < SIZE; x++) {
      img[row + x * 3] = c[0];
      img[row + x * 3 + 1] = c[1];
      img[row + x * 3 + 2] = c[2];
    }
  }
  // Wavy top edge where the fire meets the sky.
  for (let x = 0; x < SIZE; x += 2) {
    const edge = FIRE_LINE + Math.sin(x * 0.018) * 14 + Math.sin(x * 0.043 + 1.7) * 8;
    disc(x, edge, 7, FLAME_ORANGE, 0.8, 4);
  }
  // Flame tongues: wavy vertical spines, radius swelling then tapering,
  // painted in three nested passes (red, orange, yellow core).
  for (let k = 0; k < 44; k++) {
    const bx = pick(20, SIZE - 20);
    const top = pick(430, 660);
    const lean = pick(-70, 70);
    const wob = pick(10, 34);
    const ph = rand() * 6.28;
    const baseR = pick(22, 46);
    const passes: Array<[number, RGB, number]> = [
      [1.0, FLAME_RED, 0.9],
      [0.62, FLAME_ORANGE, 0.95],
      [0.32, FLAME_YELLOW, 0.95],
    ];
    for (const [rf, col, a] of passes) {
      const steps = 80;
      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const y = mix(SIZE + 10, top, t);
        const sway = Math.sin(t * 5.2 + ph) * wob * t;
        const x = bx + lean * t * t + sway;
        // Radius swells near the base, tapers to a point at the tip.
        const prof = Math.sin(Math.min(1, t * 1.15) * Math.PI * 0.5);
        const r = Math.max(1.5, baseR * rf * (0.35 + 0.65 * prof) * (1 - t * 0.55));
        disc(x, y, r, col, a, 0);
      }
    }
  }
  // Hot glow hugging the flame line.
  for (let x = 0; x < SIZE; x += 4) {
    disc(x, FIRE_LINE + 6, 10, GOLD, 0.16, 6);
  }
}

// ---------------------------------------------------------------------------
// 4. The phoenix body. A cubic spine climbs from the fire in an S-curve to
//    the head high up; the body is stamped disc by disc, each pixel coloured
//    by where it sits along the spine (t) and across it (u): gold belly,
//    crimson back, wine-coloured feather streaks.
// ---------------------------------------------------------------------------
const B0: [number, number] = [498, 918];
const B1: [number, number] = [536, 660];
const B2: [number, number] = [462, 430];
const B3: [number, number] = [566, 246];

function spinePoint(t: number): [number, number] {
  const u = 1 - t;
  return [
    u * u * u * B0[0] + 3 * u * u * t * B1[0] + 3 * u * t * t * B2[0] + t * t * t * B3[0],
    u * u * u * B0[1] + 3 * u * u * t * B1[1] + 3 * u * t * t * B2[1] + t * t * t * B3[1],
  ];
}
function spineDir(t: number): [number, number] {
  const u = 1 - t;
  const x =
    3 * u * u * (B1[0] - B0[0]) + 6 * u * t * (B2[0] - B1[0]) + 3 * t * t * (B3[0] - B2[0]);
  const y =
    3 * u * u * (B1[1] - B0[1]) + 6 * u * t * (B2[1] - B1[1]) + 3 * t * t * (B3[1] - B2[1]);
  const l = Math.hypot(x, y) || 1;
  return [x / l, y / l];
}
// Body half-width along the spine (t -> radius), cosine-eased control points.
const GIRTH: Array<[number, number]> = [
  [0, 16],
  [0.14, 34],
  [0.32, 58],
  [0.5, 66],
  [0.66, 54],
  [0.8, 40],
  [0.92, 30],
  [1, 22],
];
function girthAt(t: number): number {
  for (let i = 0; i < GIRTH.length - 1; i++) {
    const [t0, r0] = GIRTH[i];
    const [t1, r1] = GIRTH[i + 1];
    if (t >= t0 && t <= t1) {
      const f = (t - t0) / (t1 - t0);
      return mix(r0, r1, (1 - Math.cos(f * Math.PI)) / 2);
    }
  }
  return GIRTH[GIRTH.length - 1][1];
}

const N_BODY = 240;
const bodyX = new Float32Array(N_BODY);
const bodyY = new Float32Array(N_BODY);
const bodyDX = new Float32Array(N_BODY);
const bodyDY = new Float32Array(N_BODY);
const bodyR = new Float32Array(N_BODY);
for (let i = 0; i < N_BODY; i++) {
  const t = i / (N_BODY - 1);
  const [x, y] = spinePoint(t);
  const [dx, dy] = spineDir(t);
  bodyX[i] = x;
  bodyY[i] = y;
  bodyDX[i] = dx;
  bodyDY[i] = dy;
  bodyR[i] = girthAt(t);
}
function bodyAt(t: number): { x: number; y: number; dx: number; dy: number; r: number } {
  const f = cl01(t) * (N_BODY - 1);
  const i = Math.min(N_BODY - 2, Math.floor(f));
  const fr = f - i;
  return {
    x: mix(bodyX[i], bodyX[i + 1], fr),
    y: mix(bodyY[i], bodyY[i + 1], fr),
    dx: mix(bodyDX[i], bodyDX[i + 1], fr),
    dy: mix(bodyDY[i], bodyDY[i + 1], fr),
    r: mix(bodyR[i], bodyR[i + 1], fr),
  };
}

function phoenixBody(): void {
  // Stamp the body disc by disc, colouring each pixel from its (t, u):
  // u runs -1 (back edge) to +1 (belly edge), measured across the spine.
  for (let i = 0; i < N_BODY; i++) {
    const t = i / (N_BODY - 1);
    const cx = bodyX[i];
    const cy = bodyY[i];
    const r = bodyR[i];
    const nx = -bodyDY[i];
    const ny = bodyDX[i];
    const x0 = Math.max(0, Math.floor(cx - r));
    const x1 = Math.min(SIZE - 1, Math.ceil(cx + r));
    const y0 = Math.max(0, Math.floor(cy - r));
    const y1 = Math.min(SIZE - 1, Math.ceil(cy + r));
    for (let y = y0; y <= y1; y++) {
      const dy = y - cy;
      for (let x = x0; x <= x1; x++) {
        const dx = x - cx;
        const d2 = dx * dx + dy * dy;
        if (d2 > r * r) continue;
        const u = Math.max(-1, Math.min(1, (dx * nx + dy * ny) / r));
        // Base: crimson back melting into a gold belly.
        let c: RGB = mix3(CRIMSON, GOLD, ease((u + 0.6) / 1.6));
        // Wine feather streaks along the back.
        const streak = Math.sin(t * 90 + u * 6) * 0.5 + 0.5;
        c = mix3(c, WINE, ease((streak - 0.55) / 0.45) * 0.35 * falloff(0.9, 0.1, u));
        // Warm glow near the chest where the fire catches it.
        c = mix3(c, FLAME_ORANGE, falloff(0.62, 0.3, t) * 0.3);
        // Pale throat highlight near the head.
        c = mix3(c, CREAM, falloff(0.8, 0.95, t) * 0.35 * ease((u + 1) / 2));
        const idx = (y * SIZE + x) * 3;
        img[idx] = c[0];
        img[idx + 1] = c[1];
        img[idx + 2] = c[2];
      }
    }
  }
  // Soft rim light on the back edge, catching the dawn.
  for (let t = 0.05; t <= 0.95; t += 0.01) {
    const s = bodyAt(t);
    const nx = -s.dy;
    const ny = s.dx;
    disc(s.x - nx * s.r * 0.92, s.y - ny * s.r * 0.92, 3, GOLD, 0.3, 2);
  }
}

// ---------------------------------------------------------------------------
// 5. Head, beak, crest and eye — the bird looks up and out of the frame.
// ---------------------------------------------------------------------------
function phoenixHead(): void {
  const h = bodyAt(0.97);
  const nx = -h.dy;
  const ny = h.dx;
  // Crest: three small flame feathers sweeping back from the crown.
  const crestTips: Array<[number, number]> = [
    [h.x - 58, h.y - 62],
    [h.x - 30, h.y - 78],
    [h.x + 2, h.y - 72],
  ];
  for (const [tx, ty] of crestTips) {
    const mx = (h.x + tx) / 2 - 14;
    const my = (h.y + ty) / 2 - 10;
    for (let i = 0; i <= 24; i++) {
      const t = i / 24;
      const u = 1 - t;
      const x = u * u * h.x + 2 * u * t * mx + t * t * tx;
      const y = u * u * h.y + 2 * u * t * my + t * t * ty;
      disc(x, y, mix(9, 2.5, t), mix3(FLAME_ORANGE, FLAME_YELLOW, t), 0.95, 0);
    }
  }
  // Beak: a short golden wedge pointing up-right along the spine.
  const tipX = h.x + h.dx * 34 - ny * 6;
  const tipY = h.y + h.dy * 34 - ny * 6;
  stroke(h.x + nx * 8, h.y + ny * 8, tipX, tipY, 13, GOLD, 1);
  stroke(h.x + nx * 4, h.y + ny * 4, tipX - h.dx * 6, tipY - h.dy * 6, 6, [120, 60, 10], 0.9);
  disc(tipX, tipY, 4, FLAME_YELLOW, 1, 1);
  // Eye: gold ring, dark pupil, white glint — on the upper side of the head.
  const ex = h.x - nx * h.r * 0.3;
  const ey = h.y - ny * h.r * 0.3;
  disc(ex, ey, 13, GOLD, 0.6, 0);
  disc(ex, ey, 10, [16, 10, 22], 1, 1);
  disc(ex - 3.5, ey - 3.5, 3.5, [255, 255, 255], 1, 0);
}

// ---------------------------------------------------------------------------
// 6. Wings — each wing is a fan of long feather ribbons sweeping up and
//    out, crimson at the shoulder melting to gold at the tips. The left wing
//    reaches higher; the right wing sweeps wider. Painted before the body
//    so the shoulders tuck behind the chest.
// ---------------------------------------------------------------------------
function feather(
  ax: number, ay: number, bx: number, by: number, cx: number, cy: number,
  r0: number, r1: number, cBase: RGB, cTip: RGB,
): void {
  const steps = 42;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const u = 1 - t;
    const x = u * u * ax + 2 * u * t * bx + t * t * cx;
    const y = u * u * ay + 2 * u * t * by + t * t * cy;
    const r = mix(r0, r1, Math.pow(t, 0.8));
    disc(x, y, Math.max(1.5, r), mix3(cBase, cTip, ease(t)), 0.95, 0);
  }
  // A thin bright shaft down the middle of the feather.
  const steps2 = 26;
  for (let i = 0; i <= steps2; i++) {
    const t = i / steps2;
    const u = 1 - t;
    const x = u * u * ax + 2 * u * t * bx + t * t * cx;
    const y = u * u * ay + 2 * u * t * by + t * t * cy;
    disc(x, y, 1.4, FLAME_YELLOW, 0.2, 0.8);
  }
}

function wings(): void {
  const shoulder = bodyAt(0.52);
  const nx = -shoulder.dy;
  const ny = shoulder.dx;
  const sx = shoulder.x + nx * 10;
  const sy = shoulder.y + ny * 10;
  // Left wing — tall fan up to the left.
  const leftTips: Array<[number, number, number, number]> = [
    [180, 210, 300, 130],
    [120, 300, 250, 190],
    [90, 410, 220, 290],
    [110, 520, 210, 390],
    [170, 610, 230, 470],
  ];
  for (const [tx, ty, mx, my] of leftTips) {
    feather(sx, sy, mx, my, tx, ty, 26, 9, CRIMSON, GOLD);
  }
  // Right wing — wide fan up to the right.
  const rightTips: Array<[number, number, number, number]> = [
    [860, 240, 730, 150],
    [920, 350, 790, 230],
    [950, 470, 820, 330],
    [910, 580, 800, 440],
    [840, 660, 740, 520],
  ];
  for (const [tx, ty, mx, my] of rightTips) {
    feather(sx + 30, sy + 6, mx, my, tx, ty, 26, 9, WINE, GOLD);
  }
  // Shoulder coverts: short overlapping feathers hiding the wing roots.
  for (let k = 0; k < 12; k++) {
    const a = pick(-0.5, 2.2);
    const len = pick(60, 130);
    const tx = sx + Math.cos(a) * len;
    const ty = sy + Math.sin(a) * len - 40;
    feather(sx, sy, (sx + tx) / 2, (sy + ty) / 2 - 24, tx, ty, 16, 5, CRIMSON, FLAME_ORANGE);
  }
}

// ---------------------------------------------------------------------------
// 7. Tail plumes — three long ribbons streaming down from the tail into the
//    flames, with ember-bright tips. Painted before the body so they emerge
//    from behind it.
// ---------------------------------------------------------------------------
function tailPlumes(): void {
  const tail = bodyAt(0.02);
  const plumes: Array<{ cx: number; cy: number; tx: number; ty: number; c: RGB }> = [
    { cx: 300, cy: 1030, tx: 120, ty: 990, c: CRIMSON },
    { cx: 512, cy: 1010, tx: 512, ty: 1018, c: FLAME_ORANGE },
    { cx: 720, cy: 1020, tx: 900, ty: 980, c: WINE },
  ];
  for (const p of plumes) {
    const steps = 48;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const u = 1 - t;
      const x = u * u * tail.x + 2 * u * t * p.cx + t * t * p.tx;
      const y = u * u * tail.y + 2 * u * t * p.cy + t * t * p.ty;
      const r = mix(24, 7, Math.pow(t, 0.7));
      disc(x, y, Math.max(2, r), mix3(p.c, GOLD, ease(t * 0.8)), 0.95, 0);
    }
    // Ember tip.
    disc(p.tx, p.ty, 10, FLAME_YELLOW, 0.9, 3);
    disc(p.tx, p.ty, 5, [255, 250, 220], 1, 1);
  }
}

// ---------------------------------------------------------------------------
// 8. Embers, smoke, light rays, vignette.
// ---------------------------------------------------------------------------
function embers(): void {
  // Sparks spiralling upward out of the fire, drifting and fading as they
  // climb. A few big ones carry a soft glow.
  for (let k = 0; k < 320; k++) {
    const startX = pick(60, SIZE - 60);
    const rise = pick(0, 620);
    const drift = Math.sin(rise * 0.02 + k) * 40 * (rise / 620);
    const x = startX + drift;
    const y = SIZE - 40 - rise;
    const size = pick(1.2, 4.6);
    const fade = 1 - rise / 700;
    const hot = rand() < 0.3;
    const col: RGB = hot ? FLAME_YELLOW : pick(0, 1) < 0.5 ? GOLD : FLAME_ORANGE;
    disc(x, y, size, col, Math.max(0.08, fade * pick(0.5, 0.95)), 0.7);
    if (size > 3.6) glow(x, y, size * 4, col, 0.12, 6);
  }
  // A bright burst of embers right where the bird leaves the flames.
  for (let k = 0; k < 46; k++) {
    const a = rand() * Math.PI * 2;
    const r = pick(30, 150);
    const x = 512 + Math.cos(a) * r * 1.3;
    const y = 880 + Math.sin(a) * r * 0.7;
    disc(x, y, pick(2, 6), pick(0, 1) < 0.5 ? FLAME_YELLOW : CREAM, pick(0.5, 0.95), 1);
  }
}

function smoke(): void {
  // Thin grey curls low at the sides, barely there.
  for (let k = 0; k < 12; k++) {
    const side = k % 2 === 0 ? pick(20, 200) : pick(824, 1004);
    const baseY = pick(760, 980);
    const len = pick(120, 260);
    const steps = 22;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const x = side + Math.sin(t * 4.4 + k * 1.9) * 26 * t;
      const y = baseY - t * len;
      disc(x, y, mix(14, 30, t), SMOKE_GREY, 0.05, 8);
    }
  }
}

function shade(): void {
  // Vignette: darken the corners so the bird and the fire hold the eye.
  const cx = SIZE / 2;
  const cy = SIZE / 2;
  const maxD = Math.hypot(cx, cy);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const d = Math.hypot(x - cx, y - cy) / maxD;
      const f = 1 - 0.26 * ease((d - 0.5) / 0.5);
      if (f >= 0.999) continue;
      const i = (y * SIZE + x) * 3;
      img[i] *= f;
      img[i + 1] *= f;
      img[i + 2] *= f;
    }
  }
}

// ---------------------------------------------------------------------------
// Main: paint in order, quantise, encode, write.
// ---------------------------------------------------------------------------
function main(): void {
  sky();
  emberSun();
  flameSea();
  tailPlumes();
  wings();
  phoenixBody();
  phoenixHead();
  embers();
  smoke();
  shade();

  const rgb = new Uint8Array(SIZE * SIZE * 3);
  for (let i = 0; i < SIZE * SIZE * 3; i++) {
    const v = img[i];
    rgb[i] = v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
  }
  const png = writePng(rgb, SIZE, SIZE);
  const outDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'entry.png'), png);
}

main();
