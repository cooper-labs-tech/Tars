import * as os from 'node:os';
import { assertThrowaway } from './throwaway-dirs';

/**
 * The home's guard, imported first by a test file that writes or removes anything under the data or private folder.
 * Loading electron/constants settles ~/.dorothy and ~/.tars in os.homedir() at once (core/data-dir-move.ts), and
 * both folders are made from it, so a guard called after that import comes too late: run without the repo's
 * setupFiles, the owner's ~/.dorothy link would be made before the guard threw (QA's proof of its own home guard,
 * 25/11). This throws at load instead, before the next import, unless the home is inside the throwaway temporary
 * folder that the setupFiles make.
 */
assertThrowaway({ HOME: os.homedir() });
