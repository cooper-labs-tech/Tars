/**
 * The app's pages, as pageOf (monitor.ts) names them: what a sample may name
 * when it leaves (samples.ts, Vocabulary). One per route of src/app with a
 * page.tsx, and the home; __tests__/electron/services/health-samples.test.ts
 * checks this list against src/app on disk.
 */
export const APP_PAGES: ReadonlySet<string> = new Set([
  '/', '/agents', '/chat', '/chats', '/crons', '/kanban', '/logs', '/memory', '/project', '/projects',
  '/resources', '/review', '/settings', '/skills', '/tray-panel', '/usage', '/vault', '/whats-new',
]);
