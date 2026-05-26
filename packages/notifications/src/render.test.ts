import { describe, expect, it } from 'vitest';
import { renderTemplate } from './render';

/**
 * Renderer-only tests — no DB. Covers the placeholder grammar
 * (`{var}`), the missing-variable surface, and the no-escape contract
 * (callers handle channel-specific escaping themselves).
 */
describe('renderTemplate', () => {
  it('replaces simple placeholders in body and subject', () => {
    const out = renderTemplate(
      { subject: 'Hello {nome}', body: 'Pedido {codigo} confirmado.' },
      { nome: 'Diego', codigo: 'ORD-42' },
    );
    expect(out.subject).toBe('Hello Diego');
    expect(out.body).toBe('Pedido ORD-42 confirmado.');
    expect(out.missingVariables).toEqual([]);
  });

  it('leaves null subject as null', () => {
    const out = renderTemplate({ subject: null, body: 'Oi {nome}' }, { nome: 'Diego' });
    expect(out.subject).toBeNull();
    expect(out.body).toBe('Oi Diego');
  });

  it('keeps unknown placeholders intact and reports them as missing', () => {
    const out = renderTemplate(
      { subject: null, body: 'Oi {nome}, código {codigo}' },
      { nome: 'Diego' },
    );
    expect(out.body).toBe('Oi Diego, código {codigo}');
    expect(out.missingVariables).toEqual(['codigo']);
  });

  it('treats empty string and undefined as missing', () => {
    const out = renderTemplate(
      { subject: null, body: '{a} {b} {c}' },
      { a: '', b: undefined, c: 'ok' },
    );
    expect(out.body).toBe('{a} {b} ok');
    expect(out.missingVariables).toEqual(['a', 'b']);
  });

  it('treats null explicitly as missing', () => {
    const out = renderTemplate({ subject: null, body: '{x}' }, { x: null });
    expect(out.body).toBe('{x}');
    expect(out.missingVariables).toEqual(['x']);
  });

  it('coerces number values to their string form', () => {
    const out = renderTemplate({ subject: null, body: 'Total: {n}' }, { n: 9990 });
    expect(out.body).toBe('Total: 9990');
  });

  it('does not double-replace nested placeholders', () => {
    // {a} → "{b}", and {b} stays literal — second pass shouldn't run.
    const out = renderTemplate({ subject: null, body: 'value is {a}' }, { a: '{b}' });
    expect(out.body).toBe('value is {b}');
    expect(out.missingVariables).toEqual([]);
  });

  it('does not escape HTML characters in values', () => {
    const out = renderTemplate(
      { subject: null, body: 'Cliente: {nome}' },
      { nome: 'Diego & Cia <Ltda>' },
    );
    expect(out.body).toBe('Cliente: Diego & Cia <Ltda>');
  });

  it('ignores placeholders with invalid characters', () => {
    const out = renderTemplate(
      { subject: null, body: 'pass through {nope-dash} but render {ok}' },
      { ok: 'yes' },
    );
    expect(out.body).toBe('pass through {nope-dash} but render yes');
    expect(out.missingVariables).toEqual([]);
  });

  it('deduplicates missing vars across subject + body', () => {
    const out = renderTemplate(
      { subject: 'Oi {nome}', body: 'Cliente {nome} fez pedido {codigo}' },
      {},
    );
    expect(out.missingVariables).toEqual(['codigo', 'nome']);
  });

  it('reports the missing var key exactly so callers can guard dispatch', () => {
    // Defensive: the dispatcher relies on `missingVariables.length === 0`
    // to decide whether to ship the rendered body or fall back. Lock the
    // empty-list shape so a future refactor doesn't accidentally return
    // `[null]` or include duplicates.
    const out = renderTemplate({ subject: null, body: '{a}{a}{b}' }, { a: 'AA' });
    expect(out.body).toBe('AAAA{b}');
    expect(out.missingVariables).toEqual(['b']);
  });
});
