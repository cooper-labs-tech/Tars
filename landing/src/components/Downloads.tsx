import { Download, Github } from 'lucide-react';
import {
  BUTTON_NAME,
  NEEDS,
  OSES,
  OS_NAME,
  downloadHref,
  heroPrimary,
  othersLine,
  promised,
  type Arch,
  type Builds,
  type Os,
} from '../lib/platforms';

/**
 * The landing's downloads, macOS, Windows and Linux alike, as
 * design/landing.pen draws them: `Landing · desktop` (a Mac today) and
 * `Landing · downloads per OS` (each visitor's system, before and after its
 * build). The page reads the visitor's system in the browser, and the builds
 * and the newest release from /api/stats, and hands them here: these take no
 * state of their own.
 *
 * Imported by the root's tests: no landing-only package, no `@/` path.
 */

const ACCENT = 'flex items-center gap-2 px-5 py-2.5 bg-accent text-bg text-sm font-medium hover:bg-accent-deep transition-colors';

/**
 * The hero's buttons: the visitor's download, or the version it comes with
 * (that it is coming, once that version is out without it), or, for a system
 * not known, Download to the list below; then Source and GitHub's count;
 * under them, the other systems.
 */
export function HeroDownload({ visitor, arch = null, builds, latest, count }: {
  visitor: Os | null;
  arch?: Arch | null;
  builds: Builds | null;
  /** The newest published release, null when GitHub did not answer. */
  latest: string | null;
  count: number | null;
}) {
  const primary = heroPrimary(visitor, builds, latest);
  const line = othersLine(visitor, builds, latest);
  return (
    <>
      <div className="flex flex-wrap items-center gap-3">
        {primary.kind === 'download' && (
          <a href={downloadHref(primary.os, arch)} className={ACCENT}>
            <Download className="w-4 h-4" />
            {`Download for ${BUTTON_NAME[primary.os]}`}
          </a>
        )}
        {primary.kind === 'comes' && (
          <span className="py-2.5 text-sm text-ink-soft">{primary.version ? `Tars for ${OS_NAME[primary.os]} comes with ${primary.version}.` : `Tars for ${OS_NAME[primary.os]} is coming.`}</span>
        )}
        {primary.kind === 'list' && (
          <a href="#download" className={ACCENT}>
            <Download className="w-4 h-4" />
            Download
          </a>
        )}
        <a href="https://github.com/cooper-labs-tech/Tars" target="_blank" rel="noopener noreferrer" className="flex items-center gap-2 px-5 py-2.5 border border-line-strong text-sm text-ink-soft hover:text-ink transition-colors">
          <Github className="w-4 h-4" />
          Source
        </a>
        {/* GitHub's own count of installer downloads, every system's
            (src/lib/downloads.ts). Nothing while there is none, or when
            GitHub did not answer. */}
        {count !== null && count > 0 && (
          <span className="font-mono text-xs text-ink-muted">{`${count.toLocaleString()} downloads`}</span>
        )}
      </div>
      {line.length > 0 && (
        <p className="mt-3.5 font-mono text-xs text-ink-muted">
          {line.map((part, i) => (part.os
            ? <a key={i} href={downloadHref(part.os)} className="text-ink hover:text-accent transition-colors">{part.text}</a>
            : <span key={i}>{part.text}</span>))}
        </p>
      )}
    </>
  );
}

/** What a card without a build says: the version it comes with, or Coming. */
const comingText = (version: string | null) => (version ? `Comes with ${version}` : 'Coming');

/**
 * Get Tars: a card per system, in the frame's order, with what it runs on and
 * its download, or the version it comes with (Coming, once that version is out
 * without it). The visitor's architecture goes on their own system's link
 * only.
 */
export function GetTars({ builds, latest, visitor = null, arch = null }: {
  builds: Builds | null;
  /** The newest published release, null when GitHub did not answer. */
  latest: string | null;
  visitor?: Os | null;
  arch?: Arch | null;
}) {
  return (
    <section id="download" className="max-w-[1040px] mx-auto px-6 py-20 text-center">
      <h2 className="font-display text-4xl mb-4">Get Tars</h2>
      <p className="text-ink-soft text-[15px] mb-11 max-w-[520px] mx-auto">
        Desktop app for macOS, Windows and Linux. Free and open source. No account, no cloud in the middle.
      </p>
      <ul className="grid gap-5 md:grid-cols-3 max-w-[1000px] mx-auto text-left">
        {OSES.map(os => (
          <li key={os} className="border border-line p-6">
            <h3 className="font-display text-[26px] leading-[1.1]">{OS_NAME[os]}</h3>
            <p className="mt-1.5 font-mono text-xs leading-[1.45] text-ink-muted">{NEEDS[os]}</p>
            <div className="mt-[26px] flex">
              {!builds || builds[os] ? (
                <a href={downloadHref(os, os === visitor ? arch : null)} className={ACCENT}>
                  <Download className="w-4 h-4" />
                  {`Download for ${BUTTON_NAME[os]}`}
                </a>
              ) : (
                <p className="py-2.5 text-sm text-ink-soft">{comingText(promised(os, latest))}</p>
              )}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
