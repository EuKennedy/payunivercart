import clsx from 'clsx';
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from 'react';

/**
 * Design system primitives — light-first, Apple-tier.
 *
 * Used by every authenticated and unauthenticated surface. Each primitive
 * is opinionated about spacing, radius and motion; consumers should
 * compose them rather than override.
 */

// =============================================================================
// Surface — flat white card with hair-thin border + microscopic shadow.
// Replaces the previous .glass primitive. Three variants:
//   - default: shadow-sm, used for content blocks.
//   - flush: no shadow, used for sub-cards inside a Surface.
//   - interactive: hover lift, used for clickable cards (Pillar, NavItem).
// =============================================================================

export function Surface({
  children,
  className,
  variant = 'default',
}: {
  children: ReactNode;
  className?: string;
  variant?: 'default' | 'flush' | 'interactive';
}) {
  const variants = {
    default: 'surface',
    flush: 'surface-flush',
    interactive: 'surface-interactive',
  } as const;
  return <div className={clsx(variants[variant], 'p-6', className)}>{children}</div>;
}

// =============================================================================
// Button — primary (brand), secondary (subtle), ghost (text), danger.
// Sizing controlled via className override; default is comfortable.
// =============================================================================

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

export function Button({
  children,
  variant = 'primary',
  className,
  size = 'md',
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: 'sm' | 'md' | 'lg';
}) {
  const sizes = {
    sm: 'px-3.5 py-1.5 text-[13px]',
    md: 'px-5 py-2.5 text-sm',
    lg: 'px-6 py-3 text-[15px]',
  } as const;

  const variants: Record<ButtonVariant, string> = {
    primary:
      'bg-[var(--color-fg)] text-[var(--color-fg-inverse)] hover:bg-[#000] active:bg-[#000] ' +
      'shadow-[0_1px_2px_rgba(0,0,0,0.08)]',
    secondary:
      'bg-[var(--color-surface)] text-[var(--color-fg)] border border-[var(--color-border)] ' +
      'hover:bg-[var(--color-surface-hover)] hover:border-[var(--color-border-strong)]',
    ghost:
      'bg-transparent text-[var(--color-fg)] hover:bg-[var(--color-surface-muted)]',
    danger:
      'bg-[var(--color-danger-bg)] text-[var(--color-danger)] border border-transparent ' +
      'hover:bg-[#ffd9d6]',
  };

  return (
    <button
      className={clsx(
        'inline-flex select-none items-center justify-center gap-2 rounded-full font-medium transition',
        'disabled:cursor-not-allowed disabled:opacity-40',
        'focus-visible:ring-2 focus-visible:ring-[var(--color-fg)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-bg)]',
        sizes[size],
        variants[variant],
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}

// =============================================================================
// Input — Apple-style with floating label. Generous touch target, hairline
// border, focus ring tinted with brand color.
// =============================================================================

export function Input({
  label,
  className,
  ...rest
}: InputHTMLAttributes<HTMLInputElement> & { label?: string }) {
  return (
    <label className="block">
      {label && (
        <span className="mb-2 block text-[13px] font-medium text-[var(--color-fg-muted)]">
          {label}
        </span>
      )}
      <input
        className={clsx(
          'w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)]',
          'px-4 py-3 text-[15px] text-[var(--color-fg)] outline-none transition',
          'placeholder:text-[var(--color-fg-subtle)]',
          'hover:border-[var(--color-border-strong)]',
          'focus:border-[var(--color-brand-500)] focus:ring-4 focus:ring-[var(--color-brand-500)]/15',
          className,
        )}
        {...rest}
      />
    </label>
  );
}

// =============================================================================
// Heading — three sizes. The display variant is used for marketing hero.
// =============================================================================

export function Heading({
  level = 1,
  children,
  className,
}: {
  level?: 1 | 2 | 3;
  children: ReactNode;
  className?: string;
}) {
  if (level === 1) {
    return (
      <h1
        className={clsx(
          'display text-[34px] font-semibold text-[var(--color-fg)] md:text-[40px]',
          className,
        )}
      >
        {children}
      </h1>
    );
  }
  if (level === 2) {
    return (
      <h2
        className={clsx(
          'display text-2xl font-semibold text-[var(--color-fg)] md:text-3xl',
          className,
        )}
      >
        {children}
      </h2>
    );
  }
  return (
    <h3 className={clsx('text-lg font-semibold text-[var(--color-fg)]', className)}>{children}</h3>
  );
}

// =============================================================================
// Kicker — small, uppercase, brand-tinted eyebrow that sits above titles.
// =============================================================================

export function Kicker({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span
      className={clsx(
        'inline-block text-[11px] font-medium uppercase tracking-[0.18em] text-[var(--color-brand-600)]',
        className,
      )}
    >
      {children}
    </span>
  );
}

// =============================================================================
// EmptyState — premium placeholder for routes whose feature work is
// still upstream. Light, generous spacing, centered.
// =============================================================================

export function EmptyState({
  kicker,
  title,
  description,
  action,
  className,
}: {
  kicker?: string;
  title: string;
  description: string;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={clsx('mx-auto flex max-w-2xl flex-col items-start gap-5', className)}>
      {kicker && <Kicker>{kicker}</Kicker>}
      <Heading level={1}>{title}</Heading>
      <p className="text-[17px] leading-[1.5] text-[var(--color-fg-muted)]">{description}</p>
      {action && <div className="pt-2">{action}</div>}
    </div>
  );
}

// =============================================================================
// StatusPill — color-coded status indicator (WORKING / FAILED / etc).
// =============================================================================

export function StatusPill({ status }: { status: string }) {
  const palette = {
    WORKING:
      'bg-[var(--color-success-bg)] text-[var(--color-success)] border-[rgba(0,135,90,0.18)]',
    SCAN_QR_CODE:
      'bg-[var(--color-warning-bg)] text-[var(--color-warning)] border-[rgba(183,110,0,0.18)]',
    STARTING:
      'bg-[var(--color-info-bg)] text-[var(--color-info)] border-[rgba(11,107,203,0.18)]',
    FAILED: 'bg-[var(--color-danger-bg)] text-[var(--color-danger)] border-[rgba(194,38,26,0.18)]',
    STOPPED:
      'bg-[var(--color-surface-muted)] text-[var(--color-fg-muted)] border-[var(--color-border)]',
  } as const;
  const tone =
    palette[status as keyof typeof palette] ??
    'bg-[var(--color-surface-muted)] text-[var(--color-fg-muted)] border-[var(--color-border)]';
  return (
    <span
      className={clsx(
        'inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-[11px] font-medium uppercase tracking-wider',
        tone,
      )}
    >
      <span className="size-1.5 rounded-full bg-current" />
      {status}
    </span>
  );
}

// =============================================================================
// Glass surface — DEPRECATED. Kept as alias so legacy refs compile.
// New code should prefer <Surface>.
// =============================================================================

export function GlassCard({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return <Surface className={className}>{children}</Surface>;
}
