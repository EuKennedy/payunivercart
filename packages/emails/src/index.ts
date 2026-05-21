import { Resend } from 'resend';

/**
 * Minimal Resend wrapper. We send three transactional emails today:
 *   1. OTP code   — used by Better-Auth's `emailOTP` plugin during sign-in.
 *   2. Order paid — sent right after the gateway webhook flips a
 *                   transaction to `paid` so the buyer has a receipt
 *                   + access link.
 *   3. Cart recovery — drip messages from the worker when an order
 *                      stalls in `pending_payment` (mirror of the
 *                      WhatsApp cadence).
 *
 * Templates are inline plain-HTML on purpose — no React Email, no
 * MJML. Producer-facing transactionals don't need a designer surface;
 * a small SF-stack HTML block renders consistently across every
 * client and keeps the dependency tree tiny.
 *
 * When `RESEND_API_KEY` isn't set we fall back to a structured stdout
 * log (same envelope auth previously emitted) so local dev + sandbox
 * deploys still work end-to-end.
 */

export interface EmailSenderConfig {
  /** `RESEND_API_KEY` from env. Empty → log mode. */
  apiKey: string | null;
  /** Verified `from` address. e.g. "payunivercart <no-reply@payunivercart.com>". */
  from: string;
  /** Optional reply-to override. Falls back to `from`. */
  replyTo?: string;
}

export interface EmailSender {
  sendOtp(input: { to: string; code: string; brand?: string }): Promise<void>;
  sendOrderPaid(input: {
    to: string;
    customerName: string;
    publicReference: string;
    productName: string;
    amountFormatted: string;
    brand?: string;
    /** Optional post-purchase delivery info from the product row. */
    deliveryUrl?: string | null;
    deliveryInstructions?: string | null;
  }): Promise<void>;
  sendCartRecovery(input: {
    to: string;
    customerName: string;
    publicReference: string;
    productName: string;
    amountFormatted: string;
    /** Producer-facing checkout link the buyer should return to. */
    resumeUrl: string;
    brand?: string;
  }): Promise<void>;
  /**
   * Univercart Connect — magic-link email sent the moment a buyer's
   * subscription is provisioned in a partner SaaS. Contains the
   * partner brand, product name, and the JWT setup link (valid 72h).
   */
  sendEntitlementGranted(input: {
    to: string;
    customerName: string;
    partnerName: string;
    productName: string;
    magicLinkUrl: string;
  }): Promise<void>;
}

export function createEmailSender(config: EmailSenderConfig): EmailSender {
  const live = config.apiKey ? new Resend(config.apiKey) : null;
  const replyTo = config.replyTo ?? undefined;

  async function send(input: { to: string; subject: string; html: string; text: string }) {
    if (!live) {
      // Operator-readable log when no Resend key is configured.
      process.stdout.write(
        `${JSON.stringify({
          level: 'info',
          event: 'email.skip.noKey',
          to: input.to,
          subject: input.subject,
        })}\n`,
      );
      return;
    }
    const result = await live.emails.send({
      from: config.from,
      to: input.to,
      subject: input.subject,
      html: input.html,
      text: input.text,
      replyTo,
    });
    if (result.error) {
      throw new Error(`Resend rejected: ${result.error.message ?? 'unknown'}`);
    }
  }

  return {
    async sendOtp({ to, code, brand }) {
      const product = brand ?? 'payunivercart';
      await send({
        to,
        subject: `${product} — código de acesso ${code}`,
        text: `Seu código: ${code}\n\nVálido por 10 minutos. Se não foi você, ignore este email.`,
        html: shell(
          product,
          `
            <h1 style="margin:0 0 8px 0;font-size:24px;letter-spacing:-0.01em;">Seu código de acesso</h1>
            <p style="margin:0 0 24px 0;color:#515154;font-size:14px;">Use o código abaixo no app pra continuar.</p>
            <p style="margin:0;font-family:'SF Mono',Menlo,monospace;font-size:32px;letter-spacing:8px;font-weight:700;color:#16a34a;">${escapeHtml(
              code,
            )}</p>
            <p style="margin:24px 0 0 0;color:#86868b;font-size:12px;">Válido por 10 minutos. Se não foi você, ignore este email.</p>
          `,
        ),
      });
    },

    async sendOrderPaid({
      to,
      customerName,
      publicReference,
      productName,
      amountFormatted,
      brand,
      deliveryUrl,
      deliveryInstructions,
    }) {
      const product = brand ?? 'payunivercart';
      const firstName = customerName.split(/\s+/)[0] ?? customerName;
      const hasDelivery = !!(deliveryUrl || deliveryInstructions);
      const deliveryText = hasDelivery
        ? `\n\nAcesso:\n${deliveryUrl ?? ''}${deliveryInstructions ? `\n${deliveryInstructions}` : ''}`
        : '';
      const deliveryHtml = hasDelivery
        ? `
            <div style="margin:24px 0;padding:20px;border-radius:12px;background:#ecfdf5;border:1px solid #a7f3d0;">
              <p style="margin:0 0 8px 0;font-weight:600;color:#065f46;font-size:13px;letter-spacing:0.04em;text-transform:uppercase;">Seu acesso</p>
              ${
                deliveryUrl
                  ? `<p style="margin:0 0 12px 0;"><a href="${escapeAttr(deliveryUrl)}" style="display:inline-block;background:#16a34a;color:#fff;padding:10px 18px;border-radius:10px;font-size:14px;font-weight:600;text-decoration:none;">Abrir agora</a></p>
                     <p style="margin:0 0 12px 0;font-family:'SF Mono',Menlo,monospace;font-size:12px;color:#065f46;word-break:break-all;">${escapeHtml(deliveryUrl)}</p>`
                  : ''
              }
              ${
                deliveryInstructions
                  ? `<p style="margin:0;color:#064e3b;font-size:13px;line-height:1.55;white-space:pre-wrap;">${escapeHtml(deliveryInstructions)}</p>`
                  : ''
              }
            </div>
          `
        : '';
      await send({
        to,
        subject: `${product} — pagamento confirmado · ${publicReference}`,
        text: `Oi ${firstName},\n\nRecebemos o pagamento do seu pedido ${publicReference} (${productName}, ${amountFormatted}).${deliveryText}\n\nObrigado!`,
        html: shell(
          product,
          `
            <h1 style="margin:0 0 8px 0;font-size:24px;letter-spacing:-0.01em;">Pagamento confirmado ✓</h1>
            <p style="margin:0 0 16px 0;color:#515154;font-size:14px;">Oi ${escapeHtml(firstName)}, recebemos o pagamento do seu pedido.</p>
            <table role="presentation" style="margin:24px 0;width:100%;border:1px solid #e5e5ea;border-radius:12px;padding:16px;background:#fbfbfd;">
              <tr><td style="color:#86868b;font-size:12px;padding:4px 0;">Pedido</td><td style="text-align:right;font-family:'SF Mono',Menlo,monospace;font-size:13px;">${escapeHtml(publicReference)}</td></tr>
              <tr><td style="color:#86868b;font-size:12px;padding:4px 0;">Produto</td><td style="text-align:right;font-size:13px;">${escapeHtml(productName)}</td></tr>
              <tr><td style="color:#86868b;font-size:12px;padding:4px 0;">Valor</td><td style="text-align:right;font-size:13px;font-weight:600;">${escapeHtml(amountFormatted)}</td></tr>
            </table>
            ${deliveryHtml}
            <p style="margin:0;color:#86868b;font-size:12px;">Guarde este email — use o número do pedido se precisar entrar em contato com o produtor.</p>
          `,
        ),
      });
    },

    async sendCartRecovery({
      to,
      customerName,
      publicReference,
      productName,
      amountFormatted,
      resumeUrl,
      brand,
    }) {
      const product = brand ?? 'payunivercart';
      const firstName = customerName.split(/\s+/)[0] ?? customerName;
      await send({
        to,
        subject: `${product} — seu Pix de ${productName} ainda está reservado`,
        text: `Oi ${firstName}, faltou o pagamento de ${productName} (${amountFormatted}). Finalize aqui: ${resumeUrl}\nPedido ${publicReference}.`,
        html: shell(
          product,
          `
            <h1 style="margin:0 0 8px 0;font-size:24px;letter-spacing:-0.01em;">Faltou só o pagamento.</h1>
            <p style="margin:0 0 16px 0;color:#515154;font-size:14px;">Oi ${escapeHtml(firstName)}, separamos sua vaga em <strong>${escapeHtml(productName)}</strong> mas o Pix ainda não chegou. Total <strong>${escapeHtml(amountFormatted)}</strong>.</p>
            <p style="margin:24px 0;">
              <a href="${escapeAttr(resumeUrl)}" style="display:inline-block;background:#16a34a;color:#ffffff;font-weight:600;font-size:14px;padding:12px 20px;border-radius:12px;text-decoration:none;">Concluir pagamento</a>
            </p>
            <p style="margin:0;color:#86868b;font-size:12px;">Pedido ${escapeHtml(publicReference)}. Esse link expira em algumas horas.</p>
          `,
        ),
      });
    },

    async sendEntitlementGranted({ to, customerName, partnerName, productName, magicLinkUrl }) {
      const firstName = customerName.split(/\s+/)[0] ?? customerName;
      await send({
        to,
        subject: `Seu acesso ao ${partnerName} está pronto`,
        text: `Oi ${firstName}!\n\nSua assinatura de "${productName}" foi confirmada e seu acesso ao ${partnerName} já está liberado.\n\nDefina sua senha pelo link:\n${magicLinkUrl}\n\nO link expira em 72 horas. Se precisar, peça um novo ao produtor.`,
        html: shell(
          partnerName,
          `
            <h1 style="margin:0 0 8px 0;font-size:24px;letter-spacing:-0.01em;">Acesso liberado ao ${escapeHtml(partnerName)} 🎉</h1>
            <p style="margin:0 0 16px 0;color:#515154;font-size:14px;">Oi ${escapeHtml(firstName)}! Sua assinatura de <strong>${escapeHtml(productName)}</strong> foi confirmada.</p>
            <p style="margin:24px 0;">
              <a href="${escapeAttr(magicLinkUrl)}" style="display:inline-block;background:#16a34a;color:#ffffff;font-weight:600;font-size:14px;padding:12px 20px;border-radius:12px;text-decoration:none;">Definir senha e acessar</a>
            </p>
            <p style="margin:0;color:#86868b;font-size:12px;">Esse link expira em 72 horas. Se precisar de um novo, peça pro produtor.</p>
          `,
        ),
      });
    },
  };
}

/**
 * Minimal HTML shell shared by every transactional. Keeps the
 * presentation consistent without an entire React Email pipeline.
 */
function shell(brand: string, body: string): string {
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"/></head><body style="margin:0;padding:24px;background:#f5f5f7;font-family:-apple-system,BlinkMacSystemFont,'SF Pro Text','Helvetica Neue',Arial,sans-serif;color:#1d1d1f;">
  <table role="presentation" style="margin:0 auto;width:100%;max-width:560px;background:#ffffff;border-radius:16px;padding:32px;">
    <tr><td>
      <p style="margin:0 0 24px 0;font-size:13px;letter-spacing:0.12em;text-transform:uppercase;color:#86868b;">${escapeHtml(
        brand,
      )}</p>
      ${body}
    </td></tr>
  </table>
  <p style="margin:24px auto 0 auto;text-align:center;color:#86868b;font-size:11px;max-width:560px;">Você está recebendo este email porque iniciou uma compra ou cadastro em ${escapeHtml(brand)}. Se não foi você, ignore esta mensagem.</p>
</body></html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttr(s: string): string {
  return escapeHtml(s);
}
