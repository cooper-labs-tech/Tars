import { create } from 'zustand';

/**
 * The small amount of UI state that is genuinely global.
 *
 * This file used to be 436 lines: a full in-memory domain model - agents,
 * tasks, projects, skills, entities, chats, their CRUD actions and four
 * selectors - seeded with sample data ("E-Commerce Platform", "Dashboard
 * Analytics", eight invented skills). None of it was ever read. Every
 * `useStore()` call site in the app destructures from the eight members below,
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
  /** Mobile drawer. The desktop sidebar is always open. */
  mobileMenuOpen: boolean;
  /** Dark is the launch default; ClientLayout persists this to `tars-theme`. */
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
  /** The Load window card's view, set by its head's switch and by what opens the card at Projects. */
  loadView: 'window' | 'projects';
  /** A page of More asked to open from outside the sidebar (a project page's Load agents card): NewShell opens it. */
  moreRequest: { page: string; at: number } | null;

  setMobileMenuOpen: (open: boolean) => void;
  toggleMobileMenu: () => void;
  setDarkMode: (dark: boolean) => void;
  toggleDarkMode: () => void;
  setVaultUnreadCount: (count: number) => void;
  setPendingUpdateVersion: (version: string | null) => void;
  setUpdateBannerDismissed: (dismissed: boolean) => void;
  setLoadView: (view: 'window' | 'projects') => void;
  requestMore: (page: string) => void;
}

export const useStore = create<UiState>((set) => ({
  mobileMenuOpen: false,
  darkMode: true,
  vaultUnreadCount: 0,
  pendingUpdateVersion: null,
  updateBannerDismissed: false,
  loadView: 'window',
  moreRequest: null,

  setMobileMenuOpen: (open) => set({ mobileMenuOpen: open }),
  toggleMobileMenu: () => set((state) => ({ mobileMenuOpen: !state.mobileMenuOpen })),
  setDarkMode: (dark) => set({ darkMode: dark }),
  toggleDarkMode: () => set((state) => ({ darkMode: !state.darkMode })),
  setVaultUnreadCount: (count) => set({ vaultUnreadCount: count }),
  setPendingUpdateVersion: (version) => set({ pendingUpdateVersion: version }),
  setUpdateBannerDismissed: (dismissed) => set({ updateBannerDismissed: dismissed }),
  setLoadView: (view) => set({ loadView: view }),
  requestMore: (page) => set({ moreRequest: { page, at: Date.now() } }),
}));
