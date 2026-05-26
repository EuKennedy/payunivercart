'use client';

import type { AppRouter } from '@payunivercart/api/routers';
import type { inferRouterOutputs } from '@trpc/server';
import { AnimatePresence, motion } from 'framer-motion';
import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Button, Heading } from '../../../../components/ui';
import { trpc } from '../../../../lib/trpc';

/**
 * Notification template editor.
 *
 * Three-pane layout per event card:
 *   - Left column: editable subject (email) + body textarea + variable
 *     chips. Producer-facing copy is plain text; the platform wraps
 *     it in the brand shell on dispatch.
 *   - Right column: live preview rendered with sample variable values
 *     (defined in `packages/notifications/defaults.ts`). Updates as
 *     the producer types so they can spot a typo before saving.
 *   - Top-right action row: tab switcher (Email / WhatsApp) + per-card
 *     "Resetar" link that drops the override and falls back to the
 *     platform default on the next dispatch.
 *
 * State strategy: the catalog query is the single source of truth.
 * Edits live in a local `drafts` map keyed by `${eventKey}|${channel}`
 * — saving sends an upsert + invalidates the catalog so the next
 * render reads from server again. We don't optimistic-update because
 * the editor is low-traffic and the upsert is a single round-trip.
 */

const EASE = [0.16, 1, 0.3, 1] as const;

type RouterOutput = inferRouterOutputs<AppRouter>;
type EventCard = RouterOutput['notificationTemplates']['catalog'][number];
type Template = EventCard['templates'][number];
type Channel = 'email' | 'whatsapp';

const CHANNEL_LABELS: Record<Channel, string> = {
  email: 'Email',
  whatsapp: 'WhatsApp',
};

interface Draft {
  subject: string;
  body: string;
}

function keyOf(eventKey: string, channel: Channel): string {
  return `${eventKey}|${channel}`;
}

export default function NotificacoesPage() {
  const utils = trpc.useUtils();
  const catalog = trpc.notificationTemplates.catalog.useQuery();

  const [activeChannel, setActiveChannel] = useState<Channel>('email');
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});

  const upsert = trpc.notificationTemplates.upsert.useMutation({
    onSuccess: (_data, variables) => {
      const k = keyOf(variables.eventKey, variables.channel);
      setDrafts((d) => {
        const next = { ...d };
        delete next[k];
        return next;
      });
      utils.notificationTemplates.catalog.invalidate();
      toast.success('Template salvo.');
    },
    onError: (err) => toast.error(err.message),
  });

  const reset = trpc.notificationTemplates.reset.useMutation({
    onSuccess: (_data, variables) => {
      const k = keyOf(variables.eventKey, variables.channel);
      setDrafts((d) => {
        const next = { ...d };
        delete next[k];
        return next;
      });
      utils.notificationTemplates.catalog.invalidate();
      toast.success('Template restaurado pro padrão da plataforma.');
    },
    onError: (err) => toast.error(err.message),
  });

  function patchDraft(eventKey: string, channel: Channel, patch: Partial<Draft>) {
    setDrafts((d) => {
      const k = keyOf(eventKey, channel);
      const current: Draft = d[k] ?? { subject: '', body: '' };
      return { ...d, [k]: { ...current, ...patch } };
    });
  }

  function effective(template: Template): Draft {
    const k = keyOf(template.eventKey, template.channel);
    if (drafts[k]) return drafts[k];
    return { subject: template.subject ?? '', body: template.body };
  }

  function isDirty(template: Template): boolean {
    return drafts[keyOf(template.eventKey, template.channel)] !== undefined;
  }

  if (catalog.isPending) {
    return (
      <div className="flex flex-col gap-4">
        {Array.from({ length: 3 }).map((_, i) => (
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: skeleton.
            key={i}
            className="h-64 animate-pulse rounded-2xl bg-[var(--color-surface-muted)]"
          />
        ))}
      </div>
    );
  }

  if (!catalog.data) {
    return (
      <p className="text-[14px] text-[var(--color-danger)]">Falha ao carregar os templates.</p>
    );
  }

  const events = catalog.data;
  // Filter events that have at least one template for the active channel.
  const visibleEvents = events.filter((e) => e.templates.some((t) => t.channel === activeChannel));

  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.28, ease: EASE }}
      className="flex flex-col gap-8"
    >
      <header className="flex flex-col gap-3">
        <Heading level={2}>Notificações automáticas</Heading>
        <p className="max-w-3xl text-[14px] text-[var(--color-fg-muted)] leading-[1.55]">
          Personalize o que seus clientes recebem por email e WhatsApp em cada evento. Cada template
          aceita variáveis no formato{' '}
          <code className="rounded bg-[var(--color-surface-muted)] px-1.5 py-0.5 font-mono text-[12px]">
            {'{nome}'}
          </code>{' '}
          — clique numa variável pra inserir no cursor. Resetando o template, a mensagem volta ao
          padrão da Univercart.
        </p>
      </header>

      {/* Channel tabs */}
      <div className="flex items-center gap-2 self-start rounded-full border border-[var(--color-border)] bg-[var(--color-surface)] p-1">
        {(['email', 'whatsapp'] as const).map((channel) => {
          const active = activeChannel === channel;
          return (
            <button
              key={channel}
              type="button"
              onClick={() => setActiveChannel(channel)}
              className={`cursor-pointer rounded-full px-4 py-1.5 font-medium text-[13px] transition ${
                active
                  ? 'bg-[var(--color-fg)] text-[var(--color-fg-inverse)]'
                  : 'text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]'
              }`}
            >
              {CHANNEL_LABELS[channel]}
            </button>
          );
        })}
      </div>

      <div className="flex flex-col gap-5">
        {visibleEvents.map((event) => {
          const template = event.templates.find((t) => t.channel === activeChannel);
          if (!template) return null;
          const draft = effective(template);
          const dirty = isDirty(template);
          return (
            <TemplateCard
              key={`${event.key}-${activeChannel}`}
              event={event}
              template={template}
              draft={draft}
              dirty={dirty}
              onSubjectChange={(value) => patchDraft(event.key, activeChannel, { subject: value })}
              onBodyChange={(value) => patchDraft(event.key, activeChannel, { body: value })}
              onSave={() => {
                upsert.mutate({
                  eventKey: event.key,
                  channel: activeChannel,
                  subject: activeChannel === 'email' ? draft.subject.trim() : null,
                  body: draft.body.trim(),
                  isActive: true,
                });
              }}
              onReset={() => {
                reset.mutate({ eventKey: event.key, channel: activeChannel });
              }}
              busy={upsert.isPending || reset.isPending}
            />
          );
        })}
      </div>
    </motion.div>
  );
}

// ─── Card ────────────────────────────────────────────────────────────────────

function TemplateCard({
  event,
  template,
  draft,
  dirty,
  onSubjectChange,
  onBodyChange,
  onSave,
  onReset,
  busy,
}: {
  event: EventCard;
  template: Template;
  draft: Draft;
  dirty: boolean;
  onSubjectChange: (value: string) => void;
  onBodyChange: (value: string) => void;
  onSave: () => void;
  onReset: () => void;
  busy: boolean;
}) {
  const bodyRef = useRef<HTMLTextAreaElement | null>(null);
  const subjectRef = useRef<HTMLInputElement | null>(null);
  const [focused, setFocused] = useState<'subject' | 'body'>('body');

  // Save button is disabled when the form is incomplete — matches the
  // server-side superRefine so the producer doesn't get a 400 after
  // clicking. Email needs subject + body; whatsapp only body.
  const subjectOk = template.channel !== 'email' || draft.subject.trim().length > 0;
  const bodyOk = draft.body.trim().length > 0;
  const saveable = subjectOk && bodyOk;

  function insertVariable(varKey: string) {
    const token = `{${varKey}}`;
    if (template.channel === 'email' && focused === 'subject' && subjectRef.current) {
      const el = subjectRef.current;
      const start = el.selectionStart ?? draft.subject.length;
      const end = el.selectionEnd ?? draft.subject.length;
      const next = draft.subject.slice(0, start) + token + draft.subject.slice(end);
      onSubjectChange(next);
      requestAnimationFrame(() => {
        el.focus();
        const pos = start + token.length;
        el.setSelectionRange(pos, pos);
      });
      return;
    }
    if (bodyRef.current) {
      const el = bodyRef.current;
      const start = el.selectionStart ?? draft.body.length;
      const end = el.selectionEnd ?? draft.body.length;
      const next = draft.body.slice(0, start) + token + draft.body.slice(end);
      onBodyChange(next);
      requestAnimationFrame(() => {
        el.focus();
        const pos = start + token.length;
        el.setSelectionRange(pos, pos);
      });
    }
  }

  return (
    <motion.article
      layout
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.24, ease: EASE }}
      className="overflow-hidden rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)]"
    >
      <header className="flex flex-wrap items-start justify-between gap-3 border-[var(--color-border)] border-b px-6 py-5">
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2">
            <h3 className="font-semibold text-[15px] text-[var(--color-fg)]">{event.title}</h3>
            <StatusChip isCustom={template.isCustom} />
          </div>
          <p className="text-[12px] text-[var(--color-fg-muted)]">{event.description}</p>
        </div>
        <div className="flex items-center gap-2">
          {template.isCustom ? (
            <button
              type="button"
              onClick={onReset}
              disabled={busy}
              className="cursor-pointer rounded-full border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 font-medium text-[12px] text-[var(--color-fg-muted)] transition hover:border-[var(--color-border-strong)] hover:text-[var(--color-fg)] disabled:cursor-not-allowed disabled:opacity-50"
            >
              Resetar padrão
            </button>
          ) : null}
          <Button onClick={onSave} disabled={!dirty || busy || !saveable} size="sm">
            {dirty ? 'Salvar template' : 'Sem alterações'}
          </Button>
        </div>
      </header>

      <div className="grid grid-cols-1 gap-0 lg:grid-cols-2">
        {/* Editor */}
        <div className="flex flex-col gap-4 border-[var(--color-border)] border-b p-6 lg:border-r lg:border-b-0">
          {template.channel === 'email' ? (
            <label className="flex flex-col gap-2">
              <span className="font-medium text-[11px] text-[var(--color-fg-subtle)] uppercase tracking-wider">
                Assunto
              </span>
              <input
                ref={subjectRef}
                value={draft.subject}
                onFocus={() => setFocused('subject')}
                onChange={(e) => onSubjectChange(e.target.value)}
                maxLength={180}
                className="w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3 text-[14px] text-[var(--color-fg)] outline-none transition hover:border-[var(--color-border-strong)] focus:border-[var(--color-brand-500)] focus:ring-4 focus:ring-[var(--color-brand-500)]/15"
              />
            </label>
          ) : null}
          <label className="flex flex-col gap-2">
            <span className="font-medium text-[11px] text-[var(--color-fg-subtle)] uppercase tracking-wider">
              Mensagem
            </span>
            <textarea
              ref={bodyRef}
              value={draft.body}
              onFocus={() => setFocused('body')}
              onChange={(e) => onBodyChange(e.target.value)}
              rows={template.channel === 'email' ? 12 : 8}
              maxLength={8000}
              className="w-full resize-y rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3 font-mono text-[13px] text-[var(--color-fg)] leading-[1.55] outline-none transition hover:border-[var(--color-border-strong)] focus:border-[var(--color-brand-500)] focus:ring-4 focus:ring-[var(--color-brand-500)]/15"
            />
          </label>
          <div className="flex flex-col gap-2">
            <span className="font-medium text-[11px] text-[var(--color-fg-subtle)] uppercase tracking-wider">
              Variáveis
            </span>
            <div className="flex flex-wrap gap-1.5">
              {event.variables.map((v) => (
                <button
                  key={v.key}
                  type="button"
                  onClick={() => insertVariable(v.key)}
                  title={v.label}
                  className="cursor-pointer rounded-full border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-1 font-mono text-[11px] text-[var(--color-fg-muted)] transition hover:border-[var(--color-brand-500)] hover:text-[var(--color-brand-700)]"
                >
                  {`{${v.key}}`}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Preview */}
        <LivePreview event={event} template={template} draft={draft} />
      </div>
    </motion.article>
  );
}

function StatusChip({ isCustom }: { isCustom: boolean }) {
  return (
    <span
      className={`rounded-full px-2 py-0.5 font-semibold text-[9px] uppercase tracking-wider ${
        isCustom
          ? 'bg-[var(--color-brand-50)] text-[var(--color-brand-700)]'
          : 'bg-[var(--color-surface-muted)] text-[var(--color-fg-muted)]'
      }`}
    >
      {isCustom ? 'Personalizado' : 'Padrão'}
    </span>
  );
}

function LivePreview({
  event,
  template,
  draft,
}: {
  event: EventCard;
  template: Template;
  draft: Draft;
}) {
  // Debounce preview requests so each keystroke doesn't fire a query.
  const [pendingDraft, setPendingDraft] = useState(draft);
  useEffect(() => {
    const id = setTimeout(() => setPendingDraft(draft), 220);
    return () => clearTimeout(id);
  }, [draft]);

  const preview = trpc.notificationTemplates.preview.useQuery(
    {
      eventKey: event.key,
      channel: template.channel,
      draft: {
        subject: template.channel === 'email' ? pendingDraft.subject : null,
        body: pendingDraft.body,
      },
    },
    { staleTime: Number.POSITIVE_INFINITY },
  );

  const previewVars = useMemo(
    () =>
      event.variables.map((v) => ({
        key: v.key,
        sample: v.sample,
      })),
    [event.variables],
  );

  return (
    <div className="flex flex-col gap-4 bg-[var(--color-surface-muted)]/30 p-6">
      <div className="flex items-center justify-between">
        <span className="font-medium text-[11px] text-[var(--color-fg-subtle)] uppercase tracking-wider">
          Pré-visualização
        </span>
        <AnimatePresence>
          {preview.data?.missingVariables.length ? (
            <motion.span
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="rounded-full bg-[var(--color-warning-bg)] px-2 py-0.5 font-semibold text-[10px] text-[var(--color-warning)] uppercase tracking-wider"
            >
              {preview.data.missingVariables.length} variável faltando
            </motion.span>
          ) : null}
        </AnimatePresence>
      </div>

      <div className="flex flex-col gap-3 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
        {template.channel === 'email' && preview.data?.subject ? (
          <div className="flex flex-col gap-1">
            <span className="font-medium text-[10px] text-[var(--color-fg-subtle)] uppercase tracking-wider">
              Assunto
            </span>
            <span className="font-semibold text-[14px] text-[var(--color-fg)]">
              {preview.data.subject}
            </span>
          </div>
        ) : null}
        <div className="flex flex-col gap-1">
          <span className="font-medium text-[10px] text-[var(--color-fg-subtle)] uppercase tracking-wider">
            {template.channel === 'email' ? 'Corpo do email' : 'Mensagem WhatsApp'}
          </span>
          <p className="whitespace-pre-line text-[13px] text-[var(--color-fg)] leading-[1.6]">
            {preview.data?.body ?? draft.body}
          </p>
        </div>
      </div>

      <div className="flex flex-col gap-2 rounded-xl bg-[var(--color-surface)] p-4">
        <span className="font-medium text-[10px] text-[var(--color-fg-subtle)] uppercase tracking-wider">
          Valores de exemplo
        </span>
        <ul className="grid grid-cols-2 gap-1.5 text-[11px]">
          {previewVars.map((v) => (
            <li
              key={v.key}
              className="flex items-center gap-1.5 truncate text-[var(--color-fg-muted)]"
            >
              <code className="rounded bg-[var(--color-surface-muted)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--color-fg)]">
                {`{${v.key}}`}
              </code>
              <span className="truncate">{v.sample}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
