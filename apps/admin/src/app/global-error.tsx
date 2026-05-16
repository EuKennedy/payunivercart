'use client';

/**
 * App Router global-error boundary.
 *
 * Without an explicit file here Next 16 falls back to an internal
 * `/_global-error` page that, when statically prerendered alongside our
 * client tree, blows up with `TypeError: Cannot read properties of null
 * (reading 'useContext')` — a known interaction with React 19's stricter
 * context resolution during SSG. Defining the boundary ourselves bypasses
 * that fallback and gives us a real branded error page in the bargain.
 *
 * Must live at `app/global-error.tsx` (sibling to `layout.tsx`).
 * Must render its own `<html>` and `<body>` — it replaces the root layout
 * when invoked.
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
            Ocorreu um erro inesperado no admin. Nossa equipe foi notificada.
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
