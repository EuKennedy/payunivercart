import Link from 'next/link';
import { Button, GlassCard, Heading } from '../components/ui.js';

export default function HomePage() {
  return (
    <main className="grid min-h-screen place-items-center px-6 py-12">
      <GlassCard className="w-full max-w-xl space-y-6 text-center">
        <Heading>payunivercart</Heading>
        <p className="text-[var(--color-fg-muted)]">
          Facilitador de pagamento para produtores digitais. Cadastre seu produto, conecte seu
          WhatsApp, comece a vender em minutos.
        </p>
        <div className="flex items-center justify-center gap-3 pt-2">
          <Link href="/login">
            <Button variant="primary">Entrar</Button>
          </Link>
          <Link href="/signup">
            <Button variant="ghost">Criar conta</Button>
          </Link>
        </div>
      </GlassCard>
    </main>
  );
}
