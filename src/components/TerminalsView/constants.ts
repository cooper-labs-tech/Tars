import type { GridDefinition, LayoutPreset, KeyboardShortcut } from './types';

// Re-export terminal theme/config from AgentWorld for consistency
export { TERMINAL_THEME, TERMINAL_CONFIG } from '@/components/AgentWorld/constants';

// Layout preset definitions
export const LAYOUT_PRESETS: Record<LayoutPreset, GridDefinition> = {
  'single': { cols: 1, rows: 1, label: 'Single', icon: '[ ]', maxPanels: 1 },
  '2-col': { cols: 2, rows: 1, label: '2 Column', icon: '[ | ]', maxPanels: 2 },
  '2-row': { cols: 1, rows: 2, label: '2 Row', icon: '[-]', maxPanels: 2 },
  '2x2': { cols: 2, rows: 2, label: '2x2 Grid', icon: '[+]', maxPanels: 4 },
  '3x2': { cols: 3, rows: 2, label: '3x2 Grid', icon: '[|||]', maxPanels: 6 },
  '3x3': { cols: 3, rows: 3, label: '3x3 Grid', icon: '[###]', maxPanels: 9 },
  'focus': { cols: 2, rows: 1, label: 'Focus', icon: '[> |]', maxPanels: 2 },
};

/** The largest preset. Past its nine panels a board keeps its three columns and its cells' size, grows by rows,
 *  and scrolls (JeanBrasse, 22/10): no board caps its agents. Frame: `Dashboard (2.0.5) · twelve agents, three
 *  columns, scrolled`. */
export const SCROLLING_PRESET: LayoutPreset = '3x3';

/** The rows a board's grid needs: its preset's, or more on the scrolling preset when it holds more panels. */
export function boardRows(preset: LayoutPreset, panels: number): number {
  const { cols, rows } = LAYOUT_PRESETS[preset];
  return preset === SCROLLING_PRESET ? Math.max(rows, Math.ceil(panels / cols)) : rows;
}

// Auto-calculate best layout based on agent count
export function getAutoLayout(agentCount: number): LayoutPreset {
  if (agentCount <= 1) return 'single';
  if (agentCount === 2) return '2-col';
  if (agentCount <= 4) return '2x2';
  if (agentCount <= 6) return '3x2';
  return '3x3';
}

// Keyboard shortcuts
export const KEYBOARD_SHORTCUTS: KeyboardShortcut[] = [
  { key: '1', ctrl: true, description: 'Focus terminal 1', action: 'focus:0' },
  { key: '2', ctrl: true, description: 'Focus terminal 2', action: 'focus:1' },
  { key: '3', ctrl: true, description: 'Focus terminal 3', action: 'focus:2' },
  { key: '4', ctrl: true, description: 'Focus terminal 4', action: 'focus:3' },
  { key: '5', ctrl: true, description: 'Focus terminal 5', action: 'focus:4' },
  { key: '6', ctrl: true, description: 'Focus terminal 6', action: 'focus:5' },
  { key: '7', ctrl: true, description: 'Focus terminal 7', action: 'focus:6' },
  { key: '8', ctrl: true, description: 'Focus terminal 8', action: 'focus:7' },
  { key: '9', ctrl: true, description: 'Focus terminal 9', action: 'focus:8' },
  { key: 'n', ctrl: true, shift: true, description: 'New agent', action: 'new-agent' },
  { key: 'f', ctrl: true, shift: true, description: 'Toggle fullscreen', action: 'toggle-fullscreen' },
  { key: 'b', ctrl: true, shift: true, description: 'Toggle broadcast', action: 'toggle-broadcast' },
  { key: 's', ctrl: true, shift: true, description: 'Toggle sidebar', action: 'toggle-sidebar' },
  { key: 'Escape', description: 'Exit fullscreen', action: 'exit-fullscreen' },
];

// Status colors: status tokens only, no filled pill (R6).
// `dot` feeds <StatusSquare>, `text` colours the raw status word.
export const STATUS_COLORS: Record<string, { text: string; dot: string }> = {
  running: { text: 'text-status-running', dot: 'bg-status-running' },
  waiting: { text: 'text-status-waiting', dot: 'bg-status-waiting' },
  idle: { text: 'text-status-idle', dot: 'bg-status-idle' },
  error: { text: 'text-status-error', dot: 'bg-status-error' },
  // `completed` is a real runtime status but not part of the design vocabulary.
  // It reads as idle rather than as a second accent colour.
  completed: { text: 'text-status-idle', dot: 'bg-status-idle' },
};

// Local storage key for persisting sidebar state
export const SIDEBAR_STORAGE_KEY = 'terminals-view-sidebar';
