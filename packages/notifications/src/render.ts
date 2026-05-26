/**
 * Pure template renderer. Replaces `{var}` placeholders with values
 * from a map. Unknown keys are left as literal `{key}` so producers
 * notice typos in their copy (silent omission would hide bugs).
 *
 * No HTML escaping here — callers decide whether the rendered string
 * is going into plain text (whatsapp / sms) or wrapped in an HTML
 * shell (email). Escaping at the wrong layer caused bugs in earlier
 * iterations where `&` from a customer name double-encoded into the
 * subject line.
 *
 * Exported separately from the resolver so unit tests can hit it
 * without spinning up a database.
 */

export interface RenderedTemplate {
  subject: string | null;
  body: string;
  /** Variables that appeared in the template but were not supplied —
   *  surfaced so the API can warn the operator (and so the editor's
   *  preview pane can flag them). */
  missingVariables: string[];
}

export interface TemplateInput {
  subject: string | null;
  body: string;
}

const PLACEHOLDER = /\{([a-zA-Z0-9_]+)\}/g;

export function renderTemplate(
  template: TemplateInput,
  vars: Record<string, string | number | null | undefined>,
): RenderedTemplate {
  const missing = new Set<string>();
  const replace = (input: string): string =>
    input.replace(PLACEHOLDER, (match, name: string) => {
      const value = vars[name];
      if (value == null || value === '') {
        missing.add(name);
        return match;
      }
      return String(value);
    });

  return {
    subject: template.subject == null ? null : replace(template.subject),
    body: replace(template.body),
    missingVariables: Array.from(missing).sort(),
  };
}
