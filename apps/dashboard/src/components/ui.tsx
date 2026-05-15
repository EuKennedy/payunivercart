import clsx from 'clsx';
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from 'react';

/**
 * Minimal design-system primitives. Apple Night Shift glassmorphism feel.
 * Replaces shadcn for the first vertical slice; the full system arrives
 * with `packages/ui` later.
 */

export function GlassCard({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return <div className={clsx('glass p-8', className)}>{children}</div>;
}

export function Button({
  children,
  variant = 'primary',
  className,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'ghost' | 'danger' }) {
  const base =
    'inline-flex items-center justify-center gap-2 rounded-xl px-5 py-2.5 text-sm font-medium transition disabled:opacity-50 disabled:cursor-not-allowed';
  const variants: Record<typeof variant, string> = {
    primary:
      'bg-gradient-to-b from-[var(--color-brand-400)] to-[var(--color-brand-600)] text-black shadow-[0_8px_24px_-12px_rgba(249,115,22,0.6)] hover:from-[var(--color-brand-300)] hover:to-[var(--color-brand-500)]',
    ghost:
      'border border-[var(--color-border)] bg-white/[0.02] text-[var(--color-fg)] hover:bg-white/[0.04]',
    danger: 'border border-red-500/30 bg-red-500/10 text-red-200 hover:bg-red-500/20',
  };
  return (
    <button className={clsx(base, variants[variant], className)} {...rest}>
      {children}
    </button>
  );
}

export function Input({
  label,
  className,
  ...rest
}: InputHTMLAttributes<HTMLInputElement> & { label?: string }) {
  return (
    <label className="block">
      {label && (
        <span className="mb-1.5 block text-xs uppercase tracking-wider text-[var(--color-fg-muted)]">
          {label}
        </span>
      )}
      <input
        className={clsx(
          'w-full rounded-xl border border-[var(--color-border)] bg-white/[0.02] px-4 py-2.5 text-sm text-[var(--color-fg)] outline-none transition',
          'placeholder:text-[var(--color-fg-subtle)] focus:border-[var(--color-brand-500)]/60 focus:bg-white/[0.04]',
          className,
        )}
        {...rest}
      />
    </label>
  );
}

export function Heading({
  level = 1,
  children,
}: {
  level?: 1 | 2 | 3;
  children: ReactNode;
}) {
  const cls =
    level === 1
      ? 'text-3xl font-semibold tracking-tight'
      : level === 2
        ? 'text-2xl font-semibold tracking-tight'
        : 'text-lg font-semibold';
  if (level === 1) return <h1 className={cls}>{children}</h1>;
  if (level === 2) return <h2 className={cls}>{children}</h2>;
  return <h3 className={cls}>{children}</h3>;
}

export function StatusPill({ status }: { status: string }) {
  const tone =
    status === 'WORKING'
      ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30'
      : status === 'FAILED'
        ? 'bg-red-500/15 text-red-300 border-red-500/30'
        : status === 'STOPPED'
          ? 'bg-zinc-500/15 text-zinc-300 border-zinc-500/30'
          : 'bg-amber-500/15 text-amber-300 border-amber-500/30';
  return (
    <span
      className={clsx(
        'inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium',
        tone,
      )}
    >
      <span className="size-1.5 rounded-full bg-current" />
      {status}
    </span>
  );
}
