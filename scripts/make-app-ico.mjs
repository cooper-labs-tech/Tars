#!/usr/bin/env node
/**
 * The Windows app and installer icon, drawn from public/icon.svg.
 *
 *   node scripts/make-app-ico.mjs                 writes build/icon.ico
 *   node scripts/make-app-ico.mjs --out <file>    writes <file> instead
 *   node scripts/make-app-ico.mjs --check         exits 1 when the file is missing or not what it would write
 *
 * build/icon.ico is what package.json build.win.icon names, so it is the
 * Tars.exe icon, the installer's and the uninstaller's, and the shortcuts'. It
 * is not committed (/build is ignored): scripts/release-win.mjs writes it
 * before every Windows build, from the svg the macOS icon is also made from.
 *
 * Sizes 256, 128, 64, 48, 32 and 16: what Explorer, the taskbar, the Start menu
 * and the installer pick from, at 100 % to 200 %. electron-builder refuses an
 * .ico without 256.
 *
 * The svg is drawn here, not by a library: every <rect> (rounded or not), in
 * document order, its fill its own or its <g>'s, each pixel covered as much as
 * the shape covers it (exact for straight edges, 16 x 16 samples along a
 * rounded corner), composited source-over. Anything else in the svg (a path, a
 * circle, a transform, an opacity) is refused with its name rather than left
 * out. Plain JavaScript arithmetic and 32-bit BMP entries written byte by byte,
 * so the same svg gives the same bytes on every machine and every Node, which
 * is what `--check` relies on.
 *
 * Tested in __tests__/scripts/make-app-ico.test.ts.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

export const APP_ICON_SIZES = [256, 128, 64, 48, 32, 16];

/** Samples per pixel side where a rounded corner crosses it. */
const SAMPLES = 16;

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_OUT = path.join(ROOT, 'build', 'icon.ico');

function attributes(text) {
  const found = {};
  for (const m of text.matchAll(/([A-Za-z_:][\w:.-]*)\s*=\s*"([^"]*)"/g)) found[m[1]] = m[2];
  return found;
}

function colour(value, where) {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(value ?? '');
  if (!m) throw new Error(`icon.svg: ${where} has fill "${value}", and only #rrggbb is drawn`);
  return [1, 2, 3].map(i => parseInt(m[i], 16));
}

function number(value, name, where) {
  const n = Number(value);
  if (value === undefined || !Number.isFinite(n)) throw new Error(`icon.svg: ${where} has no numeric ${name}`);
  return n;
}

/**
 * The square canvas and the rects of an svg, in the order they are painted.
 * Throws on anything this file does not draw.
 */
export function readShapes(svg) {
  const shapes = [];
  const fills = [];
  let width;
  for (const m of svg.matchAll(/<(\/?)([A-Za-z][\w:-]*)([^>]*?)(\/?)>/g)) {
    const [, closing, tag, rest, selfClosing] = m;
    if (closing) {
      if (tag === 'g') fills.pop();
      continue;
    }
    const attrs = attributes(rest);
    if (tag === 'svg') {
      const box = (attrs.viewBox ?? `0 0 ${attrs.width} ${attrs.height}`).trim().split(/[\s,]+/).map(Number);
      if (box.length !== 4 || box[0] !== 0 || box[1] !== 0 || box[2] !== box[3] || !(box[2] > 0)) {
        throw new Error('icon.svg: expected a square viewBox starting at 0 0');
      }
      width = box[2];
    } else if (tag === 'title' || tag === 'desc') {
      continue;
    } else if (tag === 'g') {
      const other = Object.keys(attrs).filter(k => k !== 'fill');
      if (other.length) throw new Error(`icon.svg: a <g> with ${other.join(', ')}, which this file does not draw`);
      const inherited = fills.at(-1);
      if (!selfClosing) fills.push(attrs.fill === undefined ? inherited : colour(attrs.fill, '<g>'));
    } else if (tag === 'rect') {
      const other = Object.keys(attrs).filter(k => !['x', 'y', 'width', 'height', 'rx', 'ry', 'fill'].includes(k));
      if (other.length) throw new Error(`icon.svg: a <rect> with ${other.join(', ')}, which this file does not draw`);
      const where = `<rect${rest}>`;
      const rx = attrs.rx === undefined ? Number(attrs.ry ?? 0) : number(attrs.rx, 'rx', where);
      if (attrs.ry !== undefined && Number(attrs.ry) !== rx) throw new Error(`icon.svg: ${where} has rx and ry apart`);
      const fill = attrs.fill === undefined ? fills.at(-1) : colour(attrs.fill, where);
      if (!fill) throw new Error(`icon.svg: ${where} has no fill`);
      const rect = {
        x: attrs.x === undefined ? 0 : number(attrs.x, 'x', where),
        y: attrs.y === undefined ? 0 : number(attrs.y, 'y', where),
        width: number(attrs.width, 'width', where),
        height: number(attrs.height, 'height', where),
        rx,
        fill,
      };
      rect.rx = Math.min(rect.rx, rect.width / 2, rect.height / 2);
      shapes.push(rect);
    } else {
      throw new Error(`icon.svg: a <${tag}>, which this file does not draw`);
    }
  }
  if (width === undefined) throw new Error('icon.svg: no <svg> element');
  return { width, shapes };
}

function insideRounded(s, x, y) {
  if (x < s.x || x > s.x + s.width || y < s.y || y > s.y + s.height) return false;
  const r = s.rx;
  const cx = x < s.x + r ? s.x + r : x > s.x + s.width - r ? s.x + s.width - r : x;
  const cy = y < s.y + r ? s.y + r : y > s.y + s.height - r ? s.y + s.height - r : y;
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

/** How much of the pixel square [x0, x1] x [y0, y1] (svg units) the shape covers, 0 to 1. */
function coverage(s, x0, y0, x1, y1) {
  const w = Math.min(x1, s.x + s.width) - Math.max(x0, s.x);
  const h = Math.min(y1, s.y + s.height) - Math.max(y0, s.y);
  if (w <= 0 || h <= 0) return 0;
  const area = (w * h) / ((x1 - x0) * (y1 - y0));
  const r = s.rx;
  const nearCorner = r > 0
    && (x0 < s.x + r || x1 > s.x + s.width - r)
    && (y0 < s.y + r || y1 > s.y + s.height - r);
  if (!nearCorner) return area;
  let hits = 0;
  for (let j = 0; j < SAMPLES; j++) {
    for (let i = 0; i < SAMPLES; i++) {
      if (insideRounded(s, x0 + ((i + 0.5) / SAMPLES) * (x1 - x0), y0 + ((j + 0.5) / SAMPLES) * (y1 - y0))) hits++;
    }
  }
  return hits / (SAMPLES * SAMPLES);
}

/** One size as straight RGBA rows, top down. */
function draw(size, { width, shapes }) {
  const unit = width / size;
  const px = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // Premultiplied, 0 to 1.
      let r = 0, g = 0, b = 0, a = 0;
      for (const s of shapes) {
        const c = coverage(s, x * unit, y * unit, (x + 1) * unit, (y + 1) * unit);
        if (c === 0) continue;
        r = (s.fill[0] / 255) * c + r * (1 - c);
        g = (s.fill[1] / 255) * c + g * (1 - c);
        b = (s.fill[2] / 255) * c + b * (1 - c);
        a = c + a * (1 - c);
      }
      const alpha = Math.round(a * 255);
      if (alpha === 0) continue;
      px.set([Math.round((r / a) * 255), Math.round((g / a) * 255), Math.round((b / a) * 255), alpha], (y * size + x) * 4);
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
  return Buffer.concat([header, ...images.map(i => i.data)]);
}

/** The .ico, from the text of an svg. */
export function appIcon(svg) {
  const drawing = readShapes(svg);
  return ico(APP_ICON_SIZES.map(size => ({ size, data: bmpEntry(size, draw(size, drawing)) })));
}

function main(argv) {
  if (argv.includes('--help')) {
    console.log(`usage: node scripts/make-app-ico.mjs [--check] [--out <file>]\n  default out: ${path.relative(ROOT, DEFAULT_OUT)}`);
    return 0;
  }
  const at = argv.indexOf('--out');
  if (at !== -1 && !argv[at + 1]) {
    console.error('--out needs a file');
    return 2;
  }
  const out = at === -1 ? DEFAULT_OUT : path.resolve(argv[at + 1]);
  const data = appIcon(fs.readFileSync(path.join(ROOT, 'public', 'icon.svg'), 'utf8'));
  if (argv.includes('--check')) {
    if (!fs.existsSync(out) || !fs.readFileSync(out).equals(data)) {
      console.error(`out of date: ${out}; run node scripts/make-app-ico.mjs`);
      return 1;
    }
    console.log(`${out} is up to date`);
    return 0;
  }
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, data);
  console.log(`wrote ${out} (${data.length} bytes, ${APP_ICON_SIZES.join(', ')} px)`);
  return 0;
}

/** Node runs a module from its real path, so argv[1] is compared by real path: a subst drive or a junctioned checkout would never match as typed. */
function invokedDirectly() {
  try {
    return !!process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  process.exitCode = main(process.argv.slice(2));
}
