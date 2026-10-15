#!/usr/bin/env node
/**
 * The Windows tray icon, made from the mark.
 *
 *   node scripts/make-tray-ico.mjs          writes electron/resources/tray.ico and tray-attention.ico
 *   node scripts/make-tray-ico.mjs --check  exits 1 when the committed files differ from what it makes
 *
 * Reads the 4x4 grid of public/icon.svg (which cells are lit, which dim, the
 * accent colour) and draws it pixel-snapped at every size Windows picks from a
 * tray .ico: 16, 20, 24, 32 and 48 px (100 % to 200 % and Explorer). Each
 * square is a whole number of pixels with a 1 px gap, so no edge is ever
 * resampled into a blur. The tile behind the grid is left out: at 16 px it
 * would shrink the grid to 2 px squares. The dim cells are the accent at a
 * third of its opacity rather than the svg's opaque #2E2015, which disappears
 * on a dark taskbar.
 *
 * tray-attention.ico is the same grid with the badge Tars has always drawn
 * over its tray icon when an agent waits: a red (#ef4444) dot in the top right
 * corner, radius max(3, round(size * 0.15)).
 *
 * No dependency: 32-bit BMP entries in an ICO container, written byte by byte,
 * so the output is identical on every machine.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

export const TRAY_ICON_SIZES = [16, 20, 24, 32, 48];

/** size -> [square side, gap], chosen so 4 squares and 3 gaps fill the icon. */
const GRID = { 16: [3, 1], 20: [4, 1], 24: [5, 1], 32: [7, 1], 48: [11, 1] };

/** About a third: the dim cells read on dark and light taskbars alike. */
const DIM_ALPHA = 84;

const BADGE = [0xef, 0x44, 0x44];

function hexRgb(hex) {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) throw new Error(`not a #rrggbb colour: ${hex}`);
  return [1, 2, 3].map((i) => parseInt(m[i], 16));
}

/** The grid in icon.svg: the lit cells as [col, row], and the accent. */
export function readMark(svg) {
  const groups = [...svg.matchAll(/<g fill="(#[0-9A-Fa-f]{6})">([\s\S]*?)<\/g>/g)];
  if (groups.length !== 2) throw new Error(`icon.svg: expected a lit and a dim group, found ${groups.length}`);
  const cells = (body) => [...body.matchAll(/<rect x="(\d+)" y="(\d+)"/g)].map((m) => [Number(m[1]), Number(m[2])]);
  const [lit, dim] = groups.map((g) => ({ fill: g[1], cells: cells(g[2]) }));
  const all = [...lit.cells, ...dim.cells];
  const xs = [...new Set(all.map((c) => c[0]))].sort((a, b) => a - b);
  const ys = [...new Set(all.map((c) => c[1]))].sort((a, b) => a - b);
  if (xs.length !== 4 || ys.length !== 4 || all.length !== 16) throw new Error('icon.svg: expected a 4x4 grid');
  return {
    accent: hexRgb(lit.fill),
    lit: new Set(lit.cells.map(([x, y]) => `${xs.indexOf(x)},${ys.indexOf(y)}`)),
  };
}

/** One size as RGBA rows, top down. */
function draw(size, mark, badge) {
  const px = new Uint8Array(size * size * 4);
  const [side, gap] = GRID[size];
  const off = Math.floor((size - (4 * side + 3 * gap)) / 2);
  for (let row = 0; row < 4; row++) {
    for (let col = 0; col < 4; col++) {
      const alpha = mark.lit.has(`${col},${row}`) ? 255 : DIM_ALPHA;
      for (let y = 0; y < side; y++) {
        for (let x = 0; x < side; x++) {
          const i = ((off + row * (side + gap) + y) * size + off + col * (side + gap) + x) * 4;
          px.set([...mark.accent, alpha], i);
        }
      }
    }
  }
  if (badge) {
    const r = Math.max(3, Math.round(size * 0.15));
    const cx = size - r - 1;
    const cy = r + 1;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) px.set([...BADGE, 255], (y * size + x) * 4);
      }
    }
  }
  return px;
}

/** A 32-bit BMP entry as an ICO stores it: header, BGRA bottom up, an empty AND mask. */
function bmpEntry(size, rgba) {
  const maskRow = Math.ceil(size / 32) * 4;
  const buf = Buffer.alloc(40 + size * size * 4 + maskRow * size);
  buf.writeUInt32LE(40, 0);
  buf.writeInt32LE(size, 4);
  buf.writeInt32LE(size * 2, 8);
  buf.writeUInt16LE(1, 12);
  buf.writeUInt16LE(32, 14);
  buf.writeUInt32LE(0, 16);
  buf.writeUInt32LE(size * size * 4 + maskRow * size, 20);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const s = (y * size + x) * 4;
      const d = 40 + ((size - 1 - y) * size + x) * 4;
      buf[d] = rgba[s + 2];
      buf[d + 1] = rgba[s + 1];
      buf[d + 2] = rgba[s];
      buf[d + 3] = rgba[s + 3];
    }
  }
  return buf;
}

function ico(images) {
  const header = Buffer.alloc(6 + images.length * 16);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach(({ size, data }, i) => {
    const e = 6 + i * 16;
    header[e] = size >= 256 ? 0 : size;
    header[e + 1] = size >= 256 ? 0 : size;
    header.writeUInt16LE(1, e + 4);
    header.writeUInt16LE(32, e + 6);
    header.writeUInt32LE(data.length, e + 8);
    header.writeUInt32LE(offset, e + 12);
    offset += data.length;
  });
  return Buffer.concat([header, ...images.map((i) => i.data)]);
}

/** Both icons, from the text of public/icon.svg. */
export function trayIcons(svg) {
  const mark = readMark(svg);
  const make = (badge) => ico(TRAY_ICON_SIZES.map((size) => ({ size, data: bmpEntry(size, draw(size, mark, badge)) })));
  return { normal: make(false), attention: make(true) };
}

const here = path.dirname(fileURLToPath(import.meta.url));
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.join(here, '..');
  const { normal, attention } = trayIcons(fs.readFileSync(path.join(root, 'public', 'icon.svg'), 'utf-8'));
  const out = { 'tray.ico': normal, 'tray-attention.ico': attention };
  const dir = path.join(root, 'electron', 'resources');
  if (process.argv.includes('--check')) {
    const stale = Object.entries(out).filter(([name, data]) => {
      const file = path.join(dir, name);
      return !fs.existsSync(file) || Buffer.compare(fs.readFileSync(file), data) !== 0;
    }).map(([name]) => name);
    if (stale.length) {
      console.error(`out of date: ${stale.join(', ')}; run node scripts/make-tray-ico.mjs`);
      process.exit(1);
    }
    console.log('tray icons up to date');
  } else {
    for (const [name, data] of Object.entries(out)) {
      fs.writeFileSync(path.join(dir, name), data);
      console.log(`wrote electron/resources/${name} (${data.length} bytes)`);
    }
  }
}
