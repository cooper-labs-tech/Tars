import { ipcMain } from 'electron';
import { parseCap } from '../core/project-cap';
import { fleetOperations, type FleetProjectView } from '../services/fleet-operations';
import { parseSchedule } from '../services/fleet-schedule';

/**
 * The window's hold on each project's hours and cap (services/fleet-operations.ts, 2.0.7): it reads them with what the
 * last window did, and sets them for any project, filed under "you". The window is the owner's: no right to check.
 * Every change is pushed as `fleet:changed`, { projects }, by services/fleet-runtime.ts.
 *
 * fleet:state                                    -> { projects: FleetProjectView[] }
 * fleet:setSchedule(projectPath, { start, stop, timeZone, onStart? }) -> { success: true, project } | { success: false, error, code }
 * fleet:clearSchedule(projectPath)               -> { success: true, project } | { success: false, error }
 * fleet:setCap(projectPath, cap | null)          -> { success: true, project } | { success: false, error, code }
 */

type Answer = { success: true; project: FleetProjectView } | { success: false; error: string; code?: string };

function project(raw: unknown): string | undefined {
  return typeof raw === 'string' && raw.trim() ? raw : undefined;
}

export function registerFleetHandlers(): void {
  ipcMain.handle('fleet:state', () => ({ projects: fleetOperations()?.views() ?? [] }));

  ipcMain.handle('fleet:setSchedule', async (_e, projectPath: unknown, schedule: unknown): Promise<Answer> => {
    const ops = fleetOperations();
    const where = project(projectPath);
    if (!ops || !where) return { success: false, error: 'projectPath is the folder of a project.', code: 'invalid_project' };
    const parsed = parseSchedule(schedule);
    if (!parsed.ok) return { success: false, error: parsed.error, code: parsed.code };
    ops.setSchedule(where, parsed.schedule, 'you');
    await ops.tick();
    return { success: true, project: ops.view(where) };
  });

  ipcMain.handle('fleet:clearSchedule', async (_e, projectPath: unknown): Promise<Answer> => {
    const ops = fleetOperations();
    const where = project(projectPath);
    if (!ops || !where) return { success: false, error: 'projectPath is the folder of a project.', code: 'invalid_project' };
    ops.clearSchedule(where, 'you');
    return { success: true, project: ops.view(where) };
  });

  ipcMain.handle('fleet:setCap', (_e, projectPath: unknown, cap: unknown): Answer => {
    const ops = fleetOperations();
    const where = project(projectPath);
    if (!ops || !where) return { success: false, error: 'projectPath is the folder of a project.', code: 'invalid_project' };
    const parsed = parseCap(cap);
    if (!parsed.ok) return { success: false, error: parsed.error, code: parsed.code };
    return { success: true, project: ops.setCap(where, parsed.cap, 'you') };
  });
}
