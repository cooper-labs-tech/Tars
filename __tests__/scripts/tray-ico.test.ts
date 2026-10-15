import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

// @ts-expect-error: a plain .mjs build script, no declaration file.
import { trayIcons, TRAY_ICON_SIZES } from '../../scripts/make-tray-ico.mjs';

/**
 * The Windows tray icon: the orange 4x4 grid of public/icon.svg,
 * pixel-snapped at every size Windows asks for, in one .ico.
 *
 * How it fails, written before the code (2026-09-26):
 * 1. The committed .ico files are not what the generator makes from
 *    public/icon.svg today (edited by hand, or the mark changed and the icon
 *    did not follow): not reproducible.
 * 2. A size Windows picks at 100 / 125 / 150 / 200 % or in Explorer is
 *    missing (16, 20, 24, 32, 48), so Windows resamples and the grid blurs.
 * 3. Not pixel-snapped: a square's edge falls between pixels, leaving
 *    half-transparent or half-orange pixels, or squares of unequal size.
 * 4. Not the mark: other than 13 lit squares in reading order and 3 dim ones
 *    at the bottom right, or a colour other than the accent #FF9E42; the
 *    `>_` prompt of trayColor.png.
 * 5. The dim squares are the svg's opaque #2E2015, which disappears on a dark
 *    taskbar, instead of the accent at about a third of its opacity.
 * 6. The background is not transparent (a tile, a white matte).
 * 7. The attention variant loses the grid, or carries no badge, or the badge
 *    is not today's red dot in the top right corner.
 */

const ROOT = process.cwd();
const RES = path.join(ROOT, 'electron', 'resources');

interface Img { size: number; px: (x: number, y: number) => [number, number, number, number] }

/** Reads the 32-bit BMP entries of an .ico. */
function decodeIco(buf: Buffer): Img[] {
  expect(buf.readUInt16LE(0)).toBe(0);
  expect(buf.readUInt16LE(2)).toBe(1);
  const count = buf.readUInt16LE(4);
  const out: Img[] = [];
  for (let i = 0; i < count; i++) {
    const e = 6 + i * 16;
    const size = buf[e] || 256;
    const offset = buf.readUInt32LE(e + 12);
    expect(buf.readUInt32LE(offset)).toBe(40); // BITMAPINFOHEADER
    expect(buf.readInt32LE(offset + 4)).toBe(size);
    expect(buf.readInt32LE(offset + 8)).toBe(size * 2);
    expect(buf.readUInt16LE(offset + 14)).toBe(32);
    const pixels = offset + 40;
    out.push({
      size,
      // Bottom-up BGRA.
      px: (x, y) => {
        const o = pixels + ((size - 1 - y) * size + x) * 4;
        return [buf[o + 2], buf[o + 1], buf[o], buf[o + 3]];
      },
    });
  }
  return out;
}

const ORANGE = [0xff, 0x9e, 0x42];

describe('tray .ico', () => {
  const made = trayIcons(fs.readFileSync(path.join(ROOT, 'public', 'icon.svg'), 'utf-8'));

  it('the committed files are exactly what the generator makes from public/icon.svg', () => {
    expect(Buffer.compare(fs.readFileSync(path.join(RES, 'tray.ico')), made.normal)).toBe(0);
    expect(Buffer.compare(fs.readFileSync(path.join(RES, 'tray-attention.ico')), made.attention)).toBe(0);
  });

  it('holds 16, 20, 24, 32 and 48 px', () => {
    expect(TRAY_ICON_SIZES).toEqual([16, 20, 24, 32, 48]);
    expect(decodeIco(made.normal).map((i) => i.size).sort((a, b) => a - b)).toEqual([16, 20, 24, 32, 48]);
    expect(decodeIco(made.attention).map((i) => i.size).sort((a, b) => a - b)).toEqual([16, 20, 24, 32, 48]);
  });

  for (const img of decodeIco(trayIcons(fs.readFileSync(path.join(process.cwd(), 'public', 'icon.svg'), 'utf-8')).normal)) {
    it(`${img.size} px: 13 lit and 3 dim squares, equal, pixel-snapped, on transparency`, () => {
      const kinds = new Map<string, number>();
      for (let y = 0; y < img.size; y++) {
        for (let x = 0; x < img.size; x++) {
          const [r, g, b, a] = img.px(x, y);
          if (a === 0) { kinds.set('clear', (kinds.get('clear') ?? 0) + 1); continue; }
          expect([r, g, b]).toEqual(ORANGE);
          const k = a === 255 ? 'lit' : 'dim';
          if (k === 'dim') { expect(a).toBeGreaterThan(70); expect(a).toBeLessThan(100); }
          kinds.set(k, (kinds.get(k) ?? 0) + 1);
        }
      }
      // Every square has the same whole-pixel side, so the counts divide evenly.
      const lit = kinds.get('lit') ?? 0;
      const dim = kinds.get('dim') ?? 0;
      const side = Math.sqrt(lit / 13);
      expect(Number.isInteger(side)).toBe(true);
      expect(dim).toBe(3 * side * side);
      // Nothing else is painted: no tile, no matte.
      expect(img.size * img.size - (kinds.get('clear') ?? 0)).toBe(16 * side * side);
      // The bottom painted row: one lit square, then three dim, left to right.
      let row = img.size - 1;
      while ([...Array(img.size).keys()].every((x) => img.px(x, row)[3] === 0)) row--;
      const cols = [...Array(img.size).keys()].map((x) => img.px(x, row)[3]).filter((a) => a > 0);
      expect(cols.length).toBe(4 * side);
      expect(cols.slice(0, side).every((a) => a === 255)).toBe(true);
      expect(cols.slice(side).every((a) => a > 0 && a < 255)).toBe(true);
    });
  }

  it('the attention variant is the same grid with the red dot of today, top right', () => {
    const normal = decodeIco(made.normal);
    const attention = decodeIco(made.attention);
    for (const img of attention) {
      const base = normal.find((n) => n.size === img.size)!;
      const dotR = Math.max(3, Math.round(img.size * 0.15));
      const [r, g, b, a] = img.px(img.size - dotR - 1, dotR + 1);
      expect([r, g, b, a]).toEqual([0xef, 0x44, 0x44, 255]);
      // Bottom left square untouched.
      const y = img.size - 2;
      for (let x = 0; x < img.size / 2; x++) expect(img.px(x, y)).toEqual(base.px(x, y));
    }
  });
});
