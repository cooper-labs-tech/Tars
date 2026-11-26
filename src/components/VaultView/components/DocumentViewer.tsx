'use client';

import React, { useState } from 'react';
import type { VaultDocumentElectron, VaultAttachmentElectron } from '@/types/electron';
import { Button, MetaChip, PanelCaption } from '@/components/ui';
import { SimpleMarkdown } from './MarkdownRenderer';
import { localFileUrl } from '@/lib/local-file-url';

interface DocumentViewerProps {
  document: VaultDocumentElectron;
  attachments: VaultAttachmentElectron[];
  /** Kept for the caller; the list never leaves the screen, so nothing here goes back. */
  onBack: () => void;
  onEdit: () => void;
  onDelete: (id: string) => void;
}

function parseTags(tagsStr: string): string[] {
  try {
    return JSON.parse(tagsStr || '[]');
  } catch {
    return [];
  }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// Row actions are words, not glyphs: 26px bordered boxes holding lowercase mono
// text. `font-normal` undoes the button's medium weight so they read as labels.
const ACTION = 'font-mono font-normal lowercase';

export default function DocumentViewer({ document, attachments, onEdit, onDelete }: DocumentViewerProps) {
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const tags = parseTags(document.tags);

  return (
    <div className="flex flex-col h-full">
      {/* No header band. The document list sits beside this panel and stays
          there, so there is no back arrow, and the author/date meta the old bar
          carried is not on the frame - the title is the first thing in the body. */}
      <div className="flex-1 overflow-y-auto px-6 py-4">
        <h2 className="font-serif text-xl text-foreground">{document.title}</h2>

        {tags.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5 mt-2">
            {tags.map(tag => (
              <MetaChip key={tag}>{tag}</MetaChip>
            ))}
          </div>
        )}

        <div className="mt-4">
          <SimpleMarkdown content={document.content} />
        </div>

        {/* The actions live under the text, in the flow - not pinned to an edge. */}
        <div className="flex flex-wrap items-center gap-2 mt-6">
          <Button size="sm" className={ACTION} onClick={onEdit}>
            edit
          </Button>
          <Button
            size="sm"
            className={ACTION}
            disabled
            title="Not wired up yet - handing a document to an agent has no backend behind it."
          >
            share with agent
          </Button>
          {showDeleteConfirm ? (
            <>
              <Button size="sm" variant="danger" className={ACTION} onClick={() => onDelete(document.id)}>
                confirm delete
              </Button>
              <Button size="sm" variant="ghost" className={ACTION} onClick={() => setShowDeleteConfirm(false)}>
                cancel
              </Button>
            </>
          ) : (
            <Button size="sm" className={ACTION} onClick={() => setShowDeleteConfirm(true)}>
              delete
            </Button>
          )}
        </div>
      </div>

      {/* Attachments */}
      {attachments.length > 0 && (
        <div className="border-t border-border px-4 py-3 bg-card">
          <PanelCaption>Attachments ({attachments.length})</PanelCaption>
          <div className="mt-2 space-y-px">
            {attachments.map(att => (
              // Copied into ~/.tars/vault/attachments on attach, so this is
              // the only route allowed to serve it back out: see the allowedDir
              // check on /api/local-file. Without this link the file was listed
              // but nothing let you ever open it again. Through this Tars's own
              // API port (localFileUrl); with none known, the row is no link.
              <a
                key={att.id}
                href={localFileUrl(att.filepath) ?? undefined}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-2 h-8 px-2 bg-secondary/50 text-xs hover:bg-secondary transition-colors"
                title={`Open ${att.filename}`}
              >
                <span className="truncate flex-1 text-foreground underline decoration-transparent hover:decoration-current">{att.filename}</span>
                <span className="shrink-0 font-mono text-[10.5px] text-muted-foreground">
                  {formatSize(att.size)}
                </span>
              </a>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
