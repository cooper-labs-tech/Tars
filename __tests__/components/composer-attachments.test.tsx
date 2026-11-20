import '../setup/home-guard';
import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { Composer } from '../../src/components/Overseer/Composer';
import type { OverseerAttachment } from '../../src/types/electron';

/**
 * The composer's attachment row.
 *
 * This is asserted here rather than left to the screenshot suite because the
 * attach control is about 1300 pixels on a 1.6M pixel page, which is under the
 * 0.002 diff ratio the visual baselines run at. A whole control can therefore
 * appear or vanish without a single surface failing, so the thing that proves
 * it renders has to be a test that looks at the markup.
 */

const files: OverseerAttachment[] = [
  { name: 'brief.pdf', path: '/root/.hermes/uploads/brief.pdf', isImage: false },
  { name: 'shot.png', path: '/root/.hermes/images/x_shot.png', isImage: true },
];

function render(props: Partial<Parameters<typeof Composer>[0]> = {}): string {
  return renderToStaticMarkup(
    <Composer
      value=""
      onChange={() => {}}
      onSend={() => {}}
      disabled={false}
      placeholder="Ask about any project."
      {...props}
    />,
  );
}

/** The + button's opening tag, named by its aria-label since #124. */
const attach = (html: string) => html.match(/<button[^>]*aria-label="(?:Attach files|Uploading)"[^>]*>/)?.[0];

describe('Composer attachments', () => {
  it('offers the attach control when the page can handle it', () => {
    const button = attach(render({ onAttach: () => {} }));
    expect(button).toContain('aria-label="Attach files"');
    expect(button).not.toMatch(/\sdisabled=""/);
  });

  it('draws the control disabled when the page cannot take a file', () => {
    // Since #124 the card always draws +, and disables it where nothing can take
    // a file, instead of leaving it out.
    const button = attach(render());
    expect(button).toContain('aria-label="Attach files"');
    expect(button).toMatch(/\sdisabled=""/);
  });

  it('says what it is doing while a file is going up', () => {
    const button = attach(render({ onAttach: () => {}, attaching: true }));
    expect(button).toContain('aria-label="Uploading"');
    expect(button).toMatch(/\sdisabled=""/);
  });

  it('says why + and send are off while Hermes cannot be reached', () => {
    // The gate of #124: faded under their usual names they read as broken, and
    // only the placeholder explained.
    const html = render({ disabled: true, onAttach: () => {}, value: 'hello' });
    const plus = 'Files cannot reach Hermes until its connection works';
    const send = 'Nothing reaches Hermes until its connection works';
    for (const label of [plus, send]) {
      expect(html).toContain(`aria-label="${label}"`);
      const button = html.match(new RegExp(`<button[^>]*aria-label="${label}"[^>]*>`))![0];
      expect(button).toContain(`title="${label}"`);
      expect(button).toMatch(/\sdisabled=""/);
    }
  });

  it('shows a chip per staged file, naming it', () => {
    const html = render({ onAttach: () => {}, attachments: files });
    expect(html).toContain('brief.pdf');
    expect(html).toContain('shot.png');
  });

  it('keeps the gateway path reachable without putting it in the chip', () => {
    const html = render({ onAttach: () => {}, attachments: files });
    // The path is what Hermes is actually given, so it has to be readable
    // somewhere; the chip itself stays the short name.
    expect(html).toContain('title="/root/.hermes/uploads/brief.pdf"');
    expect(html).toContain('>brief.pdf<');
  });

  it('offers to remove a staged file but only in the composer', () => {
    const staged = render({ onAttach: () => {}, attachments: files, onRemoveAttachment: () => {} });
    expect(staged).toContain('Remove brief.pdf');
    // Without the callback there is no remove button: a sent file cannot be
    // unsent, and the same component renders both cases.
    expect(render({ onAttach: () => {}, attachments: files })).not.toContain('Remove brief.pdf');
  });

  it('renders nothing extra when nothing is staged', () => {
    const html = render({ onAttach: () => {} });
    expect(html).not.toContain('Remove');
  });
});
