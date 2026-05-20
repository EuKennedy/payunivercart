'use client';

import { type Theme, useTheme } from './ThemeProvider';

/**
 * Theme toggle adapted to the checkout token system (`--ink-*`,
 * `--hairline`, `--bg-elev-*` etc). Same behaviour as the dashboard
 * variant — 3-pill segmented control or compact icon toggle.
 */
export function ThemeToggle({ compact = false }: { compact?: boolean }) {
  const { theme, setTheme } = useTheme();

  if (compact) {
    return <CompactToggle theme={theme} setTheme={setTheme} />;
  }

  return (
    <div
      // biome-ignore lint/a11y/useSemanticElements: <fieldset>+<legend> adds visual baggage we don't want on a 3-pill toggle; the radiogroup role is the semantic equivalent.
      role="radiogroup"
      aria-label="Tema"
      className="inline-flex items-center gap-1 rounded-full border border-[var(--hairline)] bg-[var(--bg-elev-1)] p-1"
    >
      <Pill active={theme === 'light'} onClick={() => setTheme('light')} label="Tema claro">
        <SunIcon />
      </Pill>
      <Pill active={theme === 'system'} onClick={() => setTheme('system')} label="Tema do sistema">
        <SystemIcon />
      </Pill>
      <Pill active={theme === 'dark'} onClick={() => setTheme('dark')} label="Tema escuro">
        <MoonIcon />
      </Pill>
    </div>
  );
}

function CompactToggle({
  theme,
  setTheme,
}: {
  theme: Theme;
  setTheme: (next: Theme) => void;
}) {
  const next: Theme = theme === 'light' ? 'dark' : theme === 'dark' ? 'system' : 'light';
  return (
    <button
      type="button"
      onClick={() => setTheme(next)}
      title={`Tema atual: ${LABEL[theme]}. Clique pra alternar.`}
      className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-[var(--hairline)] bg-[var(--bg-elev-1)] text-[var(--ink-70)] transition hover:border-[var(--hairline-strong)] hover:text-[var(--ink-100)]"
      aria-label={`Alternar tema (atual: ${LABEL[theme]})`}
    >
      {theme === 'light' ? <SunIcon /> : theme === 'dark' ? <MoonIcon /> : <SystemIcon />}
    </button>
  );
}

function Pill({
  active,
  onClick,
  label,
  children,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      // biome-ignore lint/a11y/useSemanticElements: native <input type="radio"> can't carry the bg/shadow/SVG content inline; the radio ARIA pattern is the proper substitute.
      role="radio"
      aria-checked={active}
      onClick={onClick}
      aria-label={label}
      title={label}
      className={`inline-flex h-6 w-6 items-center justify-center rounded-full transition ${
        active
          ? 'bg-[var(--ink-100)] text-[var(--bg)] shadow-[var(--sh-sm)]'
          : 'text-[var(--ink-70)] hover:text-[var(--ink-100)]'
      }`}
    >
      {children}
    </button>
  );
}

const LABEL: Record<Theme, string> = {
  light: 'claro',
  dark: 'escuro',
  system: 'sistema',
};

function SunIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      aria-hidden="true"
      focusable="false"
      className="size-3.5"
    >
      <circle cx="12" cy="12" r="4" />
      <path
        strokeLinecap="round"
        d="M12 3v2M12 19v2M5 12H3M21 12h-2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M5.6 18.4 7 17M17 7l1.4-1.4"
      />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
      className="size-3.5"
    >
      <path d="M21 12.8a9 9 0 1 1-9.8-9.8 7 7 0 0 0 9.8 9.8z" />
    </svg>
  );
}

function SystemIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      aria-hidden="true"
      focusable="false"
      className="size-3.5"
    >
      <rect x="3" y="4" width="18" height="13" rx="2" />
      <path strokeLinecap="round" d="M9 21h6M12 17v4" />
    </svg>
  );
}
