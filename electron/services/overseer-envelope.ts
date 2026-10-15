// ── Reading a reply ──────────────────────────────────────────────────────
// The envelope the header of overseer.ts describes, what a reply that is only
// its template looks like, and when two replies say the same thing.

/**
 * The same observation, told again.
 *
 * The guard before this one tested a shape of text, and shapes are what a
 * model varies. What went wrong twice is a behaviour: the overseer saying what
 * it just said, being shown that it said it, and saying it again. So the test
 * is about sameness.
 *
 * It used to allow a small edit budget on top, which sounds harmless and was
 * not. Five percent of a sentence only exceeds three characters past sixty
 * normalised characters, so in practice the rule was "identical give or take
 * three", and three characters is the whole difference between "Agent a1
 * errored" and "Agent a2 errored". Two agents failing one after the other, and
 * the second one silently dropped. That is the same class of harm as the loop
 * itself: something true, gone, with nobody told.
 *
 * There is no budget any more. Two tellings are the same telling when they are
 * the same words, and the only thing normalised away is an elapsed duration,
 * because "waiting for eleven minutes" and "waiting for 12 minutes" are one
 * observation getting older. A number that is not counting a duration is left
 * exactly as written: it is naming something. "Two agents" and "Nine agents"
 * are different facts, and so are a1 and a2.
 *
 * A repeat that has been reworded gets through, and that is the right way to
 * be wrong. A duplicate that slips past costs one line; a real observation
 * merged into a previous one costs the observation. The fold in
 * serializeHistory and the instruction in composeTurn carry that half.
 */
const NUMBER_WORD = '(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|'
  + 'eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|'
  + 'twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand)';
const DURATION_UNIT = '(?:seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|weeks?|months?)';
/** A number that measures how long, and only that. */
const ELAPSED = new RegExp(`\\b(?:\\d+|${NUMBER_WORD})\\s+(${DURATION_UNIT})\\b`, 'g');

function normaliseSaid(text: string): string {
  return text
    .toLowerCase()
    .replace(ELAPSED, '# $1')
    .replace(/[^\p{L}\p{N}#]+/gu, ' ')
    .trim();
}

export function isSameThingSaidAgain(a: string, b: string): boolean {
  const x = normaliseSaid(a);
  const y = normaliseSaid(b);
  return x.length > 0 && x === y;
}

export interface ParsedEnvelope {
  say: string;
  action: { agentId: string; text: string } | null;
}

/** The first balanced {...} in a string, ignoring braces inside JSON strings.
 *  Lets a reply that wraps its envelope in prose still be read. */
function firstJsonObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return text.slice(start, i + 1);
  }
  return null;
}

/**
 * Read the `say` string out of an envelope that will not parse.
 *
 * A reply cut off mid-object still has everything the reader wants at the
 * front of it. Without this, a truncated envelope fell through whole and the
 * chat showed `"action": {"kind": "message_agent", "agent_id": "57f0..."` as
 * if it were the message.
 */
function salvageSay(text: string): string | null {
  const key = text.search(/"say"\s*:\s*"/);
  if (key === -1) return null;
  let i = text.indexOf('"', text.indexOf(':', key) + 1) + 1;
  let out = '';
  let escaped = false;
  for (; i < text.length; i++) {
    const ch = text[i];
    if (escaped) {
      out += ch === 'n' ? '\n' : ch === 't' ? '\t' : ch;
      escaped = false;
      continue;
    }
    if (ch === '\\') { escaped = true; continue; }
    if (ch === '"') break;
    out += ch;
  }
  return out.trim() || null;
}

function readEnvelope(candidate: string): ParsedEnvelope | null {
  try {
    const parsed = JSON.parse(candidate) as { say?: unknown; action?: unknown };
    if (!parsed || typeof parsed.say !== 'string') return null;
    const a = parsed.action as { kind?: unknown; agent_id?: unknown; text?: unknown } | null | undefined;
    if (a && a.kind === 'message_agent' && typeof a.agent_id === 'string' && typeof a.text === 'string') {
      return { say: parsed.say, action: { agentId: a.agent_id, text: a.text } };
    }
    return { say: parsed.say, action: null };
  } catch {
    return null;
  }
}

/**
 * A reply that is the format example rather than an answer.
 *
 * The prompt shows Hermes the envelope to fill in. When it copies the example
 * instead of filling it, the result is still valid JSON, so parseEnvelope
 * accepts it and `say` becomes the placeholder itself. That happened once on
 * JeanBrasse's install and then never stopped: every following turn was shown the
 * placeholder as something the overseer had already said, and copied it in
 * turn. Nineteen consecutive turns, none of which could recover on its own.
 *
 * Two tests, both exact, neither with a number in it to get wrong.
 *
 * The first is the tokens this app has itself put in front of the model. We
 * know them exactly, so a reply carrying one verbatim is an echo and there is
 * nothing to estimate. This is what catches a reply that wraps the template in
 * a word or two, which the second test alone lets through: harmless as a
 * displayed message, but serializeHistory asks the same question, so letting
 * one back into the prompt is the loop starting again.
 *
 * The second is structural, for shapes we have never emitted, such as the
 * gateway's own `[SILENT]`. Take out the placeholder spans and bare sentinel
 * tokens, and see whether any message is left. Prose that merely happens to
 * contain angle brackets keeps its words; a reply built only of placeholders
 * has nothing left.
 */
const PLACEHOLDER_SPAN = /<[^<>]{0,120}>/g;
/** `[SILENT]`, which the gateway emits for "produce no output" and which is
 *  not a message either. Uppercase only, so a markdown link survives. */
const BARE_SENTINEL = /\[[A-Z][A-Z_ ]{2,30}\]/g;
/**
 * Every placeholder token composeTurn has ever shown the model. The prompt no
 * longer offers any of them (the examples it shows are filled in), but they
 * are what is sitting in conversations written before that, and a model given
 * one as context reproduces it verbatim. Kept with their angle brackets, so
 * a reply that discusses the bug in prose is not mistaken for one.
 */
const EMITTED_PLACEHOLDERS: Array<string | RegExp> = [
  // The first one named the user, with one name on every install: any name
  // in its place is that same token.
  /<what you tell [^<>,]{1,40}, plain text or light markdown>/,
  '<id from the snapshot>',
  '<the exact message to send>',
  '<...>',
  // The two sentences a previous version of composeTurn used as filled in
  // examples. Replacing the brackets with plausible prose was meant to make
  // copying less tempting; what it did was make copying invisible. One of
  // them was then repeated a hundred and seventy eight times over a day,
  // reading as a real observation the whole way. They are named here because
  // a conversation already conditioned on them will keep producing them.
  'Frontend has been waiting on your answer about the sidebar width for eleven minutes',
  'Backend has retried the same failing test three times without changing anything',
];
export function isTemplateEcho(say: string): boolean {
  const text = say.trim();
  if (!text) return true;

  if (EMITTED_PLACEHOLDERS.some(token => typeof token === 'string' ? text.includes(token) : token.test(text))) return true;

  const stripped = text.replace(PLACEHOLDER_SPAN, ' ').replace(BARE_SENTINEL, ' ');
  // Nothing was a placeholder, so there is nothing to accuse it of.
  if (stripped === text) return false;

  // Nothing at all, rather than "not much". This started as a threshold of a
  // dozen surviving characters, which is the kind of number that has to be
  // guessed and was guessed wrong: it swallowed "[URGENT] Build KO." and
  // "Voir <https://example.com/docs>.", which are messages, not templates.
  // The real distinction needs no tuning. A reply that is the template has
  // nothing left once the template is taken out of it; a reply that merely
  // uses brackets is still a sentence without them. An emoji counts as
  // something left: "[DONE] \u{1F44D}" is a person's answer, where "[DONE] !!!"
  // is punctuation and stays folded.
  return !/[\p{L}\p{N}\p{Extended_Pictographic}]/u.test(stripped);
}

/**
 * What the model actually said, whatever shape it sent it in.
 *
 * The reply is asked for as one JSON object. When it is one, this reads it.
 * When it is not, the old behaviour was to hand the whole raw string through
 * as the message, so a reply with prose around its envelope, or one the model
 * cut off, arrived in the chat as visible JSON. Every path below now ends in
 * something a person can read.
 */
export function parseEnvelope(raw: string): ParsedEnvelope {
  const text = raw.trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);

  for (const candidate of [fenced?.[1], text, firstJsonObject(text)]) {
    if (!candidate) continue;
    const read = readEnvelope(candidate.trim());
    if (read) return read;
  }

  // Nothing parsed. If there is a `say` in there, it is the message.
  const salvaged = salvageSay(text);
  if (salvaged) return { say: salvaged, action: null };

  // Still nothing, and it looks like a machine wrote it: say that, rather
  // than showing the reader an object.
  if (/"(say|action|kind|agent_id)"\s*:/.test(text)) {
    return {
      say: 'Hermes replied in a shape Tars could not read, so there is nothing to show. Ask again.',
      action: null,
    };
  }

  // Ordinary prose, which is a perfectly good answer.
  return { say: text, action: null };
}
