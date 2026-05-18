import Link from 'next/link';
import type { ReactNode } from 'react';
import { Button, Heading, Kicker } from '../components/ui';

/**
 * Marketing homepage — light-first, Apple-tier.
 *
 * Sections: top nav · hero · feature pillars · social proof · pricing card ·
 * closing CTA · footer. The narrative arcs from problem awareness ("vender
 * digital é fricção") to product promise ("checkout que converte") to
 * commercial action ("crie seu workspace").
 */
export default function HomePage() {
  return (
    <div className="relative min-h-screen overflow-x-hidden bg-[var(--color-bg)]">
      <TopNav />
      <Hero />
      <Pillars />
      <FeatureRow />
      <PricingCard />
      <FinalCTA />
      <Footer />
    </div>
  );
}

function TopNav() {
  return (
    <header className="sticky top-0 z-40 border-[var(--color-border)] border-b bg-[var(--color-bg)]/85 backdrop-blur-xl backdrop-saturate-150">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
        <Link href="/" className="flex items-center gap-2.5">
          <span className="grid size-8 place-items-center rounded-lg bg-[var(--color-fg)] font-semibold text-[13px] text-[var(--color-fg-inverse)]">
            p
          </span>
          <span className="font-semibold text-[15px] tracking-tight">payunivercart</span>
        </Link>
        <nav className="hidden items-center gap-7 md:flex">
          <a
            href="#produto"
            className="text-[14px] text-[var(--color-fg-muted)] transition hover:text-[var(--color-fg)]"
          >
            Produto
          </a>
          <a
            href="#preco"
            className="text-[14px] text-[var(--color-fg-muted)] transition hover:text-[var(--color-fg)]"
          >
            Preço
          </a>
          <a
            href="#empresa"
            className="text-[14px] text-[var(--color-fg-muted)] transition hover:text-[var(--color-fg)]"
          >
            Empresa
          </a>
        </nav>
        <div className="flex items-center gap-2">
          <Link href="/login">
            <Button variant="ghost" size="sm">
              Entrar
            </Button>
          </Link>
          <Link href="/signup">
            <Button variant="primary" size="sm">
              Criar conta
            </Button>
          </Link>
        </div>
      </div>
    </header>
  );
}

function Hero() {
  return (
    <section className="mx-auto max-w-6xl px-6 pt-20 pb-24 md:pt-32">
      <div className="mx-auto flex max-w-3xl flex-col items-center text-center">
        <span className="mb-6 inline-flex items-center gap-2 rounded-full border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-1.5 font-medium text-[12px] text-[var(--color-fg-muted)] shadow-[var(--shadow-xs)]">
          <span className="size-1.5 rounded-full bg-[var(--color-brand-500)]" />
          Plataforma multi-tenant · WhatsApp-first
        </span>
        <h1 className="display text-balance font-semibold text-[44px] text-[var(--color-fg)] leading-[1.05] tracking-tight md:text-[72px]">
          O sistema operacional
          <br />
          da sua venda digital.
        </h1>
        <p className="mt-6 max-w-2xl text-balance text-[17px] text-[var(--color-fg-muted)] leading-[1.5] md:text-[19px]">
          Catálogo, checkout customizável e recuperação automática de carrinho em uma única
          plataforma. Conecte seu WhatsApp em minutos. Comece a vender hoje.
        </p>
        <div className="mt-10 flex flex-col items-center gap-3 sm:flex-row">
          <Link href="/signup">
            <Button variant="primary" size="lg">
              Criar workspace
            </Button>
          </Link>
          <Link href="/login">
            <Button variant="secondary" size="lg">
              Já tenho conta
            </Button>
          </Link>
        </div>
        <p className="mt-4 text-[12px] text-[var(--color-fg-subtle)]">
          R$ 99,90/mês por workspace · sem taxa de adesão · cancela quando quiser
        </p>
      </div>

      {/* Floating product card preview */}
      <div className="relative mx-auto mt-20 max-w-5xl">
        <div className="surface relative overflow-hidden rounded-[22px] p-2">
          <div className="rounded-[18px] border border-[var(--color-border)] bg-[var(--color-surface-muted)] p-8">
            <div className="grid gap-6 md:grid-cols-3">
              <PreviewMetric label="GMV (mês)" value="R$ 124,8K" trend="+18%" trendUp />
              <PreviewMetric label="Pedidos" value="412" trend="+24%" trendUp />
              <PreviewMetric label="Conversão" value="3,8%" trend="+0,4pp" trendUp />
            </div>
            <div className="mt-6 flex items-center gap-3 rounded-xl border border-[var(--color-border-strong)] border-dashed bg-[var(--color-surface)] p-4">
              <span className="grid size-9 place-items-center rounded-lg bg-[var(--color-brand-50)] text-[15px]">
                💬
              </span>
              <div className="flex-1">
                <p className="font-medium text-[13px] text-[var(--color-fg)]">
                  WhatsApp · ws_a3f9d4 · WORKING
                </p>
                <p className="text-[12px] text-[var(--color-fg-subtle)]">
                  Conectado há 8 dias · 1.247 mensagens automatizadas
                </p>
              </div>
              <span className="rounded-full bg-[var(--color-success-bg)] px-2.5 py-1 font-medium text-[11px] text-[var(--color-success)]">
                Ativo
              </span>
            </div>
          </div>
        </div>
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-12 top-full mx-auto h-24 max-w-3xl rounded-full bg-[var(--color-brand-200)] opacity-30 blur-3xl"
        />
      </div>
    </section>
  );
}

function PreviewMetric({
  label,
  value,
  trend,
  trendUp,
}: {
  label: string;
  value: string;
  trend: string;
  trendUp?: boolean;
}) {
  return (
    <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
      <p className="font-medium text-[12px] text-[var(--color-fg-subtle)] uppercase tracking-wider">
        {label}
      </p>
      <p className="mt-2 font-semibold text-3xl text-[var(--color-fg)] tracking-tight">{value}</p>
      <p
        className={`mt-1 font-medium text-[12px] ${
          trendUp ? 'text-[var(--color-success)]' : 'text-[var(--color-danger)]'
        }`}
      >
        {trend} vs período anterior
      </p>
    </div>
  );
}

function Pillars() {
  return (
    <section id="produto" className="border-[var(--color-border)] border-t bg-[var(--color-bg)]">
      <div className="mx-auto max-w-6xl px-6 py-24">
        <div className="mb-14 max-w-2xl">
          <Kicker>Plataforma</Kicker>
          <Heading level={2} className="mt-3">
            Tudo que sua operação precisa.
            <br />
            Nada que não precisa.
          </Heading>
        </div>
        <div className="grid gap-5 md:grid-cols-3">
          <PillarCard
            kicker="01"
            title="Catálogo unificado"
            body="Infoprodutos, físicos, assinaturas. Variações de preço, performance por SKU, link de checkout próprio — gerenciado em um só painel."
            icon={<IconBox />}
          />
          <PillarCard
            kicker="02"
            title="Checkout que converte"
            body="Cor, logo, campos extras, métodos de pagamento. Pix, cartão, boleto, Stripe USD. Personalize sem código."
            icon={<IconCart />}
          />
          <PillarCard
            kicker="03"
            title="Recovery automático"
            body="Cadência de mensagens via WhatsApp e email com tom configurável. A engine roda sozinha. Você define as regras uma vez."
            icon={<IconBolt />}
          />
        </div>
      </div>
    </section>
  );
}

function PillarCard({
  kicker,
  title,
  body,
  icon,
}: {
  kicker: string;
  title: string;
  body: string;
  icon: ReactNode;
}) {
  return (
    <article className="surface-interactive p-7">
      <span className="grid size-10 place-items-center rounded-xl bg-[var(--color-surface-muted)] text-[var(--color-fg)]">
        {icon}
      </span>
      <p className="mt-5 font-semibold text-[11px] text-[var(--color-fg-subtle)] uppercase tracking-[0.18em]">
        {kicker}
      </p>
      <h3 className="mt-2 font-semibold text-[20px] text-[var(--color-fg)] tracking-tight">
        {title}
      </h3>
      <p className="mt-3 text-[15px] text-[var(--color-fg-muted)] leading-[1.55]">{body}</p>
    </article>
  );
}

function FeatureRow() {
  const features = [
    'Pix, cartão, boleto e Stripe USD',
    'Multi-tenant: 1 conta · N workspaces',
    'WhatsApp via WAHA — sessão dedicada por workspace',
    'Auditoria criptográfica (HMAC-SHA256 chain)',
    'RLS no Postgres — isolamento por tenant',
    'BullMQ + Drizzle — fila e schema versionados',
  ];
  return (
    <section className="border-[var(--color-border)] border-t bg-[var(--color-surface-muted)]">
      <div className="mx-auto max-w-6xl px-6 py-20">
        <div className="grid gap-3 md:grid-cols-3">
          {features.map((f) => (
            <div
              key={f}
              className="flex items-start gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4"
            >
              <span className="mt-0.5 grid size-5 shrink-0 place-items-center rounded-full bg-[var(--color-brand-50)] text-[var(--color-brand-600)]">
                <IconCheck />
              </span>
              <p className="text-[14px] text-[var(--color-fg)] leading-[1.5]">{f}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function PricingCard() {
  return (
    <section id="preco" className="border-[var(--color-border)] border-t">
      <div className="mx-auto max-w-3xl px-6 py-24">
        <div className="surface flex flex-col gap-6 p-10 text-center">
          <Kicker>Preço único</Kicker>
          <p className="font-semibold text-[64px] text-[var(--color-fg)] leading-none tracking-tight">
            R$ 99,90
            <span className="font-medium text-[20px] text-[var(--color-fg-muted)]">/mês</span>
          </p>
          <p className="text-[16px] text-[var(--color-fg-muted)]">
            por workspace · cobrado mensalmente · cancele a qualquer momento
          </p>
          <div className="divider my-2" />
          <ul className="grid gap-3 text-left text-[14px] text-[var(--color-fg)]">
            <PricingItem>Catálogo ilimitado · pedidos ilimitados</PricingItem>
            <PricingItem>WhatsApp dedicado · email transacional</PricingItem>
            <PricingItem>Checkout customizável · todos os métodos</PricingItem>
            <PricingItem>Recuperação automática de carrinho</PricingItem>
            <PricingItem>Suporte por email · resposta em até 24h</PricingItem>
          </ul>
          <Link href="/signup" className="mt-2 self-center">
            <Button variant="primary" size="lg">
              Criar workspace
            </Button>
          </Link>
        </div>
      </div>
    </section>
  );
}

function PricingItem({ children }: { children: ReactNode }) {
  return (
    <li className="flex items-start gap-3">
      <span className="mt-0.5 grid size-5 shrink-0 place-items-center rounded-full bg-[var(--color-success-bg)] text-[var(--color-success)]">
        <IconCheck />
      </span>
      {children}
    </li>
  );
}

function FinalCTA() {
  return (
    <section id="empresa" className="border-[var(--color-border)] border-t bg-[var(--color-bg)]">
      <div className="mx-auto max-w-3xl px-6 py-24 text-center">
        <Heading level={2}>Pronto pra vender de verdade?</Heading>
        <p className="mt-4 text-[17px] text-[var(--color-fg-muted)]">
          Crie seu workspace em 60 segundos. Sem cartão. Sem amarras.
        </p>
        <div className="mt-8 flex justify-center">
          <Link href="/signup">
            <Button variant="primary" size="lg">
              Criar workspace gratuito
            </Button>
          </Link>
        </div>
      </div>
    </section>
  );
}

function Footer() {
  return (
    <footer className="border-[var(--color-border)] border-t bg-[var(--color-surface-muted)]">
      <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-4 px-6 py-8 text-[12px] text-[var(--color-fg-subtle)] md:flex-row">
        <p>© {new Date().getFullYear()} payunivercart · todos os direitos reservados</p>
        <p>Belo Horizonte, MG · Brasil</p>
      </div>
    </footer>
  );
}

// =============================================================================
// Icons — inline SVG, neutral stroke.
// =============================================================================

function IconBox() {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      className="size-5"
    >
      <path strokeLinejoin="round" d="M10 2.5L17 6v8l-7 3.5L3 14V6l7-3.5z" />
      <path strokeLinejoin="round" d="M3 6l7 3.5L17 6M10 9.5v8" />
    </svg>
  );
}
function IconCart() {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      className="size-5"
    >
      <path strokeLinecap="round" strokeLinejoin="round" d="M3 4h2l2 9h10l2-7H7" />
      <circle cx="8" cy="16" r="1.2" />
      <circle cx="15" cy="16" r="1.2" />
    </svg>
  );
}
function IconBolt() {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      className="size-5"
    >
      <path strokeLinejoin="round" d="M11 2L4 12h5l-1 6 7-10h-5l1-6z" />
    </svg>
  );
}
function IconCheck() {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 12 12"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      className="size-3"
    >
      <path strokeLinecap="round" strokeLinejoin="round" d="M2.5 6.5l2.5 2.5 4.5-5" />
    </svg>
  );
}
