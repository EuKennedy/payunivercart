'use client';

import { createContext, useCallback, useContext, useEffect, useState } from 'react';

/**
 * Light / Dark / System theme manager.
 *
 * Architecture:
 *   1. `<ThemeProvider>` sits inside `<Providers>` in the root layout.
 *   2. On mount it reads `localStorage.theme` (saved choice) and falls
 *      back to OS preference. The resolved choice is applied to
 *      `<html data-theme>` so the CSS variables defined in
 *      `globals.css` swap stacks in one paint.
 *   3. `useTheme()` returns `{ theme, resolvedTheme, setTheme }` for
 *      the toggle component to call.
 *
 * Hydration: SSR can't read localStorage, so the inline `ThemeScript`
 * runs before React hydrates and stamps the right `data-theme` on
 * <html> to prevent a light → dark flash. The runtime state hook
 * re-reads on mount and stays in sync.
 */

export type Theme = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

const STORAGE_KEY = 'payunivercart.dashboard.theme';

interface ThemeContextValue {
  theme: Theme;
  resolvedTheme: ResolvedTheme;
  setTheme: (next: Theme) => void;
  toggle: () => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = useState<Theme>('system');
  const [resolvedTheme, setResolvedTheme] = useState<ResolvedTheme>('light');

  // First-paint hydration — read saved pick + OS pref.
  useEffect(() => {
    let stored: Theme = 'system';
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw === 'light' || raw === 'dark' || raw === 'system') stored = raw;
    } catch {
      /* private mode */
    }
    setThemeState(stored);
    applyTheme(stored);
    setResolvedTheme(currentResolved());

    // Sync when OS pref changes AND the user is on "system".
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const handleChange = () => {
      if (stored === 'system' || readStorage() === 'system') {
        applyTheme('system');
        setResolvedTheme(currentResolved());
      }
    };
    mq.addEventListener('change', handleChange);
    return () => mq.removeEventListener('change', handleChange);
  }, []);

  const setTheme = useCallback((next: Theme) => {
    setThemeState(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      /* noop */
    }
    applyTheme(next);
    setResolvedTheme(currentResolved());
  }, []);

  const toggle = useCallback(() => {
    // Cycle light → dark → system → light. Skip system on the toggle
    // button — power users open the menu for the trichoice.
    const next: Theme = resolvedTheme === 'dark' ? 'light' : 'dark';
    setTheme(next);
  }, [resolvedTheme, setTheme]);

  return (
    <ThemeContext.Provider value={{ theme, resolvedTheme, setTheme, toggle }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) {
    // Render-safe fallback so hooks never crash if used outside the
    // provider tree (e.g. on a route that forgot to wrap).
    return {
      theme: 'system',
      resolvedTheme: 'light',
      setTheme: () => undefined,
      toggle: () => undefined,
    };
  }
  return ctx;
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function applyTheme(theme: Theme) {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  if (theme === 'system') {
    root.removeAttribute('data-theme');
    return;
  }
  root.setAttribute('data-theme', theme);
}

function readStorage(): Theme {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === 'light' || raw === 'dark' || raw === 'system') return raw;
  } catch {
    /* noop */
  }
  return 'system';
}

function currentResolved(): ResolvedTheme {
  if (typeof window === 'undefined' || typeof document === 'undefined') return 'light';
  const explicit = document.documentElement.getAttribute('data-theme');
  if (explicit === 'dark') return 'dark';
  if (explicit === 'light') return 'light';
  // No explicit pick = follow OS.
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/**
 * Inline script injected via `next/script` (strategy="beforeInteractive")
 * OR a direct `<script dangerouslySetInnerHTML>` block in the layout
 * `<head>`. Runs before React hydrates so the first painted frame
 * already has the right theme — eliminates the light flash on dark
 * users.
 */
export const themeBootstrapScript = `
(function(){
  try {
    var k = '${STORAGE_KEY}';
    var v = localStorage.getItem(k);
    if (v === 'dark' || v === 'light') {
      document.documentElement.setAttribute('data-theme', v);
    }
  } catch(_) {}
})();
`;
