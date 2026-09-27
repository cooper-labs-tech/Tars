import { quoted } from './reveal';

/**
 * What a skill is called: a folder name, `copywriting` or `vercel:nextjs`,
 * never a sentence (the same rule as the template import review,
 * src/lib/template-review.ts).
 *
 * An agent's skills are written into the start of every task's prompt, so a
 * "skill" that is a sentence, or holds a newline, is an instruction slipped
 * into each task the agent is given (the Audit's gate of #204). Every way an
 * agent or a template gets skills goes through here: the window, the API, a
 * template, and agents.json as it is read.
 */
export const SKILL_NAME = /^[A-Za-z0-9@][A-Za-z0-9._:@/-]{0,99}$/;

export function isSkillName(value: unknown): value is string {
  return typeof value === 'string' && SKILL_NAME.test(value);
}

/** Why these are not skills, in a sentence, or undefined when they are. */
export function skillsProblem(skills: unknown): string | undefined {
  if (!Array.isArray(skills)) return 'skills must be a list of skill names';
  const at = skills.findIndex(skill => !isSkillName(skill));
  if (at === -1) return undefined;
  return `${quoted(skills[at])} is not a skill name`;
}
