import { create } from 'zustand';

/**
 * The small amount of UI state that is genuinely global.
 *
 * This file used to be 436 lines: a full in-memory domain model - agents,
 * tasks, projects, skills, entities, chats, their CRUD actions and four
 * selectors - seeded with sample data ("E-Commerce Platform", "Dashboard
 * Analytics", eight invented skills). None of it was ever read. Every
 * `useStore()` call site in the app destructures from the members below,
 * and the real data comes from IPC hooks in `src/hooks/`, not from here.
 *
 * The sample data shipped in the bundle, which is the part worth avoiding: a
 * store seeded with fake projects is one wrong selector away from showing them
 * to a user.
 *
 * Keep this file small. State that belongs to one screen belongs in that
 * screen; state that comes from the main process belongs in a hook over IPC.
 */
interface UiState {
  /** Dark is the launch default; ClientLayout persists this to `tars-theme`. Settings, Preferences,
   *  Appearance sets it. */
  darkMode: boolean;
  /** Badge on the Vault nav row, kept live by a main-process event so it is
   *  correct even when VaultView is not mounted. */
  vaultUnreadCount: number;
  /** The version waiting to be installed, or null when the app is current.
   *  Set by ClientLayout from the main process, read by the sidebar row. */
  pendingUpdateVersion: string | null;
  /** The update panel is dismissible, and dismissing it used to hide the
   *  update until the next launch. The sidebar row clears this, so there is
   *  always a way back to it. */
  updateBannerDismissed: boolean;

  setDarkMode: (dark: boolean) => void;
  setVaultUnreadCount: (count: number) => void;
  setPendingUpdateVersion: (version: string | null) => void;
  setUpdateBannerDismissed: (dismissed: boolean) => void;
}

export const useStore = create<UiState>((set) => ({
  darkMode: true,
  vaultUnreadCount: 0,
  pendingUpdateVersion: null,
  updateBannerDismissed: false,

  setDarkMode: (dark) => set({ darkMode: dark }),
  setVaultUnreadCount: (count) => set({ vaultUnreadCount: count }),
  setPendingUpdateVersion: (version) => set({ pendingUpdateVersion: version }),
  setUpdateBannerDismissed: (dismissed) => set({ updateBannerDismissed: dismissed }),
}));
