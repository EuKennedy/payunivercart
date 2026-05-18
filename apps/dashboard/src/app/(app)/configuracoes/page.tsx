import { redirect } from 'next/navigation';

/**
 * `/configuracoes` is purely a parent route. Landing here drops the
 * producer on the first section (Empresa) so the URL bar always
 * carries the active sub-path — easier to bookmark + share + restore.
 */
export default function ConfiguracoesIndexPage() {
  redirect('/configuracoes/empresa');
}
