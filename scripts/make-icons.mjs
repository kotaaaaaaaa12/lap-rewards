#!/usr/bin/env node
// Generates the PNG app icons (no dependencies). Wrangler runs this before every deploy
// (see "build" in wrangler.jsonc), so the repository only needs the SVG icon.
//   node scripts/make-icons.mjs [outputDir]
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const OUT = process.argv[2] || join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons');

const TOP = [10, 40, 98];
const BOTTOM = [44, 107, 240];
const COIN = [255, 214, 79];
const RIM = [240, 170, 20];
const WHITE = [255, 255, 255];

function starPoints(cx, cy, r) {
  const pts = [];
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const rad = r * (i % 2 === 0 ? 0.58 : 0.25);
    pts.push([cx + rad * Math.cos(a), cy + rad * Math.sin(a)]);
  }
  return pts;
}

function inPolygon(x, y, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i];
    const [xj, yj] = pts[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Color of one sample point in a unit square [0,1]x[0,1]; alpha 0 outside the icon shape. */
function sample(u, v, maskable) {
  if (!maskable) {
    // Rounded square background.
    const r = 0.22;
    const dx = Math.max(Math.abs(u - 0.5) - (0.5 - r), 0);
    const dy = Math.max(Math.abs(v - 0.5) - (0.5 - r), 0);
    if (dx * dx + dy * dy > r * r) return [0, 0, 0, 0];
  }
  let c = BOTTOM.map((b, i) => TOP[i] + (b - TOP[i]) * v);
  const scale = maskable ? 0.78 : 1; // keep artwork inside the maskable safe zone
  const d = Math.hypot(u - 0.5, v - 0.5) / scale;
  if (d <= 0.3) {
    c = COIN;
    if (Math.abs(d - 0.246) < 0.006) c = RIM;
    const star = starPoints(0.5, 0.5, 0.3 * scale);
    if (inPolygon(u, v, star)) c = WHITE;
  }
  return [c[0], c[1], c[2], 255];
}

function render(size, maskable) {
  const SS = 3; // supersampling for smooth edges
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const [cr, cg, cb, ca] = sample((x + (sx + 0.5) / SS) / size, (y + (sy + 0.5) / SS) / size, maskable);
          r += cr * ca; g += cg * ca; b += cb * ca; a += ca;
        }
      }
      const o = y * (size * 4 + 1) + 1 + x * 4;
      if (a > 0) { raw[o] = Math.round(r / a); raw[o + 1] = Math.round(g / a); raw[o + 2] = Math.round(b / a); }
      raw[o + 3] = Math.round(a / (SS * SS));
    }
  }
  return png(size, raw);
}

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size, raw) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
  ]);
}

mkdirSync(OUT, { recursive: true });
const files = {
  'icon-192.png': render(192, false),
  'icon-512.png': render(512, false),
  'icon-maskable-512.png': render(512, true),
  'apple-touch-icon.png': render(180, true), // iOS applies its own rounding
};
for (const [name, data] of Object.entries(files)) writeFileSync(join(OUT, name), data);
console.log(`Wrote ${Object.keys(files).length} icons to ${OUT}`);
