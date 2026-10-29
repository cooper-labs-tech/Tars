'use client';

import { Link2 } from 'lucide-react';
import type { PlaceEntry } from './useProjectFolders';

/**
 * A link chosen in the list: where it points, as written, and nothing opened (the Vault's rule R1.2; frame `Vault
 * (2.0.5) · project folder tree · states`, a link). A hard link, a file with a second name elsewhere, is not read either.
 */
export function ProjectLinkNote({ entry }: { entry: PlaceEntry }) {
  const hard = entry.type === 'file';
  const target = entry.type === 'link' ? entry.target : null;
  return (
    <section aria-label="File" className="flex flex-col gap-2 p-3.5">
      <div className="flex items-center gap-2">
        <Link2 className="w-3 h-3 shrink-0 text-muted-foreground" />
        <span className="font-mono text-[12px] text-foreground truncate">{entry.name}</span>
      </div>
      <p className="text-[11.5px] leading-[1.5] text-text-secondary">
        {hard
          ? `${entry.name} has another name elsewhere: a hard link. The Vault does not read it.`
          : `${entry.name} is a link${target ? ` to ${target}` : ''}. The Vault does not follow links.`}
      </p>
    </section>
  );
}
