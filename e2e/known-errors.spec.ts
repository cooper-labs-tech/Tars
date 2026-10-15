import { test, expect } from '@playwright/test';
import { KNOWN_PAGE_ERRORS, RECORDING_SUITES, VOLATILE, maskApplies, readPageErrorRecords } from './surfaces.mjs';

/**
 * The surfaces of this run that recorded nothing, which is what stops either
 * check below from calling anything stale: an entry cannot be judged on a page
 * that never opened, and a filtered run opens almost none of them.
 */
function surfacesThatDidNotRecord(records: Array<{ suite: string; surface: string }>): string[] {
  const recorded = new Set(records.map(r => `${r.suite}: ${r.surface}`));
  return Object.entries(RECORDING_SUITES)
    .flatMap(([suite, surfaces]: [string, Array<{ name: string }>]) => surfaces.map(s => `${suite}: ${s.name}`))
    .filter(key => !recorded.has(key));
}

/**
 * The allowance list, held to its own defects.
 *
 * A known-issue entry that nothing trips any more describes a defect somebody
 * fixed, and leaving it in place is how the next real error of that shape gets
 * waved through. Failing here is the reminder to delete the entry, and deleting
 * it is what makes the suite green again.
 *
 * This used to be the last test of surfaces.spec.ts, reading a Set that file
 * filled in module state, and it could not see the whole run. Measured on
 * 2026-09-16:
 *
 * - When a test fails, Playwright stops that worker and runs the rest of the
 *   file in a new one, whose module state starts empty. `whats-new` failed on a
 *   changelog line, the Set forgot what every page before it had seen, and this
 *   reported `hydration` and `overseer-model-options` as gone, with the
 *   instruction to delete them, while both were still happening.
 * - chat-rooms.spec.ts is another file, so another module. What it saw was an
 *   annotation and nothing more: an error only the Chat rooms trip never counted.
 *
 * So each surface now writes what it saw into a directory made for the run
 * (e2e/global-setup.mjs), and this runs in a project of its own, the teardown of
 * the one that drives the app: Playwright starts it once every spec there has
 * finished, whatever failed and in whatever order the files ran.
 */
test('every tolerated page error still happens, or its entry is stale', () => {
  const records = readPageErrorRecords();
  const seen = new Set(records.flatMap(r => r.seen));
  const gone = KNOWN_PAGE_ERRORS.filter(k => !seen.has(k.key));

  // Seen once is still happening, whatever else went wrong. Not seen is only
  // stale if every surface that could have tripped it was opened. Filters do not
  // reach a teardown project, so this also runs after `-g "surface: whats-new"`,
  // and a surface that fails before it records leaves the same hole: such a run
  // cannot say that anything stopped. A surface that fails afterwards, on its
  // screenshot, has recorded.
  if (gone.length > 0) {
    const missing = surfacesThatDidNotRecord(records);
    if (missing.length > 0) {
      test.skip(true, `not judged: ${gone.map(k => k.key).join(', ')} not seen, but ${missing.length} surfaces recorded nothing in this run, the first being ${missing[0]}`);
    }
  }

  expect(
    gone.map(k => `${k.key}: ${k.why}`),
    'these are tolerated and no longer occur: remove them from KNOWN_PAGE_ERRORS',
  ).toEqual([]);
});

/**
 * The masks, held to the same rule as the allowances.
 *
 * A mask is a locator, and a locator stops matching the day a class or a
 * sentence changes. Nothing then covers the clock or the version number it was
 * written for, which is the good case: the surface reddens and somebody looks.
 * The bad case is a mask that covered a defect rather than a clock, or one
 * whose content has gone: it hides nothing, it says nothing, and it stays in
 * the list forever. So a full run in which a declared mask matched nothing on
 * any of its surfaces fails here, and deleting the entry is what makes it green.
 *
 * An entry marked `sometimes` is for content only some runs show, and is not
 * judged: it says so where it is declared, and why.
 */
test('every volatile mask still matches something, or its entry is dead', () => {
  const records = readPageErrorRecords();
  const used = new Set(records.flatMap(r => r.masks ?? []));
  // A mask declared for other platforms is not judged on this one: it never ran here.
  const dead = Object.entries(VOLATILE).filter(([key, entry]) => maskApplies(entry) && !used.has(key) && !entry.sometimes);

  if (dead.length > 0) {
    const missing = surfacesThatDidNotRecord(records);
    if (missing.length > 0) {
      test.skip(true, `not judged: ${dead.map(([key]) => key).join(', ')} matched nothing, but ${missing.length} surfaces recorded nothing in this run, the first being ${missing[0]}`);
    }
  }

  expect(
    dead.map(([key, entry]) => `${key}: ${entry.why} (surfaces: ${entry.surfaces === 'all' ? 'all' : entry.surfaces.join(', ')})`),
    'these masks matched nothing anywhere in this run: remove them from VOLATILE, or fix the locator',
  ).toEqual([]);
});
