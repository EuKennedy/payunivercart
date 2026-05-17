import Link from 'next/link';
import { Button } from '../components/ui';

/**
 * Marketing homepage. Single-page narrative: hero -> primary CTA -> the
 * three pillars (produto, checkout, recovery) -> closing CTA. Dark-first
 * cinematic styling that earns the user's attention without falling into
 * generic SaaS template territory.
 */
export default function HomePage() {
  return (
    <div className="relative min-h-screen overflow-hidden">
      {/* Ambient glow — subtle radial that sets the cinematic tone. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-[-30%] mx-auto h-[800px] max-w-5xl
                   bg-[radial-gradient(closest-side,rgba(249,115,22,0.18),transparent_75%)] blur-3xl"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-[linear-gradient(180deg,transparent_60%,rgba(0,0,0,0.4))]"
      />

      {/* Top bar */}
      <header className="relative z-10 mx-auto flex max-w-6xl items-center justify-between px-6 py-6">
        <div className="flex items-center gap-2">
          <span className="grid size-8 place-items-center rounded-lg bg-gradient-to-br from-[var(--color-brand-400)] to-[var(--color-brand-700)] text-sm font-bold text-black">
            P
          </span>
          <span className="text-sm font-semibold tracking-tight">payunivercart</span>
        </div>
        <div className="flex items-center gap-2">
          <Link href="/login">
            <Button variant="ghost">Entrar</Button>
          </Link>
          <Link href="/signup">
            <Button variant="primary">Criar conta</Button>
          </Link>
        </div>
      </header>

      {/* Hero */}
      <section className="relative z-10 mx-auto flex max-w-6xl flex-col items-center px-6 pb-24 pt-16 text-center md:pt-28">
        <span className="mb-6 inline-flex items-center gap-2 rounded-full border border-[var(--color-border)] bg-white/[0.03] px-4 py-1.5 text-xs uppercase tracking-[0.2em] text-[var(--color-fg-muted)]">
          <span className="size-1.5 rounded-full bg-[var(--color-brand-400)] shadow-[0_0_12px_rgba(249,115,22,0.8)]" />
          plataforma multi-tenant · whatsapp-first
        </span>
        <h1 className="max-w-3xl text-balance text-5xl font-semibold leading-[1.05] tracking-tight md:text-7xl">
          Sua venda digital,
          <br />
          <span className="bg-gradient-to-b from-[var(--color-brand-300)] to-[var(--color-brand-600)] bg-clip-text text-transparent">
            sem fricção.
          </span>
        </h1>
        <p className="mt-6 max-w-2xl text-balance text-lg leading-relaxed text-[var(--color-fg-muted)] md:text-xl">
          payunivercart conecta seu produto digital ao seu cliente em minutos. Checkout próprio,
          WhatsApp integrado, recuperação automática de carrinho. Você foca em vender — a gente cuida
          do resto.
        </p>
        <div className="mt-10 flex flex-col items-center gap-3 sm:flex-row">
          <Link href="/signup">
            <Button variant="primary" className="px-7 py-3 text-base">
              Começar agora
            </Button>
          </Link>
          <Link href="/login">
            <Button variant="ghost" className="px-7 py-3 text-base">
              Já tenho conta
            </Button>
          </Link>
        </div>
        <p className="mt-4 text-xs text-[var(--color-fg-subtle)]">
          R$ 99,90/mês por workspace · sem taxa de adesão · cancela quando quiser
        </p>
      </section>

      {/* Pillars */}
      <section className="relative z-10 mx-auto max-w-6xl px-6 pb-24">
        <div className="grid gap-6 md:grid-cols-3">
          <Pillar
            kicker="01 · catálogo"
            title="Cadastre uma vez, venda em todo lugar."
            body="Infoprodutos, físicos, assinaturas. Categorias, variações, performance por SKU — um único catálogo conectado a um único checkout."
          />
          <Pillar
            kicker="02 · checkout"
            title="Um checkout que converte."
            body="Personalize cor, campos, métodos de pagamento. Suporte Pix, cartão, boleto e Stripe USD para vendas internacionais — tudo na mesma tela."
          />
          <Pillar
            kicker="03 · recovery"
            title="Carrinho abandonado vira venda."
            body="Cadência automática via WhatsApp e email com tom configurável. A engine de retargeting já roda sozinha — você define as regras uma vez."
          />
        </div>
      </section>

      {/* Closing */}
      <section className="relative z-10 mx-auto max-w-3xl px-6 pb-32 text-center">
        <h2 className="text-balance text-3xl font-semibold tracking-tight md:text-4xl">
          Comece a vender hoje. Pague só pelo que usar.
        </h2>
        <p className="mt-4 text-[var(--color-fg-muted)]">
          Sete dias para testar tudo. Sem cartão, sem amarras.
        </p>
        <div className="mt-8 flex justify-center">
          <Link href="/signup">
            <Button variant="primary" className="px-7 py-3 text-base">
              Criar workspace gratuito
            </Button>
          </Link>
        </div>
      </section>

      <footer className="relative z-10 mx-auto max-w-6xl border-t border-[var(--color-border)] px-6 py-8 text-center text-xs text-[var(--color-fg-subtle)]">
        © {new Date().getFullYear()} payunivercart · todos os direitos reservados
      </footer>
    </div>
  );
}

function Pillar({
  kicker,
  title,
  body,
}: {
  kicker: string;
  title: string;
  body: string;
}) {
  return (
    <article className="glass flex h-full flex-col gap-3 p-7">
      <span className="text-[10px] uppercase tracking-[0.24em] text-[var(--color-brand-400)]">
        {kicker}
      </span>
      <h3 className="text-xl font-semibold tracking-tight">{title}</h3>
      <p className="text-sm leading-relaxed text-[var(--color-fg-muted)]">{body}</p>
    </article>
  );
}
