/**
 * A table taken out of a TOML file (codex's and grok's config.toml, written by their providers and the MCP page),
 * line by line: its header and every line up to the next table header or the file's end, and nothing of the line
 * before it.
 *
 * The remover it replaces was one regex, copied in three files, that began with `\n?`: a table no blank line
 * separated from the line before it took that line's newline with it, so the line ran into whatever followed. On
 * 25/10, 2.0.4's first start removed and registered again each of Tars's servers in the owner's
 * ~/.codex/config.toml, and `args = [".../mcp-world/dist/bundle.js"]` became `...bundle.js"][tui]`: codex then
 * refused its whole config.
 *
 * `key` is the header as the file writes it, without its brackets (`mcp_servers.claude-mgr-vault`,
 * `mcp_servers."tasmania.local"`). A header line is a table's or an array of tables' header, a comment after it
 * aside: its key is bare (`a-z0-9_-`), a basic string or a literal string, dotted, so a quoted key may hold `[`, `]`,
 * `=` or `#` (a trust table `[projects."/Users/me/Work [old]/app"]`, the Audit's M1 on #531). A line of a value
 * (`  [1, 2],`, `["a", "b"]`) is not one. What is left ends with a newline.
 */
const KEY = String.raw`(?:[A-Za-z0-9_-]+|"(?:[^"\\]|\\.)*"|'[^']*')`;
const HEADER = new RegExp(String.raw`^\s*(\[\[?\s*${KEY}(?:\s*\.\s*${KEY})*\s*\]\]?)\s*(?:#.*)?\r?$`);

export function removeTomlTable(content: string, key: string): string {
  const lines = content.split('\n');
  const isTable = (line: string) => HEADER.exec(line)?.[1] === `[${key}]`;
  const out: string[] = [];
  let removing = false;
  let removedAtEnd = false;
  for (const line of lines) {
    if (removing && HEADER.test(line)) removing = false;
    if (!removing && isTable(line)) removing = true;
    if (removing) removedAtEnd = true;
    else { out.push(line); removedAtEnd = false; }
  }
  if (out.length === lines.length) return content;
  // A table removed from the end leaves no blank lines behind it.
  if (removedAtEnd) while (out.length && out[out.length - 1].trim() === '') out.pop();
  const text = out.join('\n');
  return text === '' || text.endsWith('\n') ? text : `${text}\n`;
}
