import { Link } from 'react-router-dom';
import { StoreHeader } from './Header';
import type { StoreInfo } from './types';

// Texto-base de privacidade (LGPD). Deve ser revisado pela loja/assessoria jurídica antes da produção.
export function PrivacyPage({ store }: { store: StoreInfo }) {
  return (
    <div className="c-shell">
      <StoreHeader store={store} compact />
      <main className="c-main prose">
        <Link to="/cardapio" className="back-link">← Voltar ao cardápio</Link>
        <h1>Privacidade</h1>
        <p>O {store.name} usa os dados informados no pedido (nome, telefone e endereço) somente para preparar, entregar e dar suporte ao seu pedido, e para cumprir obrigações legais e fiscais.</p>
        <h2>O que guardamos</h2>
        <ul>
          <li>Nome, telefone e endereço de entrega.</li>
          <li>Itens, valores, forma de pagamento e horário do pedido.</li>
          <li>Não guardamos dados de cartão. O pagamento é feito na entrega.</li>
        </ul>
        <h2>Por quanto tempo</h2>
        <p>Os dados pessoais dos pedidos concluídos são anonimizados periodicamente. Valores e itens podem ser mantidos para registros financeiros.</p>
        <h2>Compartilhamento</h2>
        <p>Não vendemos nem compartilhamos seus dados para marketing. O endereço é usado apenas pela equipe de entrega.</p>
        <h2>Seus direitos</h2>
        <p>Você pode pedir acesso, correção ou exclusão dos seus dados{store.privacyContact ? ` pelo contato: ${store.privacyContact}` : store.phone ? ` pelo telefone ${store.phone}` : ''}.</p>
        <p>Se você marcou "Lembrar meus dados neste aparelho", eles ficam salvos apenas no seu navegador e podem ser apagados limpando os dados do site.</p>
      </main>
    </div>
  );
}
