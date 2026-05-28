'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';

/**
 * Banner LGPD de cookies. Persistência local no `localStorage`:
 *
 *   {
 *     version: '2026-05-28',
 *     choice: 'all' | 'essential',
 *     at: '<ISO>',
 *   }
 *
 * Sobe a versão (`CONSENT_VERSION`) quando a política de cookies muda
 * materialmente — o banner volta a aparecer pra todo mundo.
 *
 * Comportamento: banner gateia tracking opcional (analytics, marketing)
 * via flag global `window.__univercart_cookie_consent` que outras libs
 * podem inspecionar antes de mounted (TrackingScripts no checkout, por
 * exemplo, pode futuramente respeitar isso pra usuários logados).
 *
 * Cookies estritamente necessários (sessão, CSRF, idioma) NUNCA passam
 * pelo banner — base legal é legítimo interesse.
 */

const STORAGE_KEY = 'univercart_cookie_consent';
const CONSENT_VERSION = '2026-05-28';

interface ConsentRecord {
  version: string;
  choice: 'all' | 'essential';
  at: string;
}

declare global {
  interface Window {
    __univercart_cookie_consent?: ConsentRecord;
  }
}

export function CookieConsent() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (!raw) {
        setVisible(true);
        return;
      }
      const parsed = JSON.parse(raw) as ConsentRecord;
      if (parsed.version !== CONSENT_VERSION) {
        setVisible(true);
        return;
      }
      window.__univercart_cookie_consent = parsed;
    } catch {
      // Corrupted storage — surface banner so user re-consents.
      setVisible(true);
    }
  }, []);

  const persist = (choice: 'all' | 'essential') => {
    const record: ConsentRecord = {
      version: CONSENT_VERSION,
      choice,
      at: new Date().toISOString(),
    };
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(record));
      window.__univercart_cookie_consent = record;
    } catch {
      // localStorage blocked (incognito, quota) — best effort.
    }
    setVisible(false);
  };

  if (!visible) return null;

  return (
    <div
      // biome-ignore lint/a11y/useSemanticElements: <dialog> doesn't suit the bottom-fixed banner pattern; aria-modal=false keeps it non-blocking.
      role="dialog"
      aria-modal="false"
      aria-labelledby="cookie-consent-title"
      className="fixed right-4 bottom-4 left-4 z-50 mx-auto max-w-2xl rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)]/95 p-4 shadow-[0_24px_64px_-24px_rgba(0,0,0,0.35)] backdrop-blur-md sm:p-5"
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:gap-5">
        <div className="flex-1 flex-col gap-1.5">
          <h3
            id="cookie-consent-title"
            className="font-semibold text-[14px] text-[var(--color-fg)]"
          >
            Cookies e privacidade
          </h3>
          <p className="text-[12px] text-[var(--color-fg-muted)] leading-[1.55]">
            Usamos cookies essenciais para autenticação e segurança da sua sessão. Cookies
            analíticos (uso agregado, melhoria de produto) são opcionais.{' '}
            <Link href="/privacidade" className="text-[var(--color-brand-500)] hover:underline">
              Política de Privacidade
            </Link>
            .
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => persist('essential')}
            className="cursor-pointer rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 font-medium text-[12px] text-[var(--color-fg-muted)] transition hover:border-[var(--color-border-strong)] hover:text-[var(--color-fg)]"
          >
            Só essenciais
          </button>
          <button
            type="button"
            onClick={() => persist('all')}
            className="cursor-pointer rounded-lg bg-[var(--color-brand-500)] px-3 py-1.5 font-semibold text-[12px] text-white transition hover:bg-[var(--color-brand-600)]"
          >
            Aceitar todos
          </button>
        </div>
      </div>
    </div>
  );
}
