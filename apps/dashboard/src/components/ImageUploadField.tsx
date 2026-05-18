'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * File-input image picker that yields a `{ base64, mime }` payload the
 * tRPC mutations on the API consume directly. We deliberately keep the
 * payload as base64 (not multipart) because:
 *
 *   1. tRPC's wire format is JSON — multipart would require a side-
 *      channel POST and a second auth round-trip.
 *   2. The blobs we accept here cap at 2 MiB raw → ~2.7 MB base64,
 *      which is comfortably under Hono's default body limit and well
 *      below what'd justify the binary-channel complexity.
 *
 * Square enforcement is best-effort: we warn the producer when the
 * picked image isn't 1:1 and offer a "use anyway" escape hatch.
 * Hard-blocking would frustrate producers who want a wide hero;
 * a warning preserves intent while flagging the canonical aspect.
 */

const MAX_BYTES = 2 * 1024 * 1024;
const ACCEPTED_MIME = ['image/png', 'image/jpeg', 'image/webp'] as const;

export interface ImageUpload {
  base64: string;
  mime: string;
}

export function ImageUploadField({
  label,
  hint,
  /** URL to render in the empty-state preview when the producer
   * hasn't picked a new file yet. Used by the edit page to show the
   * current cover/logo so the producer can confirm before overwriting. */
  initialPreviewUrl,
  enforceSquare = true,
  onChange,
}: {
  label: string;
  hint?: string;
  initialPreviewUrl?: string | null;
  enforceSquare?: boolean;
  onChange: (next: ImageUpload | null) => void;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(initialPreviewUrl ?? null);
  const [aspectWarning, setAspectWarning] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Revoke object URLs we created so they don't leak across re-renders.
  useEffect(() => {
    return () => {
      if (previewUrl?.startsWith('blob:')) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  const handle = useCallback(
    async (file: File) => {
      setError(null);
      setAspectWarning(null);
      if (!ACCEPTED_MIME.includes(file.type as (typeof ACCEPTED_MIME)[number])) {
        setError('Use PNG, JPEG ou WEBP.');
        onChange(null);
        return;
      }
      if (file.size > MAX_BYTES) {
        setError(`Arquivo acima de ${MAX_BYTES / 1024 / 1024} MB.`);
        onChange(null);
        return;
      }
      const url = URL.createObjectURL(file);
      setPreviewUrl(url);

      // Inspect dimensions for the 1:1 warning. We don't fail on this —
      // square is the canonical product/logo aspect but the producer
      // owns the final call.
      if (enforceSquare) {
        try {
          const dims = await readDimensions(url);
          if (dims.w !== dims.h) {
            setAspectWarning(
              `Imagem ${dims.w}×${dims.h}. O ideal é 1:1 — vai aparecer cortada no checkout em algumas telas.`,
            );
          }
        } catch {
          // Dimension probe failure isn't fatal — proceed with the upload.
        }
      }

      const base64 = await readAsBase64(file);
      onChange({ base64, mime: file.type });
    },
    [enforceSquare, onChange],
  );

  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: hidden file input is the real control; the label wraps a custom drop zone.
    <label className="flex flex-col gap-2">
      <span className="font-medium text-[13px] text-[var(--color-fg-muted)]">{label}</span>
      <div className="flex items-center gap-4">
        <div
          className="relative grid size-28 place-items-center overflow-hidden rounded-xl border border-[var(--color-border)] border-dashed bg-[var(--color-surface-muted)]"
          aria-hidden
        >
          {previewUrl ? (
            <img src={previewUrl} alt="" className="size-full object-cover" />
          ) : (
            <span className="text-[11px] text-[var(--color-fg-subtle)]">1:1</span>
          )}
        </div>
        <div className="flex flex-1 flex-col gap-2">
          <input
            ref={inputRef}
            type="file"
            accept={ACCEPTED_MIME.join(',')}
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void handle(file);
            }}
          />
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-2 font-medium text-[13px] text-[var(--color-fg)] hover:border-[var(--color-border-strong)]"
            >
              {previewUrl ? 'Trocar imagem' : 'Selecionar imagem'}
            </button>
            {previewUrl ? (
              <button
                type="button"
                onClick={() => {
                  setPreviewUrl(null);
                  setAspectWarning(null);
                  setError(null);
                  if (inputRef.current) inputRef.current.value = '';
                  onChange(null);
                }}
                className="rounded-xl border border-transparent px-3 py-2 font-medium text-[13px] text-[var(--color-fg-subtle)] hover:bg-[var(--color-surface-muted)]"
              >
                Remover
              </button>
            ) : null}
          </div>
          {hint ? <span className="text-[12px] text-[var(--color-fg-subtle)]">{hint}</span> : null}
          {aspectWarning ? (
            <span className="text-[12px] text-[var(--color-warning)]">{aspectWarning}</span>
          ) : null}
          {error ? <span className="text-[12px] text-[var(--color-danger)]">{error}</span> : null}
        </div>
      </div>
    </label>
  );
}

function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== 'string') {
        reject(new Error('FileReader did not return a string'));
        return;
      }
      // result is `data:<mime>;base64,<payload>` — strip the prefix.
      const comma = result.indexOf(',');
      resolve(comma === -1 ? result : result.slice(comma + 1));
    };
    reader.readAsDataURL(file);
  });
}

function readDimensions(url: string): Promise<{ w: number; h: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
    img.onerror = () => reject(new Error('image load failed'));
    img.src = url;
  });
}
