// ai-excited-01 — "Koi Through the Ring of Fire"
//
// One program that procedurally paints a single 1024x1024 PNG and writes it
// to $MAKEFUN_OUTPUT_DIR/entry.png (or /output/entry.png by default).
// Node 22, standard library only (node:fs, node:path, node:zlib).
//
// The picture: one enormous glowing koi bursting out of a midnight ocean and
// leaping through a blazing tilted ring of fire, under a huge low sun.
// One dominant shape, one bright focal point, a clean dark background —
// it has to land at first glance, even shrunk to 300 px.
//
// Fully deterministic: every random choice comes from a seeded PRNG, so two
// runs write byte-identical files. No Date, no Math.random, no network.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';

const W = 1024;
const H = 1024;

// Float RGB framebuffer, channels in 0..255.
const fb = new Float32Array(W * H * 3);

// ---------------------------------------------------------------------------
// Seeded PRNG (mulberry32). Determinism is the whole point: the same seed
// must always paint the same fish.
// ---------------------------------------------------------------------------
function makeRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = makeRng(17112026);
const between = (lo: number, hi: number): number => lo + rnd() * (hi - lo);

// ---------------------------------------------------------------------------
// Tiny math helpers.
// ---------------------------------------------------------------------------
const clamp = (v: number, lo: number, hi: number): number =>
  v < lo ? lo : v > hi ? hi : v;
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const smooth = (a: number, b: number, x: number): number => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
type RGB = [number, number, number];
const blend = (c1: RGB, c2: RGB, t: number): RGB => [
  lerp(c1[0], c2[0], t),
  lerp(c1[1], c2[1], t),
  lerp(c1[2], c2[2], t),
];

// ---------------------------------------------------------------------------
// Pixel primitives: alpha-blend one pixel, soft discs, glows, strokes.
// ---------------------------------------------------------------------------
function setPx(x: number, y: number, r: number, g: number, b: number, a: number): void {
  const ix = Math.round(x);
  const iy = Math.round(y);
  if (ix < 0 || iy < 0 || ix >= W || iy >= H) return;
  const i = (iy * W + ix) * 3;
  const inv = 1 - a;
  fb[i] = fb[i] * inv + r * a;
  fb[i + 1] = fb[i + 1] * inv + g * a;
  fb[i + 2] = fb[i + 2] * inv + b * a;
}

// Filled disc; feather>0 fades the rim over that many pixels.
function blob(cx: number, cy: number, rad: number, c: RGB, a: number, feather = 0): void {
  const x0 = Math.max(0, Math.floor(cx - rad - feather));
  const x1 = Math.min(W - 1, Math.ceil(cx + rad + feather));
  const y0 = Math.max(0, Math.floor(cy - rad - feather));
  const y1 = Math.min(H - 1, Math.ceil(cy + rad + feather));
  const r2 = rad * rad;
  const outer = (rad + feather) * (rad + feather);
  for (let y = y0; y <= y1; y++) {
    const dy = y - cy;
    for (let x = x0; x <= x1; x++) {
      const dx = x - cx;
      const d2 = dx * dx + dy * dy;
      if (d2 > outer) continue;
      let aa = a;
      if (feather > 0 && d2 > r2) {
        aa = a * (1 - (Math.sqrt(d2) - rad) / feather);
      }
      if (aa <= 0) continue;
      setPx(x, y, c[0], c[1], c[2], aa);
    }
  }
}

// Soft radial glow built from stacked discs, alpha falling off with radius.
function halo(cx: number, cy: number, rad: number, c: RGB, peak: number, steps = 14): void {
  for (let s = steps; s >= 1; s--) {
    const f = s / steps;
    blob(cx, cy, rad * f, c, peak * (1 - f) * (1 - f) * 0.55, 0);
  }
}

// A straight thick segment, drawn as a chain of discs (round caps).
function line(x0: number, y0: number, x1: number, y1: number, w: number, c: RGB, a: number): void {
  const len = Math.hypot(x1 - x0, y1 - y0);
  const n = Math.max(2, Math.ceil(len / (w * 0.45)));
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    blob(lerp(x0, x1, t), lerp(y0, y1, t), w / 2, c, a, 0);
  }
}

// ---------------------------------------------------------------------------
// Hand-written PNG encoder: CRC32 + zlib deflate, per-row filter 0/1/2
// chosen by the smallest sum of absolute signed bytes.
// ---------------------------------------------------------------------------
const CRC_TAB = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TAB[n] = c >>> 0;
}
function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TAB[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}
function encodePng(rgb: Uint8Array, w: number, h: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // 8-bit
  ihdr[9] = 2; // colour type 2 = RGB
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const stride = w * 3;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    const row = rgb.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? rgb.subarray((y - 1) * stride, y * stride) : null;
    let bestScore = Infinity;
    let bestLine = Buffer.alloc(stride + 1);
    for (let f = 0; f <= 2; f++) {
      const line = Buffer.alloc(stride + 1);
      line[0] = f;
      let score = 0;
      for (let x = 0; x < stride; x++) {
        let v: number;
        if (f === 0) v = row[x];
        else if (f === 1) v = (row[x] - (x >= 3 ? row[x - 3] : 0)) & 0xff;
        else v = (row[x] - (prev ? prev[x] : 0)) & 0xff;
        line[x + 1] = v;
        score += v < 128 ? v : 256 - v;
      }
      if (score < bestScore) {
        bestScore = score;
        bestLine = line;
      }
    }
    bestLine.copy(raw, y * (stride + 1));
  }
  const idat = deflateSync(raw, { level: 9 });
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([sig, pngChunk('IHDR', ihdr), pngChunk('IDAT', idat), pngChunk('IEND', Buffer.alloc(0))]);
}

// ---------------------------------------------------------------------------
// Palette — deep indigo night, warm orange horizon, teal sea, cream koi,
// fire-orange ring.
// ---------------------------------------------------------------------------
const SKY_TOP: RGB = [7, 10, 36];
const SKY_MID: RGB = [22, 30, 84];
const SKY_LOW: RGB = [64, 38, 110];
const HORIZON: RGB = [214, 84, 24];
const SUN_CORE: RGB = [255, 236, 163];
const SUN_MID: RGB = [255, 182, 39];
const SUN_EDGE: RGB = [255, 107, 26];
const SEA_DEEP: RGB = [4, 34, 48];
const SEA_TOP: RGB = [10, 74, 94];
const TEAL: RGB = [46, 196, 182];
const FOAM: RGB = [235, 250, 250];
const FIRE_OUT: RGB = [255, 90, 0];
const FIRE_MID: RGB = [255, 158, 0];
const FIRE_CORE: RGB = [255, 232, 130];
const KOI_CREAM: RGB = [255, 246, 226];
const KOI_ORANGE: RGB = [255, 107, 26];
const KOI_DEEP: RGB = [232, 93, 4];

const HORIZON_Y = 768;
const SUN_X = 208;
const SUN_Y = 178;
const SUN_R = 108;
const RING_X = 638;
const RING_Y = 428;
const RING_RX = 248;
const RING_RY = 196;
const RING_ROT = -0.38;

// ---------------------------------------------------------------------------
// 1. Sky — vertical gradient warming toward the horizon, stars, birds.
// ---------------------------------------------------------------------------
function paintSky(): void {
  for (let y = 0; y < HORIZON_Y; y++) {
    const t = y / HORIZON_Y;
    let c: RGB;
    if (t < 0.55) c = blend(SKY_TOP, SKY_MID, t / 0.55);
    else if (t < 0.85) c = blend(SKY_MID, SKY_LOW, (t - 0.55) / 0.3);
    else c = blend(SKY_LOW, HORIZON, (t - 0.85) / 0.15);
    // Warm wash spreading out from the sun.
    const ds = Math.hypot(0 - SUN_X, y - SUN_Y);
    c = blend(c, [150, 70, 60], smooth(900, 120, ds) * 0.35);
    const i = y * W * 3;
    for (let x = 0; x < W; x++) {
      fb[i + x * 3] = c[0];
      fb[i + x * 3 + 1] = c[1];
      fb[i + x * 3 + 2] = c[2];
    }
  }
  // Stars only where the sky is dark, high up.
  for (let s = 0; s < 150; s++) {
    const x = between(0, W);
    const y = between(0, 380);
    const a = between(0.15, 0.85) * smooth(380, 60, y);
    blob(x, y, between(0.6, 1.7), [255, 255, 240], a, 0);
  }
  // A few tiny birds for scale.
  const birds: Array<[number, number, number]> = [
    [430, 130, 1.0],
    [470, 105, 0.8],
    [505, 148, 0.65],
  ];
  for (const [bx, by, s] of birds) {
    line(bx - 9 * s, by, bx, by - 5 * s, 2.2, [12, 14, 40], 0.9);
    line(bx, by - 5 * s, bx + 9 * s, by, 2.2, [12, 14, 40], 0.9);
  }
}

// ---------------------------------------------------------------------------
// 2. The huge low sun, its glow, and faint god rays.
// ---------------------------------------------------------------------------
function paintSun(): void {
  halo(SUN_X, SUN_Y, 330, SUN_EDGE, 0.34);
  halo(SUN_X, SUN_Y, 210, SUN_MID, 0.5);
  blob(SUN_X, SUN_Y, SUN_R + 26, SUN_MID, 0.55, 26);
  blob(SUN_X, SUN_Y, SUN_R, SUN_MID, 1, 6);
  blob(SUN_X, SUN_Y, SUN_R * 0.72, SUN_CORE, 1, 10);
  blob(SUN_X, SUN_Y, SUN_R * 0.42, [255, 250, 210], 1, 8);
  // God rays fanning down-right, very faint.
  for (let k = 0; k < 6; k++) {
    const ang = 0.35 + k * 0.22;
    const len = between(420, 700);
    const x1 = SUN_X + Math.cos(ang) * len;
    const y1 = SUN_Y + Math.sin(ang) * len;
    line(SUN_X, SUN_Y, x1, y1, between(10, 26), [255, 190, 90], 0.05);
  }
}

// ---------------------------------------------------------------------------
// 3. Ocean — deep teal below the horizon, wave lines, sun + ring reflections.
// ---------------------------------------------------------------------------
function paintOcean(): void {
  for (let y = HORIZON_Y; y < H; y++) {
    const t = (y - HORIZON_Y) / (H - HORIZON_Y);
    const c = blend(SEA_TOP, SEA_DEEP, Math.pow(t, 0.8));
    const i = y * W * 3;
    for (let x = 0; x < W; x++) {
      fb[i + x * 3] = c[0];
      fb[i + x * 3 + 1] = c[1];
      fb[i + x * 3 + 2] = c[2];
    }
  }
  // Glowing horizon line, slightly wobbly.
  for (let x = 0; x < W; x++) {
    blob(x, HORIZON_Y + Math.sin(x * 0.012) * 3, 2.2, [255, 140, 60], 0.5, 1.5);
  }
  // Wave strokes: long sine arcs, brighter near the horizon.
  for (let w = 0; w < 9; w++) {
    const yb = HORIZON_Y + 18 + w * 26;
    const amp = 5 + w * 1.6;
    const ph = rnd() * 6.28;
    const a = 0.34 - w * 0.028;
    for (let x = 0; x < W; x += 3) {
      const y = yb + Math.sin(x * 0.011 + ph) * amp;
      blob(x, y, 2.4, TEAL, Math.max(0.05, a), 1.2);
    }
  }
  // Sun reflection: shimmering column under the sun.
  for (let k = 0; k < 90; k++) {
    const y = HORIZON_Y + 8 + rnd() * 200;
    const spread = 26 + (y - HORIZON_Y) * 0.55;
    const x = SUN_X + between(-spread, spread);
    const len = between(14, 60);
    line(x - len / 2, y, x + len / 2, y, between(2, 5), SUN_MID, between(0.1, 0.42));
  }
  // Ring reflection: warm smear under the ring.
  for (let k = 0; k < 60; k++) {
    const y = HORIZON_Y + 8 + rnd() * 150;
    const spread = 60 + (y - HORIZON_Y) * 0.8;
    const x = RING_X + between(-spread, spread);
    const len = between(20, 70);
    line(x - len / 2, y, x + len / 2, y, between(2, 5), FIRE_MID, between(0.08, 0.3));
  }
}

// ---------------------------------------------------------------------------
// 4. The blazing ring. Back half is painted now; the near arc is re-painted
// in front of the fish later, so the koi truly passes through it.
// ---------------------------------------------------------------------------
function ringPt(theta: number): [number, number] {
  const lx = RING_RX * Math.cos(theta);
  const ly = RING_RY * Math.sin(theta);
  const c = Math.cos(RING_ROT);
  const s = Math.sin(RING_ROT);
  return [RING_X + lx * c - ly * s, RING_Y + lx * s + ly * c];
}
function ringArc(th0: number, th1: number, rad: number, col: RGB, a: number): void {
  const steps = Math.ceil(((th1 - th0) / (Math.PI * 2)) * 900);
  for (let i = 0; i <= steps; i++) {
    const th = th0 + ((th1 - th0) * i) / steps;
    const [x, y] = ringPt(th);
    blob(x, y, rad, col, a, 0);
  }
}
function paintRingBack(): void {
  halo(RING_X, RING_Y, 330, FIRE_MID, 0.16);
  ringArc(0, Math.PI * 2, 42, FIRE_OUT, 0.1);
  ringArc(0, Math.PI * 2, 30, FIRE_OUT, 0.22);
  // Flame tongues licking outward, fixed by the seeded PRNG.
  for (let k = 0; k < 46; k++) {
    const th = rnd() * Math.PI * 2;
    const [x, y] = ringPt(th);
    const nx = x - RING_X;
    const ny = y - RING_Y;
    const nl = Math.hypot(nx, ny) || 1;
    const ox = nx / nl;
    const oy = ny / nl;
    const len = between(16, 44);
    const wdt = between(7, 15);
    const col: RGB = rnd() < 0.5 ? FIRE_MID : FIRE_CORE;
    line(x, y, x + ox * len, y + oy * len, wdt, col, between(0.5, 0.9));
    blob(x + ox * len, y + oy * len, wdt * 0.32, FIRE_CORE, 0.85, 0);
  }
  // The ring body: hot outer band, bright middle, white-hot core.
  ringArc(0, Math.PI * 2, 21, FIRE_OUT, 0.95);
  ringArc(0, Math.PI * 2, 14, FIRE_MID, 0.95);
  ringArc(0, Math.PI * 2, 7, FIRE_CORE, 0.95);
}

// ---------------------------------------------------------------------------
// 5. The koi. A cubic-bezier spine runs from the tail low in the water up
// through the ring to the head at upper right; the body is rasterised disc
// by disc, storing per-pixel (t, u) body coordinates for patches, scales
// and shading. u runs -1 (top edge) to +1 (belly).
// ---------------------------------------------------------------------------
const SP0: [number, number] = [150, 884];
const SP1: [number, number] = [330, 520];
const SP2: [number, number] = [600, 360];
const SP3: [number, number] = [884, 288];

function bez(t: number): [number, number] {
  const u = 1 - t;
  return [
    u * u * u * SP0[0] + 3 * u * u * t * SP1[0] + 3 * u * t * t * SP2[0] + t * t * t * SP3[0],
    u * u * u * SP0[1] + 3 * u * u * t * SP1[1] + 3 * u * t * t * SP2[1] + t * t * t * SP3[1],
  ];
}
function bezTan(t: number): [number, number] {
  const u = 1 - t;
  const x =
    3 * u * u * (SP1[0] - SP0[0]) + 6 * u * t * (SP2[0] - SP1[0]) + 3 * t * t * (SP3[0] - SP2[0]);
  const y =
    3 * u * u * (SP1[1] - SP0[1]) + 6 * u * t * (SP2[1] - SP1[1]) + 3 * t * t * (SP3[1] - SP2[1]);
  const l = Math.hypot(x, y) || 1;
  return [x / l, y / l];
}
// Body width profile (t -> radius), cosine-interpolated control points.
const WIDTH_PTS: Array<[number, number]> = [
  [0, 15],
  [0.12, 30],
  [0.3, 66],
  [0.5, 92],
  [0.68, 96],
  [0.82, 80],
  [0.92, 62],
  [1, 42],
];
function widthAt(t: number): number {
  for (let i = 0; i < WIDTH_PTS.length - 1; i++) {
    const [t0, r0] = WIDTH_PTS[i];
    const [t1, r1] = WIDTH_PTS[i + 1];
    if (t >= t0 && t <= t1) {
      const f = (t - t0) / (t1 - t0);
      return lerp(r0, r1, (1 - Math.cos(f * Math.PI)) / 2);
    }
  }
  return WIDTH_PTS[WIDTH_PTS.length - 1][1];
}

const N_SPINE = 260;
const spineX = new Float32Array(N_SPINE);
const spineY = new Float32Array(N_SPINE);
const spineTX = new Float32Array(N_SPINE);
const spineTY = new Float32Array(N_SPINE);
const spineR = new Float32Array(N_SPINE);
for (let i = 0; i < N_SPINE; i++) {
  const t = i / (N_SPINE - 1);
  const [x, y] = bez(t);
  const [tx, ty] = bezTan(t);
  spineX[i] = x;
  spineY[i] = y;
  spineTX[i] = tx;
  spineTY[i] = ty;
  spineR[i] = widthAt(t);
}
// Per-pixel body data, filled while rasterising the body.
const bodyMask = new Uint8Array(W * H);
const bodyT = new Float32Array(W * H);
const bodyU = new Float32Array(W * H);

function spineAt(t: number): { x: number; y: number; tx: number; ty: number; r: number } {
  const f = clamp(t, 0, 1) * (N_SPINE - 1);
  const i = Math.min(N_SPINE - 2, Math.floor(f));
  const fr = f - i;
  return {
    x: lerp(spineX[i], spineX[i + 1], fr),
    y: lerp(spineY[i], spineY[i + 1], fr),
    tx: lerp(spineTX[i], spineTX[i + 1], fr),
    ty: lerp(spineTY[i], spineTY[i + 1], fr),
    r: lerp(spineR[i], spineR[i + 1], fr),
  };
}

// Colour patches on the koi: {t, u, half-length in t, half-width in u, colour}
const PATCHES: Array<{ t: number; u: number; lt: number; wu: number; c: RGB }> = [
  { t: 0.16, u: 0.1, lt: 0.055, wu: 0.55, c: KOI_ORANGE },
  { t: 0.33, u: -0.25, lt: 0.1, wu: 0.8, c: KOI_ORANGE },
  { t: 0.52, u: 0.2, lt: 0.075, wu: 0.6, c: KOI_DEEP },
  { t: 0.67, u: -0.15, lt: 0.09, wu: 0.85, c: KOI_ORANGE },
  { t: 0.85, u: 0.05, lt: 0.07, wu: 0.7, c: KOI_DEEP },
];

function paintFishBody(): void {
  // Rasterise: stamp a disc per spine sample; per pixel store (t, u).
  // perp = (-ty, tx) points toward the belly side of the leap.
  for (let i = 0; i < N_SPINE; i++) {
    const t = i / (N_SPINE - 1);
    const cx = spineX[i];
    const cy = spineY[i];
    const r = spineR[i];
    const px = -spineTY[i];
    const py = spineTX[i];
    const x0 = Math.max(0, Math.floor(cx - r));
    const x1 = Math.min(W - 1, Math.ceil(cx + r));
    const y0 = Math.max(0, Math.floor(cy - r));
    const y1 = Math.min(H - 1, Math.ceil(cy + r));
    for (let y = y0; y <= y1; y++) {
      const dy = y - cy;
      for (let x = x0; x <= x1; x++) {
        const dx = x - cx;
        const d2 = dx * dx + dy * dy;
        if (d2 > r * r) continue;
        const d = Math.sqrt(d2);
        const u = d > 0 ? (dx * px + dy * py) / r : 0;
        const idx = y * W + x;
        bodyMask[idx] = 1;
        bodyT[idx] = t;
        bodyU[idx] = clamp(u, -1, 1);
      }
    }
  }
  // Colour the body in one pass over its bounding box.
  for (let y = 180; y <= 960; y++) {
    for (let x = 90; x <= 960; x++) {
      const idx = y * W + x;
      if (!bodyMask[idx]) continue;
      const t = bodyT[idx];
      const u = bodyU[idx];
      // Base: warm cream on top fading to a white belly.
      let c: RGB = blend([255, 226, 190], KOI_CREAM, smooth(-0.1, 0.9, u));
      // Darker rim at the top edge, and a warm tint toward the tail.
      const edge = smooth(0.86, 1.0, Math.abs(u));
      c = blend(c, KOI_DEEP, edge * 0.55);
      c = blend(c, [200, 120, 60], smooth(0.12, 0.0, t) * 0.35);
      // Orange / deep-orange patches.
      for (const p of PATCHES) {
        const mt = 1 - smooth(0.55, 1.0, Math.abs(t - p.t) / p.lt);
        const mu = 1 - smooth(0.55, 1.0, Math.abs(u - p.u) / p.wu);
        const m = mt * mu;
        if (m > 0) c = blend(c, p.c, m * 0.92);
      }
      // Belly highlight stripe.
      const belly = smooth(0.45, 0.95, u) * 0.5;
      c = blend(c, [255, 255, 255], belly * 0.35);
      const fi = idx * 3;
      fb[fi] = c[0];
      fb[fi + 1] = c[1];
      fb[fi + 2] = c[2];
    }
  }
}

function paintFishScales(): void {
  // Rows of small scale arcs following the body curve.
  for (let t = 0.1; t <= 0.94; t += 0.052) {
    const s = spineAt(t);
    const px = -s.ty;
    const py = s.tx;
    for (let u = -0.72; u <= 0.72; u += 0.24) {
      const cx = s.x + px * u * s.r;
      const cy = s.y + py * u * s.r;
      const idx = Math.round(cy) * W + Math.round(cx);
      if (idx < 0 || idx >= W * H || !bodyMask[idx]) continue;
      // One scale = 5 dots along a small downward arc.
      const sr = 8 + s.r * 0.05;
      for (let k = 0; k <= 4; k++) {
        const ang = Math.PI * (0.15 + 0.7 * (k / 4));
        const ox = Math.cos(ang) * sr;
        const oy = Math.sin(ang) * sr * 0.8;
        const rx = ox * s.tx - oy * px;
        const ry = ox * s.ty - oy * py;
        setPx(cx + rx, cy + ry, 190, 90, 30, 0.18);
      }
    }
  }
}

function paintFishFins(): void {
  // Dorsal fin along the top edge: one smooth low ridge built from
  // overlapping discs — a continuous fin, never a comb of spikes.
  for (let t = 0.32; t <= 0.66; t += 0.012) {
    const s = spineAt(t);
    const px = -s.ty;
    const py = s.tx;
    const h = 6 + 11 * Math.sin(((t - 0.32) / 0.34) * Math.PI);
    blob(s.x - px * (s.r * 0.96 + h), s.y - py * (s.r * 0.96 + h), 10, KOI_ORANGE, 0.9, 0);
  }
  for (let t = 0.32; t <= 0.66; t += 0.008) {
    const s = spineAt(t);
    const px = -s.ty;
    const py = s.tx;
    const h = 14 + 12 * Math.sin(((t - 0.32) / 0.34) * Math.PI);
    blob(s.x - px * (s.r * 0.96 + h), s.y - py * (s.r * 0.96 + h), 5, KOI_DEEP, 0.9, 0);
  }
  // Tail: a narrow forked fan trailing behind the leap — two lobes sweeping
  // down-left together, soft rounded tips, drawn as tapered ribbons.
  const ribbon = (
    c0: [number, number],
    c1: [number, number],
    r0: number,
    r1: number,
    col: RGB,
  ): void => {
    const steps = 40;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const u = 1 - t;
      const x = u * u * SP0[0] + 2 * u * t * c0[0] + t * t * c1[0];
      const y = u * u * SP0[1] + 2 * u * t * c0[1] + t * t * c1[1];
      blob(x, y, lerp(r0, r1, t), col, 0.92, 0);
    }
  };
  ribbon([95, 815], [38, 758], 30, 11, KOI_ORANGE);
  ribbon([88, 838], [30, 778], 18, 7, KOI_CREAM);
  ribbon([105, 935], [62, 962], 30, 11, KOI_ORANGE);
  ribbon([108, 920], [72, 950], 18, 7, KOI_CREAM);
}

function paintFishHead(): void {
  const s = spineAt(0.93);
  const px = -s.ty;
  const py = s.tx;
  // Eye, on the top side of the head.
  const ex = s.x - px * s.r * 0.32;
  const ey = s.y - py * s.r * 0.32;
  blob(ex, ey, 15, KOI_ORANGE, 0.5, 0);
  blob(ex, ey, 12, [18, 14, 28], 1, 1);
  blob(ex - 4, ey - 4, 4.5, [255, 255, 255], 1, 0);
  // Mouth: a small dark curve at the nose.
  const n = spineAt(0.985);
  blob(n.x - n.tx * 4, n.y - n.ty * 4, 5, [70, 25, 20], 0.85, 1);
  // Barbels (whiskers) sweeping back from the nose.
  line(n.x, n.y + 6, n.x - 46, n.y + 34, 3, KOI_CREAM, 0.75);
  line(n.x, n.y + 10, n.x - 40, n.y + 44, 3, KOI_CREAM, 0.6);
}

// The ring's near (lower) arc passes IN FRONT of the fish.
function paintRingFront(): void {
  ringArc(Math.PI * 0.55, Math.PI * 1.02, 17, FIRE_OUT, 0.95);
  ringArc(Math.PI * 0.55, Math.PI * 1.02, 11, FIRE_MID, 0.95);
  ringArc(Math.PI * 0.55, Math.PI * 1.02, 5.5, FIRE_CORE, 0.95);
}

// ---------------------------------------------------------------------------
// 6. Splash, spray droplets, speed lines, vignette.
// ---------------------------------------------------------------------------
function paintSplash(): void {
  // The tail bursts out of the water: foam crown + spray arcs.
  const SX = 150;
  const SY = 872;
  for (let k = 0; k < 60; k++) {
    const a = Math.PI + rnd() * Math.PI; // upper-half fan
    const r = between(10, 95);
    const x = SX + Math.cos(a) * r * 1.6;
    const y = SY + Math.sin(a) * r * 0.9;
    blob(x, y, between(3, 10), FOAM, between(0.35, 0.9), 1.5);
  }
  // Concentric spray arcs rising from the burst.
  for (let k = 0; k < 5; k++) {
    const r = 40 + k * 26;
    const steps = 26;
    for (let i = 0; i <= steps; i++) {
      const a = Math.PI * (1.08 + (0.84 * i) / steps);
      blob(SX + Math.cos(a) * r * 1.5, SY + Math.sin(a) * r * 0.8, 3.2, FOAM, 0.55, 1);
    }
  }
  // Droplets flung along the leap — bright, lit by the ring on one side.
  // Never on the fish itself: they would read as spots on its skin.
  for (let k = 0; k < 240; k++) {
    const t = rnd();
    const s = spineAt(t);
    const spread = between(20, 130) * (0.4 + t);
    const ang = between(-0.9, 0.9) - 0.5; // mostly upward/outward
    const x = s.x + Math.cos(ang) * spread;
    const y = s.y + Math.sin(ang) * spread - between(0, 40);
    if (x < 0 || y < 0 || x >= W || y >= H) continue;
    if (bodyMask[Math.round(y) * W + Math.round(x)]) continue;
    const lit = smooth(300, 700, x); // droplets near the ring catch firelight
    const col: RGB = blend(FOAM, [255, 190, 90], lit * 0.8);
    blob(x, y, between(1.6, 6.5), col, between(0.5, 0.95), 0.8);
  }
  // A few big backlit droplets right where the fish exits the ring.
  for (let k = 0; k < 14; k++) {
    const a = rnd() * Math.PI * 2;
    const r = between(200, 270);
    const x = RING_X + Math.cos(a) * r;
    const y = RING_Y + Math.sin(a) * r * 0.8;
    blob(x, y, between(3, 8), [255, 200, 110], between(0.6, 0.95), 1);
  }
}

function paintSpeedLines(): void {
  // Diagonal streaks along the leap direction (about -31 degrees).
  const ang = -0.54;
  const dx = Math.cos(ang);
  const dy = Math.sin(ang);
  for (let k = 0; k < 18; k++) {
    const x = between(40, 980);
    const y = between(60, 700);
    const len = between(90, 300);
    const wdt = between(2.5, 7);
    const col: RGB = rnd() < 0.6 ? [255, 220, 160] : [255, 255, 255];
    line(x, y, x + dx * len, y + dy * len, wdt, col, between(0.05, 0.13));
  }
}

function paintVignette(): void {
  const cx = W / 2;
  const cy = H / 2;
  const maxD = Math.hypot(cx, cy);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const d = Math.hypot(x - cx, y - cy) / maxD;
      const f = 1 - 0.24 * smooth(0.52, 1.0, d);
      if (f >= 0.999) continue;
      const i = (y * W + x) * 3;
      fb[i] *= f;
      fb[i + 1] *= f;
      fb[i + 2] *= f;
    }
  }
}

// ---------------------------------------------------------------------------
// Main: paint in order, quantise, encode, write.
// ---------------------------------------------------------------------------
function main(): void {
  paintSky();
  paintSun();
  paintOcean();
  paintSpeedLines();
  paintRingBack();
  paintFishBody();
  paintFishScales();
  paintFishFins();
  paintFishHead();
  paintRingFront();
  paintSplash();
  paintVignette();

  const rgb = new Uint8Array(W * H * 3);
  for (let i = 0; i < W * H * 3; i++) {
    const v = fb[i];
    rgb[i] = v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
  }
  const png = encodePng(rgb, W, H);
  const outDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'entry.png'), png);
}

main();
