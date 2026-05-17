'use client';

import { useState } from 'react';
import { Button, Heading, Kicker } from '../../../../components/ui';
import { trpc } from '../../../../lib/trpc';

/**
 * Gateways de pagamento — produtor cadastra suas chaves de Mercado Pago,
 * Pagar.me, etc. Block 22 mostra apenas o caminho Mercado Pago (o mais
 * usado no BR para PIX); adicionar outros é uma extensão direta.
 *
 * Secrets:
 *   - Tudo digitado aqui vai criptografado via AES-256-GCM (KEK em
 *     packages/crypto) antes de chegar no DB.
 *   - O backend valida as credenciais com o gateway antes do INSERT —
 *     uma chave inválida é rejeitada na hora, sem deixar a primeira
 *     venda do produtor falhar.
 *   - Nunca exibimos secret armazenado de volta na tela; o produtor que
 *     perdeu a chave precisa cadastrar uma nova.
 */
export default function GatewaysPage() {
  const list = trpc.gateways.list.useQuery();
  const utils = trpc.useUtils();

  const upsert = trpc.gateways.upsert.useMutation({
    onSuccess: () => {
      utils.gateways.list.invalidate();
      setShowForm(false);
      resetForm();
    },
  });
  const test = trpc.gateways.test.useMutation({
    onSuccess: () => utils.gateways.list.invalidate(),
  });
  const remove = trpc.gateways.remove.useMutation({
    onSuccess: () => utils.gateways.list.invalidate(),
  });
  const setDefault = trpc.gateways.setDefault.useMutation({
    onSuccess: () => utils.gateways.list.invalidate(),
  });

  const [showForm, setShowForm] = useState(false);
  const [accessToken, setAccessToken] = useState('');
  const [publicKey, setPublicKey] = useState('');
  const [webhookSecret, setWebhookSecret] = useState('');
  const [label, setLabel] = useState('Mercado Pago');
  const [isSandbox, setIsSandbox] = useState(true);

  function resetForm() {
    setAccessToken('');
    setPublicKey('');
    setWebhookSecret('');
    setLabel('Mercado Pago');
    setIsSandbox(true);
  }

  const onSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    upsert.mutate({
      gatewayId: 'mercadopago',
      label: label.trim() || 'Mercado Pago',
      isDefault: true,
      isSandbox,
      validateBeforeSave: true,
      credentials: {
        accessToken: accessToken.trim(),
        publicKey: publicKey.trim(),
        webhookSecret: webhookSecret.trim() || undefined,
        isSandbox,
      },
    });
  };

  return (
    <div className="flex flex-col gap-10">
      <header className="flex flex-col gap-3">
        <Kicker>integrações · gateways</Kicker>
        <Heading level={1}>Conecte seu gateway de pagamento.</Heading>
        <p className="max-w-2xl text-[15px] leading-[1.55] text-[var(--color-fg-muted)]">
          Cadastre suas chaves do Mercado Pago para começar a receber via Pix no checkout. As
          credenciais ficam criptografadas no banco — nem o time da plataforma vê a chave depois
          de salva.
        </p>
      </header>

      {/* Existing gateways */}
      <section className="flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <Heading level={3}>Gateways ativos</Heading>
          {!showForm ? (
            <Button onClick={() => setShowForm(true)}>Adicionar Mercado Pago</Button>
          ) : null}
        </div>

        {list.isPending ? (
          <p className="text-[14px] text-[var(--color-fg-muted)]">Carregando…</p>
        ) : list.data && list.data.length > 0 ? (
          <ul className="overflow-hidden rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)]">
            {list.data.map((row) => (
              <li
                key={row.id}
                className="flex items-center justify-between gap-4 border-b border-[var(--color-border)] px-5 py-4 last:border-b-0"
              >
                <div className="flex flex-col gap-1">
                  <div className="flex items-center gap-2">
                    <span className="text-[15px] font-semibold text-[var(--color-fg)]">
                      {row.label}
                    </span>
                    <span className="rounded-full bg-[var(--color-surface-muted)] px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-[var(--color-fg-subtle)]">
                      {row.gatewayId}
                    </span>
                    {row.isSandbox ? (
                      <span className="rounded-full bg-[var(--color-warning-bg)] px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-[var(--color-warning)]">
                        Sandbox
                      </span>
                    ) : null}
                    {row.isDefault ? (
                      <span className="rounded-full bg-[var(--color-success-bg)] px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-[var(--color-success)]">
                        Padrão
                      </span>
                    ) : null}
                  </div>
                  <p className="text-[12px] text-[var(--color-fg-subtle)]">
                    {row.lastValidatedAt
                      ? `Validado em ${new Date(row.lastValidatedAt).toLocaleString('pt-BR')}`
                      : row.validationError
                      ? `Falha: ${row.validationError}`
                      : 'Aguardando validação'}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => test.mutate({ id: row.id })}
                    disabled={test.isPending}
                  >
                    Testar
                  </Button>
                  {!row.isDefault ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setDefault.mutate({ id: row.id })}
                      disabled={setDefault.isPending}
                    >
                      Tornar padrão
                    </Button>
                  ) : null}
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      if (!confirm(`Remover "${row.label}"?`)) return;
                      remove.mutate({ id: row.id });
                    }}
                    disabled={remove.isPending}
                  >
                    Remover
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <div className="rounded-2xl border border-dashed border-[var(--color-border)] bg-[var(--color-surface)] px-6 py-10 text-center">
            <p className="text-[14px] text-[var(--color-fg-muted)]">
              Nenhum gateway cadastrado. Conecte o Mercado Pago para liberar Pix no checkout.
            </p>
          </div>
        )}
      </section>

      {/* Add form */}
      {showForm ? (
        <section className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-6">
          <div className="mb-5 flex items-center justify-between">
            <Heading level={3}>Conectar Mercado Pago</Heading>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setShowForm(false);
                resetForm();
              }}
            >
              Cancelar
            </Button>
          </div>
          <p className="mb-6 text-[13px] leading-[1.55] text-[var(--color-fg-muted)]">
            Pegue suas credenciais em{' '}
            <a
              href="https://www.mercadopago.com.br/developers/panel/app"
              target="_blank"
              rel="noopener noreferrer"
              className="font-medium text-[var(--color-brand-600)] underline"
            >
              mercadopago.com.br/developers
            </a>
            . O Access Token começa com <code>APP_USR-</code> em produção ou{' '}
            <code>TEST-</code> em sandbox.
          </p>
          <form onSubmit={onSubmit} className="grid grid-cols-1 gap-5 sm:grid-cols-2">
            <FormField label="Apelido" className="sm:col-span-2">
              <input
                type="text"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="Mercado Pago"
                className={inputClass}
              />
            </FormField>
            <FormField label="Access Token" className="sm:col-span-2">
              <input
                type="password"
                value={accessToken}
                onChange={(e) => setAccessToken(e.target.value)}
                placeholder="APP_USR-... ou TEST-..."
                className={inputClass}
                autoComplete="off"
                required
              />
            </FormField>
            <FormField label="Public Key" className="sm:col-span-2">
              <input
                type="text"
                value={publicKey}
                onChange={(e) => setPublicKey(e.target.value)}
                placeholder="APP_USR-... ou TEST-..."
                className={inputClass}
                autoComplete="off"
                required
              />
            </FormField>
            <FormField
              label="Webhook Secret"
              hint="Opcional agora; obrigatório para validar webhooks de produção."
              className="sm:col-span-2"
            >
              <input
                type="password"
                value={webhookSecret}
                onChange={(e) => setWebhookSecret(e.target.value)}
                placeholder="Segredo HMAC do painel MP"
                className={inputClass}
                autoComplete="off"
              />
            </FormField>
            <label className="sm:col-span-2 flex items-center gap-3 text-[14px] text-[var(--color-fg-muted)]">
              <input
                type="checkbox"
                checked={isSandbox}
                onChange={(e) => setIsSandbox(e.target.checked)}
                className="size-4 accent-[var(--color-brand-500)]"
              />
              Ambiente sandbox (use chaves de teste para validar antes de ir pra produção)
            </label>

            {upsert.error ? (
              <p className="sm:col-span-2 rounded-xl border border-[var(--color-danger-bg)] bg-[var(--color-danger-bg)] px-4 py-3 text-[13px] text-[var(--color-danger)]">
                {upsert.error.message}
              </p>
            ) : null}

            <div className="sm:col-span-2 flex items-center gap-3 pt-2">
              <Button type="submit" disabled={upsert.isPending}>
                {upsert.isPending ? 'Validando…' : 'Salvar e validar'}
              </Button>
              <p className="text-[12px] text-[var(--color-fg-subtle)]">
                A plataforma chama o Mercado Pago antes de salvar — se a chave estiver errada, você
                descobre agora.
              </p>
            </div>
          </form>
        </section>
      ) : null}
    </div>
  );
}

const inputClass =
  'w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] ' +
  'px-4 py-3 text-[15px] text-[var(--color-fg)] outline-none transition ' +
  'placeholder:text-[var(--color-fg-subtle)] ' +
  'hover:border-[var(--color-border-strong)] ' +
  'focus:border-[var(--color-brand-500)] focus:ring-4 focus:ring-[var(--color-brand-500)]/15';

function FormField({
  label,
  hint,
  className,
  children,
}: {
  label: string;
  hint?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <label className={`flex flex-col gap-2 ${className ?? ''}`}>
      <span className="text-[13px] font-medium text-[var(--color-fg-muted)]">{label}</span>
      {children}
      {hint ? <span className="text-[12px] text-[var(--color-fg-subtle)]">{hint}</span> : null}
    </label>
  );
}
