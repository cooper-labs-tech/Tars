'use client';

import React from 'react';
import { reportLinkTarget } from '@/lib/report-links';
import { localFileUrl } from '@/lib/local-file-url';

/**
 * A project's report, which an agent wrote (2.0.4, #471): a link opens a file of its folder here or a page in the
 * browser, anything else is text, and a picture is never fetched (src/lib/report-links.ts). Without it, a vault
 * document renders as it always has.
 */
export interface ReportLinks {
  /** The files of the report's folder. */
  names: readonly string[];
  openFile: (name: string) => void;
}

/** A picture of a report: a link to it, never the picture itself. */
function reportPicture(alt: string, src: string, links: ReportLinks, key: number): React.ReactNode {
  const target = reportLinkTarget(src, links.names);
  if (target.kind === 'page') {
    return (
      <span key={key} className="inline-flex flex-wrap items-center gap-2 my-1 px-2.5 py-1.5 bg-secondary border border-border text-[11.5px]">
        <span className="text-muted-foreground">picture from the web, not loaded:</span>
        <a href={target.url} target="_blank" rel="noopener noreferrer" className="font-mono text-primary hover:underline">{target.url.replace(/^https?:\/\//i, '')}</a>
      </span>
    );
  }
  if (target.kind === 'file') {
    return <button key={key} type="button" onClick={() => links.openFile(target.name)} className="text-primary hover:underline">{alt || target.name}</button>;
  }
  return <span key={key}>{alt}</span>;
}

/** A link of a report: a file of its folder opened here, a page in the browser, or its words alone. */
function reportLink(label: string, href: string, links: ReportLinks, key: number): React.ReactNode {
  const target = reportLinkTarget(href, links.names);
  if (target.kind === 'page') {
    return <a key={key} href={target.url} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">{label}</a>;
  }
  if (target.kind === 'file') {
    return <button key={key} type="button" onClick={() => links.openFile(target.name)} className="text-primary hover:underline">{label}</button>;
  }
  return <span key={key}>{label}</span>;
}

const SAFE_URL_PROTOCOLS = ['http:', 'https:', 'mailto:'];

export function isSafeUrl(href: string): string {
  const trimmed = href.trim();
  // Allow relative URLs and fragments
  if (trimmed.startsWith('/') || trimmed.startsWith('./') || trimmed.startsWith('../') || trimmed.startsWith('#')) {
    return trimmed;
  }
  try {
    const parsed = new URL(trimmed);
    if (SAFE_URL_PROTOCOLS.includes(parsed.protocol)) {
      return trimmed;
    }
  } catch {
    // Not a valid absolute URL - treat as relative (safe)
    return trimmed;
  }
  // Blocked protocol (javascript:, data:, vbscript:, etc.)
  return '#';
}

/**
 * A local picture is read through this Tars's own API (localFileUrl). With no port known it has no source, and shows
 * its alt text as a missing picture does.
 */
function resolveLocalSrc(src: string): string | undefined {
  if (src.startsWith('/') || /^[A-Z]:\\/.test(src)) {
    return localFileUrl(src) ?? undefined;
  }
  return src;
}

// Render inline markdown (bold, italic, code, images, links)
function renderInline(text: string, links?: ReportLinks): React.ReactNode {
  const parts: React.ReactNode[] = [];
  let remaining = text;
  let key = 0;

  while (remaining.length > 0) {
    // Inline code
    const codeMatch = remaining.match(/^`([^`]+)`/);
    if (codeMatch) {
      parts.push(<code key={key++} className="px-1 py-0.5 text-xs bg-secondary rounded font-mono">{codeMatch[1]}</code>);
      remaining = remaining.slice(codeMatch[0].length);
      continue;
    }

    // Bold
    const boldMatch = remaining.match(/^\*\*([^*]+)\*\*/);
    if (boldMatch) {
      parts.push(<strong key={key++}>{boldMatch[1]}</strong>);
      remaining = remaining.slice(boldMatch[0].length);
      continue;
    }

    // Italic
    const italicMatch = remaining.match(/^\*([^*]+)\*/);
    if (italicMatch) {
      parts.push(<em key={key++}>{italicMatch[1]}</em>);
      remaining = remaining.slice(italicMatch[0].length);
      continue;
    }

    // Image ![alt](src) - check before links
    if (remaining.startsWith('![')) {
      const closeBracket = remaining.indexOf(']', 2);
      if (closeBracket !== -1 && remaining[closeBracket + 1] === '(') {
        const closeParen = remaining.indexOf(')', closeBracket + 2);
        if (closeParen !== -1) {
          const alt = remaining.slice(2, closeBracket);
          const raw = remaining.slice(closeBracket + 2, closeParen);
          parts.push(links ? reportPicture(alt, raw, links, key++) : (
            <img key={key++} src={resolveLocalSrc(raw)} alt={alt} className="max-w-full rounded my-2 inline-block" />
          ));
          remaining = remaining.slice(closeParen + 1);
          continue;
        }
      }
    }

    // Link [text](url)
    if (remaining.startsWith('[')) {
      const closeBracket = remaining.indexOf(']', 1);
      if (closeBracket !== -1 && remaining[closeBracket + 1] === '(') {
        const closeParen = remaining.indexOf(')', closeBracket + 2);
        if (closeParen !== -1) {
          const linkText = remaining.slice(1, closeBracket);
          const rawHref = remaining.slice(closeBracket + 2, closeParen);
          parts.push(links ? reportLink(linkText, rawHref, links, key++) : (
            <a key={key++} href={isSafeUrl(rawHref)} className="text-primary underline hover:text-primary/80" target="_blank" rel="noopener noreferrer">
              {linkText}
            </a>
          ));
          remaining = remaining.slice(closeParen + 1);
          continue;
        }
      }
    }

    // Regular text - advance to next special character
    const nextSpecial = remaining.search(/[`*\[!]/);
    if (nextSpecial === -1) {
      parts.push(remaining);
      break;
    } else if (nextSpecial === 0) {
      // Special char didn't match any pattern above - emit as text
      parts.push(remaining[0]);
      remaining = remaining.slice(1);
    } else {
      parts.push(remaining.slice(0, nextSpecial));
      remaining = remaining.slice(nextSpecial);
    }
  }

  return <>{parts}</>;
}

const DOCUMENT_STYLE = {
  h1: 'text-2xl font-bold text-foreground mt-4 mb-2',
  h2: 'text-xl font-bold text-foreground mt-3 mb-2',
  h3: 'text-lg font-semibold text-foreground mt-3 mb-1',
  item: 'text-sm text-foreground',
  p: 'text-sm text-foreground my-0.5',
  pre: 'bg-secondary/80 border border-border rounded-lg p-3 my-2 overflow-x-auto text-xs',
};

/** A report as the frame `Vault · project folders · a report` draws it. */
const REPORT_STYLE = {
  h1: 'text-base text-foreground mt-2 mb-2',
  h2: 'text-[13px] text-foreground mt-3 mb-1',
  h3: 'text-[12.5px] text-foreground mt-2 mb-1',
  item: 'text-xs leading-[1.6] text-text-secondary',
  p: 'text-xs leading-[1.6] text-text-secondary my-0.5',
  pre: 'bg-term-bg border border-border px-2.5 py-2 my-2 overflow-x-auto font-mono text-[11px] text-foreground',
};

export function SimpleMarkdown({ content, links }: { content: string; links?: ReportLinks }) {
  const style = links ? REPORT_STYLE : DOCUMENT_STYLE;
  const bullet = links
    ? <span className="w-1 h-1 mt-[7px] bg-muted-foreground shrink-0" />
    : <span className="text-muted-foreground mt-1.5 shrink-0">&#8226;</span>;
  const lines = content.split('\n');
  const elements: React.ReactElement[] = [];
  let inCodeBlock = false;
  let codeBlockContent: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Code blocks
    if (line.startsWith('```')) {
      if (inCodeBlock) {
        elements.push(
          <pre key={i} className={style.pre}>
            <code>{codeBlockContent.join('\n')}</code>
          </pre>
        );
        codeBlockContent = [];
        inCodeBlock = false;
      } else {
        inCodeBlock = true;
      }
      continue;
    }

    if (inCodeBlock) {
      codeBlockContent.push(line);
      continue;
    }

    // Empty lines
    if (line.trim() === '') {
      elements.push(<div key={i} className={links ? 'h-2' : 'h-3'} />);
      continue;
    }

    // Headers
    if (line.startsWith('# ')) {
      elements.push(<h1 key={i} className={style.h1}>{renderInline(line.slice(2), links)}</h1>);
      continue;
    }
    if (line.startsWith('## ')) {
      elements.push(<h2 key={i} className={style.h2}>{renderInline(line.slice(3), links)}</h2>);
      continue;
    }
    if (line.startsWith('### ')) {
      elements.push(<h3 key={i} className={style.h3}>{renderInline(line.slice(4), links)}</h3>);
      continue;
    }

    // Horizontal rule
    if (line.match(/^-{3,}$/) || line.match(/^\*{3,}$/)) {
      elements.push(<hr key={i} className="border-border my-4" />);
      continue;
    }

    // Bullet list
    if (line.match(/^\s*[-*]\s/)) {
      const indent = line.match(/^(\s*)/)?.[1].length || 0;
      const text = line.replace(/^\s*[-*]\s/, '');
      elements.push(
        <div key={i} className="flex gap-2 my-0.5" style={{ paddingLeft: `${indent * 8 + 8}px` }}>
          {bullet}
          <span className={style.item}>{renderInline(text, links)}</span>
        </div>
      );
      continue;
    }

    // Numbered list
    if (line.match(/^\s*\d+\.\s/)) {
      const match = line.match(/^(\s*)(\d+)\.\s(.*)$/);
      if (match) {
        const indent = match[1].length;
        elements.push(
          <div key={i} className="flex gap-2 my-0.5" style={{ paddingLeft: `${indent * 8 + 8}px` }}>
            <span className="text-muted-foreground shrink-0">{match[2]}.</span>
            <span className={style.item}>{renderInline(match[3], links)}</span>
          </div>
        );
        continue;
      }
    }

    // Image on its own line (use trim to handle trailing whitespace/\r)
    const trimmed = line.trim();
    if (trimmed.startsWith('![')) {
      const closeBracket = trimmed.indexOf(']', 2);
      if (closeBracket !== -1 && trimmed[closeBracket + 1] === '(') {
        const closeParen = trimmed.indexOf(')', closeBracket + 2);
        if (closeParen !== -1 && closeParen === trimmed.length - 1) {
          const alt = trimmed.slice(2, closeBracket);
          const raw = trimmed.slice(closeBracket + 2, closeParen);
          elements.push(
            <div key={i} className="my-2">
              {links ? reportPicture(alt, raw, links, 0) : <img src={resolveLocalSrc(raw)} alt={alt} className="max-w-full rounded" />}
            </div>
          );
          continue;
        }
      }
    }

    // Blockquote
    if (line.startsWith('> ')) {
      elements.push(
        <blockquote key={i} className="border-l border-primary/60/50 pl-3 my-1 text-sm text-muted-foreground italic">
          {renderInline(line.slice(2), links)}
        </blockquote>
      );
      continue;
    }

    // Regular paragraph
    elements.push(<p key={i} className={style.p}>{renderInline(line, links)}</p>);
  }

  // Close any open code block
  if (inCodeBlock && codeBlockContent.length > 0) {
    elements.push(
      <pre key="final-code" className={style.pre}>
        <code>{codeBlockContent.join('\n')}</code>
      </pre>
    );
  }

  return <div>{elements}</div>;
}
