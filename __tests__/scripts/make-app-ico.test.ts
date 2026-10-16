import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { APP_ICON_SIZES, appIcon, readShapes } from '../../scripts/make-app-ico.mjs';

/**
 * scripts/make-app-ico.mjs: the Windows app and installer icon, drawn from
 * public/icon.svg at 256, 128, 64, 48, 32 and 16 px into one .ico.
 *
 * How it can fail, each case below:
 *  - a size is missing, or an entry says one size and holds another, so
 *    Explorer or the taskbar scales the wrong one (electron-builder refuses an
 *    .ico without 256);
 *  - the directory points past the file, or entries overlap: Windows shows the
 *    default icon;
 *  - the drawing is not the mark: the tile corner is not transparent, the tile
 *    is not #121212, a lit cell is not the accent;
 *  - two runs give two files, so `--check` can never pass and a build is not
 *    reproducible;
 *  - `--check` passes on a stale or missing file, or writes one;
 *  - an svg it cannot draw (a path, a circle) is drawn anyway, without it.
 */

const ROOT = path.resolve(__dirname, '..', '..');
const SCRIPT = path.join(ROOT, 'scripts', 'make-app-ico.mjs');
const SVG = fs.readFileSync(path.join(ROOT, 'public', 'icon.svg'), 'utf8');

type Entry = { width: number; height: number; bytes: number; offset: number; planes: number; bpp: number };

function directory(ico: Buffer): Entry[] {
  expect(ico.readUInt16LE(0)).toBe(0);
  expect(ico.readUInt16LE(2)).toBe(1);
  const count = ico.readUInt16LE(4);
  return Array.from({ length: count }, (_, i) => {
    const e = 6 + i * 16;
    return {
      width: ico[e] || 256,
      height: ico[e + 1] || 256,
      planes: ico.readUInt16LE(e + 4),
      bpp: ico.readUInt16LE(e + 6),
      bytes: ico.readUInt32LE(e + 8),
      offset: ico.readUInt32LE(e + 12),
    };
  });
}

/** The pixel at (x, y), top-left origin, as [r, g, b, a], from a 32-bit BMP entry. */
function pixel(ico: Buffer, entry: Entry, x: number, y: number): number[] {
  const header = ico.readUInt32LE(entry.offset);
  const size = ico.readInt32LE(entry.offset + 4);
  const d = entry.offset + header + ((size - 1 - y) * size + x) * 4;
  return [ico[d + 2], ico[d + 1], ico[d], ico[d + 3]];
}

describe('make-app-ico: the icon it draws', () => {
  it('holds exactly 256, 128, 64, 48, 32 and 16 px, each entry the size it says', () => {
    const ico = appIcon(SVG);
    const entries = directory(ico);
    expect(entries.map(e => e.width)).toEqual([256, 128, 64, 48, 32, 16]);
    expect(APP_ICON_SIZES).toEqual([256, 128, 64, 48, 32, 16]);
    for (const e of entries) {
      expect(e.height).toBe(e.width);
      expect(e.planes).toBe(1);
      expect(e.bpp).toBe(32);
      // The BMP header inside says the same size (height doubled, as an ICO stores it).
      expect(ico.readUInt32LE(e.offset)).toBe(40);
      expect(ico.readInt32LE(e.offset + 4)).toBe(e.width);
      expect(ico.readInt32LE(e.offset + 8)).toBe(e.width * 2);
    }
  });

  it('lays the entries end to end inside the file, none overlapping', () => {
    const ico = appIcon(SVG);
    const entries = directory(ico);
    let next = 6 + entries.length * 16;
    for (const e of entries) {
      expect(e.offset).toBe(next);
      next += e.bytes;
    }
    expect(next).toBe(ico.length);
  });

  it('draws the mark: a transparent corner, the dark tile, the accent in a lit cell', () => {
    const ico = appIcon(SVG);
    const [big] = directory(ico);
    // The corner is outside the rounded tile (rx 230 of 1024).
    expect(pixel(ico, big, 0, 0)[3]).toBe(0);
    // The middle of the top edge is tile, #121212, opaque.
    expect(pixel(ico, big, 128, 2)).toEqual([0x12, 0x12, 0x12, 255]);
    // The first lit cell of icon.svg spans x 196..327 of 1024: its centre at 256 px.
    expect(pixel(ico, big, 65, 65)).toEqual([0xff, 0x9e, 0x42, 255]);
    // Antialiased, not thresholded: the tile's curved edge has partial coverage somewhere.
    const alphas = new Set(Array.from({ length: 60 }, (_, i) => pixel(ico, big, i, i)[3]));
    expect([...alphas].some(a => a > 0 && a < 255)).toBe(true);
  });

  it('gives the same bytes twice: the build is reproducible', () => {
    expect(appIcon(SVG).equals(appIcon(SVG))).toBe(true);
  });

  it('refuses an svg with a shape it does not draw, rather than leave it out', () => {
    const withPath = SVG.replace('</svg>', '<path d="M0 0L10 10"/></svg>');
    expect(() => appIcon(withPath)).toThrow(/path/);
    const withCircle = SVG.replace('</svg>', '<circle cx="1" cy="1" r="1"/></svg>');
    expect(() => appIcon(withCircle)).toThrow(/circle/);
  });

  it('reads every rect of icon.svg with its fill, the group fill inherited', () => {
    const { width, shapes } = readShapes(SVG);
    expect(width).toBe(1024);
    expect(shapes).toHaveLength(17);
    expect(shapes[0]).toMatchObject({ x: 0, y: 0, width: 1024, height: 1024, rx: 230, fill: [0x12, 0x12, 0x12] });
    expect(shapes.filter(s => s.fill.join() === [0xff, 0x9e, 0x42].join())).toHaveLength(13);
    expect(shapes.filter(s => s.fill.join() === [0x2e, 0x20, 0x15].join())).toHaveLength(3);
  });
});

describe('make-app-ico: the command', () => {
  let dir: string;
  const run = (...args: string[]) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-app-ico-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('writes the icon where --out says, and --check then passes', () => {
    const out = path.join(dir, 'nested', 'icon.ico');
    execFileSync(process.execPath, [SCRIPT, '--out', out]);
    expect(fs.readFileSync(out).equals(appIcon(SVG))).toBe(true);
    const check = run('--check', '--out', out);
    expect(check.status).toBe(0);
  });

  it('runs through a link to scripts/, as from a subst drive or a junctioned checkout, and writes the icon', () => {
    // Node runs the module from its real path: a guard comparing it with the
    // path as typed never matched, and the command exited 0 having written
    // nothing, so release:win packed whatever build/icon.ico already held.
    const link = path.join(dir, 'linked-scripts');
    fs.symlinkSync(path.dirname(SCRIPT), link, 'junction'); // a junction on Windows, a directory symlink elsewhere
    try {
      const out = path.join(dir, 'via-link.ico');
      const r = spawnSync(process.execPath, [path.join(link, 'make-app-ico.mjs'), '--out', out], { encoding: 'utf8' });
      expect(r.status).toBe(0);
      expect(fs.existsSync(out) && fs.readFileSync(out).equals(appIcon(SVG))).toBe(true);
    } finally {
      // The link alone: rmdir removes a junction without following it, unlink a symlink.
      (process.platform === 'win32' ? fs.rmdirSync : fs.unlinkSync)(link);
    }
  });

  it('--check exits 1 on a stale icon, and leaves it as it was', () => {
    const out = path.join(dir, 'icon.ico');
    fs.writeFileSync(out, 'stale');
    const check = run('--check', '--out', out);
    expect(check.status).toBe(1);
    expect(check.stderr).toMatch(/out of date/);
    expect(fs.readFileSync(out, 'utf8')).toBe('stale');
  });

  it('--check exits 1 on a missing icon, and does not create it', () => {
    const out = path.join(dir, 'icon.ico');
    const check = run('--check', '--out', out);
    expect(check.status).toBe(1);
    expect(fs.existsSync(out)).toBe(false);
  });

  it('writes build/icon.ico by default, the path package.json build.win.icon names', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    expect(pkg.build.win.icon).toBe('build/icon.ico');
    // The default is read from the script's own help, not run: a test never writes into the checkout.
    const help = run('--help');
    expect(help.status).toBe(0);
    expect(help.stdout).toMatch(/build[\\/]icon\.ico/);
  });
});
