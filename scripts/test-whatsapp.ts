/**
 * Test WhatsApp dispatch — usa o WahaClient real.
 *
 * Uso (dentro do container api ou local com env apontando pra WAHA):
 *   pnpm tsx scripts/test-whatsapp.ts 31984956383
 *
 * Resolve o chatId via WAHA `checkExists` (lida com BR 9-prefix quirk),
 * depois envia texto. Imprime o flow inteiro pra diagnóstico.
 */
import 'dotenv/config';
import { WahaClient } from '@payunivercart/waha';

async function main() {
  const rawDigits = process.argv[2];
  if (!rawDigits) {
    console.error('Uso: pnpm tsx scripts/test-whatsapp.ts <ddd+numero, ex: 31984956383>');
    process.exit(1);
  }
  // Garante prefixo país BR se usuário passou só DDD+número.
  const digits = rawDigits.startsWith('55') ? rawDigits : `55${rawDigits}`;

  const baseUrl = process.env.WAHA_BASE_URL;
  const apiKey = process.env.WAHA_API_KEY;
  const session = process.env.WAHA_DEFAULT_SESSION ?? 'default';

  if (!baseUrl) throw new Error('WAHA_BASE_URL não setado');
  if (!apiKey) throw new Error('WAHA_API_KEY não setado');

  console.log('==========================================');
  console.log('TEST WHATSAPP DISPATCH');
  console.log('==========================================');
  console.log(`WAHA_BASE_URL: ${baseUrl}`);
  console.log(`WAHA_API_KEY:  ${apiKey.slice(0, 4)}… (${apiKey.length} chars)`);
  console.log(`SESSION:       ${session}`);
  console.log(`PHONE:         +${digits}`);
  console.log('==========================================\n');

  const client = new WahaClient({ baseUrl, apiKey, defaultSession: session });

  // 1. Resolve chatId
  console.log('→ Chamando checkExists pra resolver chatId…');
  try {
    const existsResult = await client.checkExists(digits, session);
    console.log('  resposta:', JSON.stringify(existsResult));
    if (!existsResult.numberExists || !existsResult.chatId) {
      console.error(`\n❌ Número +${digits} não existe no WhatsApp.`);
      process.exit(3);
    }
    const chatId = existsResult.chatId;
    console.log(`  chatId resolvido: ${chatId}\n`);

    // 2. Send text
    console.log('→ Enviando texto…');
    await client.sendText({
      session,
      chatId: chatId as `${string}@c.us`,
      text:
        `🤖 Teste payunivercart\n\n` +
        `Se você recebeu essa mensagem, o módulo WhatsApp tá funcionando.\n\n` +
        `Timestamp: ${new Date().toISOString()}`,
      linkPreview: false,
    });
    console.log('\n✅ Mensagem disparada. Confere o WhatsApp.');
  } catch (e) {
    console.error('\n❌ Falhou:', e instanceof Error ? e.message : e);
    if (e instanceof Error && e.stack) console.error(e.stack);
    process.exit(2);
  }
}

main();
