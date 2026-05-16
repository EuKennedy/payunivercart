'use client';

/**
 * App Router global-error boundary. See apps/admin/src/app/global-error.tsx
 * for the rationale — same Next 16 / React 19 prerender quirk.
 */
export default function GlobalError({
  error: _error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="pt-BR">
      <body
        style={{
          margin: 0,
          minHeight: '100vh',
          display: 'grid',
          placeItems: 'center',
          background: '#0a0a0a',
          color: '#f5f5f5',
          fontFamily:
            "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
        }}
      >
        <div style={{ textAlign: 'center', maxWidth: 480, padding: '0 24px' }}>
          <h1 style={{ fontSize: 28, fontWeight: 600, marginBottom: 12 }}>
            Algo deu errado
          </h1>
          <p style={{ opacity: 0.7, marginBottom: 24, lineHeight: 1.5 }}>
            Ocorreu um erro inesperado. Nossa equipe foi notificada.
          </p>
          <button
            type="button"
            onClick={reset}
            style={{
              background: '#fff',
              color: '#0a0a0a',
              border: 'none',
              borderRadius: 8,
              padding: '10px 20px',
              fontSize: 14,
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            Tentar novamente
          </button>
        </div>
      </body>
    </html>
  );
}
