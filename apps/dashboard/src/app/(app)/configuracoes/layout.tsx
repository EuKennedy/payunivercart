'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Heading, Kicker } from '../../../components/ui';

/**
 * Configurações shell. Left rail of section links + content slot on
 * the right. Mirrors Linear's / Stripe's settings layout: every
 * surface that lives "under configuration" gets a slot here so the
 * producer's mental model is one stable URL hierarchy.
 *
 * Sections:
 *   - Empresa    — workspace identity (internal name, slug)
 *   - Marca      — buyer-facing branding (companyName, logo, color)
 *
 * More tabs land as we add billing, team, security, etc.
 */

const SECTIONS = [
  {
    href: '/configuracoes/empresa',
    label: 'Empresa',
    description: 'Nome, identificador, fuso',
  },
  {
    href: '/configuracoes/marca',
    label: 'Marca',
    description: 'Logo, nome da empresa e cor',
  },
  {
    href: '/configuracoes/notificacoes',
    label: 'Notificações',
    description: 'Templates de email e WhatsApp',
  },
] as const;

export default function ConfiguracoesLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  return (
    <div className="flex flex-col gap-10">
      <header className="flex flex-col gap-3">
        <Kicker>configurações</Kicker>
        <Heading level={1}>Configurações</Heading>
        <p className="max-w-2xl text-[15px] text-[var(--color-fg-muted)] leading-[1.55]">
          Tudo que controla como sua workspace aparece pra você e pros seus clientes.
        </p>
      </header>

      <div className="grid grid-cols-1 gap-10 lg:grid-cols-[220px_minmax(0,1fr)]">
        <nav aria-label="Configurações" className="flex flex-col gap-1">
          {SECTIONS.map((section) => {
            const active = pathname === section.href;
            return (
              <Link
                key={section.href}
                href={section.href}
                className={`group flex flex-col gap-0.5 rounded-xl px-3 py-2.5 transition ${
                  active
                    ? 'bg-[var(--color-surface-muted)] text-[var(--color-fg)]'
                    : 'text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-muted)] hover:text-[var(--color-fg)]'
                }`}
              >
                <span className="font-medium text-[14px]">{section.label}</span>
                <span className="text-[11px] text-[var(--color-fg-subtle)]">
                  {section.description}
                </span>
              </Link>
            );
          })}
        </nav>

        <div className="min-w-0">{children}</div>
      </div>
    </div>
  );
}
