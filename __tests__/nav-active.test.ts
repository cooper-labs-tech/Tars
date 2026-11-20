import './setup/home-guard';
import { describe, it, expect } from 'vitest';
import { normalisePathname } from '../src/hooks/useAppPathname';

/**
 * Which sidebar entry lights up.
 *
 * In the packaged app the renderer is a static export served over `app://`, so
 * the URL of the Agents page is `app://-/agents/` and Next's `usePathname()`
 * answers `/` for it. Every comparison then matched the Dashboard entry, and
 * the sidebar kept Dashboard lit alongside whatever page you had opened.
 *
 * The normalisation is what makes `window.location.pathname` usable instead:
 * the export writes hrefs with a trailing slash and serves `index.html`, and
 * neither of those is a different page.
 */

// Mirrors the rule in Sidebar.tsx.
function isNavActive(pathname: string, href: string): boolean {
  const here = normalisePathname(pathname);
  const target = normalisePathname(href);
  if (target === '/') return here === '/';
  return here === target || here.startsWith(`${target}/`);
}

describe('normalising what the app reports', () => {
  it('treats index.html as the root', () => {
    expect(normalisePathname('/index.html')).toBe('/');
  });

  it('treats a trailing slash as the same page', () => {
    expect(normalisePathname('/agents/')).toBe('/agents');
  });

  it('treats an exported .html page as its route', () => {
    expect(normalisePathname('/agents/index.html')).toBe('/agents');
  });

  it('leaves the root alone', () => {
    expect(normalisePathname('/')).toBe('/');
    expect(normalisePathname('')).toBe('/');
  });
});

describe('the entry that lights up', () => {
  it('lights Dashboard only at the root', () => {
    expect(isNavActive('/', '/')).toBe(true);
    expect(isNavActive('/index.html', '/')).toBe(true);
  });

  it('does not light Dashboard on another page, which is the reported bug', () => {
    // `/` is a prefix of every path, so this is the case that was wrong.
    expect(isNavActive('/agents/', '/')).toBe(false);
    expect(isNavActive('/chat/', '/')).toBe(false);
    expect(isNavActive('/settings/', '/')).toBe(false);
  });

  it('lights the page you opened, slash or no slash', () => {
    expect(isNavActive('/agents/', '/agents')).toBe(true);
    expect(isNavActive('/agents', '/agents')).toBe(true);
    expect(isNavActive('/agents/index.html', '/agents')).toBe(true);
  });

  it('lights a section from one of its sub-pages', () => {
    expect(isNavActive('/settings/hermes', '/settings')).toBe(true);
  });

  it('does not light a page whose name merely starts the same', () => {
    expect(isNavActive('/agents-archive', '/agents')).toBe(false);
  });

  it('lights exactly one entry at a time', () => {
    const items = ['/', '/chat', '/agents', '/kanban', '/settings'];
    for (const here of ['/', '/chat/', '/agents/', '/kanban/', '/settings/']) {
      const lit = items.filter(href => isNavActive(here, href));
      expect(lit, `on ${here}`).toHaveLength(1);
    }
  });
});
