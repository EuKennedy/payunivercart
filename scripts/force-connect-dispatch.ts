/**
 * Força o disparo do Connect entitlement.granted para uma subscription
 * já ativa que não recebeu magic link (porque foi criada antes do fix,
 * ou porque o plano não estava ligado ao partner no momento da compra).
 *
 * Uso (dentro do container api):
 *   pnpm tsx scripts/force-connect-dispatch.ts <subscriptionId>
 *
 * Ou, pra pegar a última automaticamente:
 *   pnpm tsx scripts/force-connect-dispatch.ts --latest
 */
import 'dotenv/config';
import { schema } from '@payunivercart/db';
import { desc } from 'drizzle-orm';
import { ConnectDispatcher } from '../apps/api/src/connect/dispatcher';
import { loadEnv } from '../apps/api/src/env';
import { buildServices } from '../apps/api/src/services';

async function main() {
  const arg = process.argv[2];
  if (!arg) {
    console.error('Uso: pnpm tsx scripts/force-connect-dispatch.ts <subscriptionId|--latest>');
    process.exit(1);
  }

  const env = loadEnv();
  const services = buildServices(env);

  let subscriptionId = arg;
  if (arg === '--latest') {
    const [latest] = await services.db.db
      .select({ id: schema.subscriptions.id })
      .from(schema.subscriptions)
      .orderBy(desc(schema.subscriptions.createdAt))
      .limit(1);
    if (!latest) {
      console.error('Nenhuma subscription encontrada.');
      process.exit(2);
    }
    subscriptionId = latest.id;
    console.log(`→ Latest subscriptionId: ${subscriptionId}`);
  }

  console.log('==========================================');
  console.log('FORCE CONNECT DISPATCH');
  console.log('==========================================');
  console.log(`subscriptionId: ${subscriptionId}`);
  console.log('==========================================\n');

  const dispatcher = new ConnectDispatcher(services);
  const result = await dispatcher.dispatch({
    type: 'entitlement.granted',
    subscriptionId,
  });

  console.log('\nResultado:');
  console.log(JSON.stringify(result, null, 2));

  if ('skipped' in result) {
    console.error(`\n⚠️  SKIPPED: ${result.reason}`);
    console.error('Provavel: plano sem partner_account_id / partner_role_slug.');
    process.exit(3);
  }

  console.log('\n✅ Dispatch ok. Buyer deve receber email + WhatsApp com magic link.');
  process.exit(0);
}

main().catch((e) => {
  console.error('❌ Falhou:', e instanceof Error ? e.message : e);
  if (e instanceof Error && e.stack) console.error(e.stack);
  process.exit(2);
});
