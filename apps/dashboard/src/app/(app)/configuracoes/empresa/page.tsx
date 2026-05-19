'use client';

import { useEffect, useState } from 'react';
import { Button, Heading } from '../../../../components/ui';
import { trpc } from '../../../../lib/trpc';

/**
 * Configurações → Empresa.
 *
 * Workspace identity: internal name (sidebar label, audit logs) and
 * URL-safe slug (eventual deep-link surface). The slug regex blocks
 * leading/trailing hyphens so an export of "ACME --" doesn't slip in.
 */
export default function EmpresaSettingsPage() {
  const utils = trpc.useUtils();
  const profile = trpc.workspace.profile.useQuery();
  const update = trpc.workspace.updateProfile.useMutation({
    onSuccess: async () => {
      await Promise.all([
        utils.workspace.profile.invalidate(),
        utils.workspace.me.invalidate(),
        utils.workspace.list.invalidate(),
      ]);
    },
  });

  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [notificationPhone, setNotificationPhone] = useState('');
  const [seeded, setSeeded] = useState(false);

  useEffect(() => {
    if (seeded || !profile.data) return;
    setName(profile.data.name);
    setSlug(profile.data.slug);
    setNotificationPhone(profile.data.notificationPhoneE164 ?? '');
    setSeeded(true);
  }, [profile.data, seeded]);

  if (profile.isPending) {
    return <p className="text-[15px] text-[var(--color-fg-muted)]">Carregando…</p>;
  }
  if (!profile.data) {
    return <p className="text-[15px] text-[var(--color-danger)]">Workspace inexistente.</p>;
  }

  const trimmedName = name.trim();
  const trimmedSlug = slug.trim();
  const trimmedPhone = notificationPhone.trim();
  const validationError = (() => {
    if (trimmedName.length === 0) return 'Informe o nome da workspace.';
    if (trimmedName.length > 120) return 'Nome muito longo (máx 120).';
    if (trimmedSlug.length < 2) return 'Identificador muito curto.';
    if (trimmedSlug.length > 40) return 'Identificador muito longo (máx 40).';
    if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(trimmedSlug))
      return 'Identificador: minúsculas, números e hífen (sem extremos).';
    if (trimmedPhone.length > 0 && !/^\+\d{10,15}$/.test(trimmedPhone))
      return 'WhatsApp: use formato internacional, ex: +5531984956383.';
    return null;
  })();
  const apiError = update.error?.message ?? null;

  const onSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (validationError) return;
    update.mutate({
      name: trimmedName,
      slug: trimmedSlug,
      notificationPhoneE164: trimmedPhone.length > 0 ? trimmedPhone : null,
    });
  };

  return (
    <section className="flex flex-col gap-6">
      <Heading level={2}>Empresa</Heading>
      <p className="text-[14px] text-[var(--color-fg-muted)] leading-[1.55]">
        O <strong>nome</strong> aparece no menu lateral do dashboard e nos relatórios internos. O{' '}
        <strong>identificador</strong> é usado em futuras URLs deep-link.
      </p>
      <form onSubmit={onSubmit} className="flex max-w-2xl flex-col gap-5">
        <Field label="Nome">
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className={fieldInputClass}
            maxLength={120}
          />
        </Field>
        <Field label="Identificador (slug)" hint="Ex.: acme-loja. Minúsculas, números e hífen.">
          <input
            type="text"
            value={slug}
            onChange={(e) => setSlug(e.target.value.toLowerCase())}
            className={`${fieldInputClass} font-mono`}
            maxLength={40}
          />
        </Field>

        <Field
          label="WhatsApp pra alerta de venda"
          hint="Opcional. Quando alguém comprar, mandamos um ping pro seu WhatsApp via WAHA. Formato internacional, ex: +5531984956383."
        >
          <input
            type="tel"
            value={notificationPhone}
            onChange={(e) => setNotificationPhone(e.target.value.replace(/[^+\d]/g, ''))}
            className={`${fieldInputClass} font-mono`}
            placeholder="+5531984956383"
            maxLength={20}
            inputMode="tel"
            autoComplete="tel"
          />
        </Field>

        {validationError ? (
          <p className="text-[13px] text-[var(--color-danger)]">{validationError}</p>
        ) : null}
        {apiError ? <p className="text-[13px] text-[var(--color-danger)]">{apiError}</p> : null}
        {update.isSuccess && !update.isPending ? (
          <p className="text-[13px] text-[var(--color-success)]">Alterações salvas.</p>
        ) : null}

        <div className="flex items-center gap-3 pt-2">
          <Button type="submit" disabled={!!validationError || update.isPending}>
            {update.isPending ? 'Salvando…' : 'Salvar alterações'}
          </Button>
        </div>
      </form>
    </section>
  );
}

const fieldInputClass =
  'w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] ' +
  'px-4 py-3 text-[15px] text-[var(--color-fg)] outline-none transition ' +
  'placeholder:text-[var(--color-fg-subtle)] ' +
  'hover:border-[var(--color-border-strong)] ' +
  'focus:border-[var(--color-brand-500)] focus:ring-4 focus:ring-[var(--color-brand-500)]/15';

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: input rendered via {children}; label wraps the control via React composition.
    <label className="flex flex-col gap-2">
      <span className="font-medium text-[13px] text-[var(--color-fg-muted)]">{label}</span>
      {children}
      {hint ? <span className="text-[12px] text-[var(--color-fg-subtle)]">{hint}</span> : null}
    </label>
  );
}
