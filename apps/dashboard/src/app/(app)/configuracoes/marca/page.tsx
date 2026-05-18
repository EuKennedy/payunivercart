'use client';

import { useEffect, useState } from 'react';
import { type ImageUpload, ImageUploadField } from '../../../../components/ImageUploadField';
import { Button, Heading } from '../../../../components/ui';
import { API_URL } from '../../../../lib/env';
import { trpc } from '../../../../lib/trpc';

/**
 * Configurações → Minha marca.
 *
 * Producer-facing branding controls. The values here drive the public
 * checkout's header — `companyName` replaces the auto-generated
 * workspace label (which defaults to the personal name captured at
 * signup) and the uploaded logo replaces the gradient initial.
 *
 * Logo upload pipeline mirrors `/produtos/[id]` — base64 + MIME → tRPC
 * mutation → bytea column. The image is served by the api at
 * `/img/workspace/:id/logo` so the checkout subdomain can render it
 * without a separate auth handshake.
 */
export default function MarcaSettingsPage() {
  const utils = trpc.useUtils();
  const branding = trpc.workspace.branding.useQuery();
  const update = trpc.workspace.updateBranding.useMutation({
    onSuccess: async () => {
      await utils.workspace.branding.invalidate();
    },
  });

  const [companyName, setCompanyName] = useState('');
  const [brandPrimaryColor, setBrandPrimaryColor] = useState('');
  const [logo, setLogo] = useState<ImageUpload | null>(null);
  const [seeded, setSeeded] = useState(false);

  useEffect(() => {
    if (seeded || !branding.data) return;
    setCompanyName(branding.data.companyName ?? branding.data.name);
    setBrandPrimaryColor(branding.data.brandPrimaryColor ?? '');
    setSeeded(true);
  }, [branding.data, seeded]);

  if (branding.isPending) {
    return <p className="text-[15px] text-[var(--color-fg-muted)]">Carregando…</p>;
  }
  if (!branding.data) {
    return <p className="text-[15px] text-[var(--color-danger)]">Workspace inexistente.</p>;
  }

  const trimmedCompany = companyName.trim();
  const trimmedColor = brandPrimaryColor.trim();
  const validationError = (() => {
    if (trimmedCompany.length === 0) return 'Informe o nome da empresa.';
    if (trimmedCompany.length > 120) return 'Nome muito longo (máx 120 caracteres).';
    if (trimmedColor && !/^#[0-9a-fA-F]{6}$/.test(trimmedColor))
      return 'Cor deve estar no formato #RRGGBB.';
    return null;
  })();
  const apiError = update.error?.message ?? null;
  const onSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (validationError) return;
    update.mutate({
      companyName: trimmedCompany,
      brandPrimaryColor: trimmedColor ? trimmedColor : null,
      ...(logo ? { logo } : {}),
    });
  };

  const logoPreviewUrl = branding.data.hasLogo
    ? `${API_URL}/img/workspace/${branding.data.workspaceId}/logo?v=${Date.now()}`
    : null;

  return (
    <section className="flex flex-col gap-6">
      <Heading level={2}>Marca</Heading>
      <p className="text-[14px] text-[var(--color-fg-muted)] leading-[1.55]">
        O <strong>nome da empresa</strong> e o <strong>logo</strong> aparecem no topo do seu
        checkout público — substituem o nome de usuário usado pra criar a conta. A cor primária
        tinge botões e detalhes pra combinar com a sua identidade visual.
      </p>

      <form onSubmit={onSubmit} className="flex max-w-2xl flex-col gap-6">
        <Field label="Nome da empresa" hint="Aparece no cabeçalho do checkout que seu cliente vê.">
          <input
            type="text"
            value={companyName}
            onChange={(e) => setCompanyName(e.target.value)}
            className={fieldInputClass}
            maxLength={120}
          />
        </Field>

        <ImageUploadField
          label="Logo da empresa"
          hint="Recomendado 1:1 (PNG/JPEG/WEBP, até 2 MB). Deixe em branco pra manter o logo atual."
          initialPreviewUrl={logoPreviewUrl}
          enforceSquare
          onChange={setLogo}
        />

        <Field label="Cor primária" hint="Hex no formato #RRGGBB. Opcional.">
          <input
            type="text"
            value={brandPrimaryColor}
            onChange={(e) => setBrandPrimaryColor(e.target.value)}
            placeholder="#ff6a00"
            className={fieldInputClass}
            maxLength={7}
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
    // biome-ignore lint/a11y/noLabelWithoutControl: input rendered via {children}; biome can't trace into children, but HTML label semantics still focus the first descendant control on click.
    <label className="flex flex-col gap-2">
      <span className="font-medium text-[13px] text-[var(--color-fg-muted)]">{label}</span>
      {children}
      {hint ? <span className="text-[12px] text-[var(--color-fg-subtle)]">{hint}</span> : null}
    </label>
  );
}
