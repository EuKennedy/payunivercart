/**
 * Test email dispatch — usa o EmailSender real com Resend.
 *
 * Uso (local com .env carregado, ou produção rodando dentro do container api):
 *   pnpm tsx scripts/test-email.ts kennedy.rodrigues1104@gmail.com
 *
 * Se RESEND_API_KEY não estiver setado, EmailSender loga em stdout e
 * NÃO envia. O script imprime claramente qual caminho foi tomado.
 */
import 'dotenv/config';
import { createEmailSender } from '@payunivercart/emails';

async function main() {
  const to = process.argv[2];
  if (!to) {
    console.error('Uso: pnpm tsx scripts/test-email.ts <destinatario@email.com>');
    process.exit(1);
  }

  const apiKey = process.env.RESEND_API_KEY ?? null;
  const from = process.env.EMAIL_FROM ?? 'payunivercart <no-reply@payunivercart.com>';

  console.log('==========================================');
  console.log('TEST EMAIL DISPATCH');
  console.log('==========================================');
  console.log(
    `RESEND_API_KEY: ${apiKey ? `${apiKey.slice(0, 8)}…` : '(NOT SET → stdout fallback)'}`,
  );
  console.log(`EMAIL_FROM:     ${from}`);
  console.log(`TO:             ${to}`);
  console.log('==========================================\n');

  const sender = createEmailSender({ apiKey, from });

  try {
    await sender.sendOrderPaid({
      to,
      customerName: 'Kennedy Teste',
      publicReference: 'TEST-' + Date.now().toString(36).toUpperCase(),
      productName: 'Produto de Teste payunivercart',
      amountFormatted: 'R$ 97,00',
      brand: 'payunivercart QA',
      deliveryUrl: 'https://example.com/acesso',
      deliveryInstructions: 'Use o email da compra pra logar.',
    });
    console.log('\n✅ Email dispatched. Confere a caixa.');
    if (!apiKey) {
      console.log('⚠️  RESEND_API_KEY not set → no real email sent, só log acima.');
    }
  } catch (e) {
    console.error('\n❌ Falhou:', e instanceof Error ? e.message : e);
    process.exit(2);
  }
}

main();
