import './setup/home-guard';
import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { RichText } from '../src/components/Overseer/RichText';

/**
 * Formatting an overseer reply.
 *
 * The text is written by a language model that is reading agent output, so the
 * property that matters most is not which markers render: it is that nothing in
 * the message can ever become markup. These render to static HTML and assert on
 * the result, so an escaping mistake shows up as a real tag rather than as a
 * passing unit test on an internal shape.
 */

const html = (text: string) => renderToStaticMarkup(<RichText text={text} />);

describe('emphasis', () => {
  it('renders bold instead of showing the asterisks', () => {
    const out = html('the migration is **stuck on you**');
    expect(out).toContain('<strong');
    expect(out).toContain('stuck on you');
    expect(out).not.toContain('**');
  });

  it('renders inline code instead of showing the backticks', () => {
    const out = html('agent `frontend-3` is waiting');
    expect(out).toContain('<code');
    expect(out).toContain('frontend-3');
    expect(out).not.toContain('`');
  });

  it('renders italics', () => {
    expect(html('this is *probably* fine')).toContain('<em>probably</em>');
  });

  it('leaves an underscore inside a word alone', () => {
    // `agent_routes.ts` is a filename, not emphasis.
    const out = html('see agent_routes.ts for the guard');
    expect(out).not.toContain('<em>');
    expect(out).toContain('agent_routes.ts');
  });

  it('does not let a bold run swallow a code span', () => {
    const out = html('**check `agent-3` now**');
    expect(out).toContain('<strong');
    expect(out).toContain('agent-3');
  });
});

describe('blocks', () => {
  it('renders a bullet list', () => {
    const out = html('doing:\n- one thing\n- another thing');
    expect(out).toContain('<ul');
    expect((out.match(/<li>/g) || []).length).toBe(2);
  });

  it('renders a fenced block verbatim', () => {
    const out = html('run this:\n```\nnpm run build\n```');
    expect(out).toContain('<pre');
    expect(out).toContain('npm run build');
  });

  it('treats markers inside a fence as text', () => {
    const out = html('```\nconst x = **not bold**;\n```');
    expect(out).not.toContain('<strong');
    expect(out).toContain('**not bold**');
  });

  it('still shows a block the reply was cut off inside', () => {
    const out = html('here:\n```\nhalf a command');
    expect(out).toContain('<pre');
    expect(out).toContain('half a command');
  });

  it('renders a heading line without its hashes', () => {
    const out = html('## What is stuck');
    expect(out).toContain('What is stuck');
    expect(out).not.toContain('##');
  });
});

describe('it can never emit markup', () => {
  it('escapes a script tag quoted from agent output', () => {
    const out = html('the log said <script>alert(1)</script>');
    expect(out).not.toContain('<script>');
    expect(out).toContain('&lt;script&gt;');
  });

  it('escapes markup inside bold', () => {
    const out = html('**<img src=x onerror=alert(1)>**');
    expect(out).not.toContain('<img');
    expect(out).toContain('&lt;img');
  });

  it('escapes markup inside a fenced block', () => {
    const out = html('```\n<iframe src="evil"></iframe>\n```');
    expect(out).not.toContain('<iframe');
    expect(out).toContain('&lt;iframe');
  });

  it('escapes markup inside a bullet', () => {
    const out = html('- <b>not bold</b>');
    expect(out).not.toContain('<b>');
    expect(out).toContain('&lt;b&gt;');
  });
});

describe('plain text', () => {
  it('keeps a message with no markers intact', () => {
    expect(html('nothing is happening right now')).toContain('nothing is happening right now');
  });

  it('renders an empty message without throwing', () => {
    expect(() => html('')).not.toThrow();
  });
});
