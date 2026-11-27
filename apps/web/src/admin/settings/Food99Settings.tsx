import { useEffect, useState } from 'react';
import { api, formatDateTime } from '../../lib/api';
import { canManage, useSession } from '../session';
import { errorText, useToast } from '../ui';

interface Info {
  configured: boolean;
  appId: string | null;
  autoConfirm: boolean;
  webhookUrl: string;
  shops: { appShopId: string; bound: boolean; tokenOk: boolean; tokenExpiresAt: string | null; lastError: string | null }[];
  events: { type: string; appShopId: string | null; orderId: string | null; result: string; at: string }[];
  orders: { total: number; last24h: number };
}

// Configurações › 99Food: situação da integração, endereço para cadastrar no portal e lojas ligadas.
export function Food99Settings() {
  const { user } = useSession();
  const toast = useToast();
  const [d, setD] = useState<Info | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const [shopId, setShopId] = useState('');
  const load = () => api<Info>('/api/admin/integrations/99food').then(setD).catch((e) => toast(errorText(e), 'error'));
  useEffect(() => { load(); }, []);

  async function bindLink() {
    try {
      setLink((await api<{ url: string }>('/api/admin/integrations/99food/bind-link', { body: {} })).url);
    } catch (e) {
      toast(errorText(e), 'error');
    }
  }
  async function addShop() {
    try {
      await api('/api/admin/integrations/99food/shops', { body: { appShopId: shopId.trim() } });
      toast('Loja ligada e token obtido');
      setShopId('');
      load();
    } catch (e) {
      toast(errorText(e), 'error');
      load();
    }
  }
  async function refresh(id: string) {
    try {
      await api(`/api/admin/integrations/99food/shops/${encodeURIComponent(id)}/token`, { body: {} });
      toast('Token renovado');
    } catch (e) {
      toast(errorText(e), 'error');
    }
    load();
  }

  if (!d) return <p className="muted">Carregando…</p>;
  const manage = canManage(user);
  return (
    <div>
      <h2>99Food</h2>
      <section className="card">
        <h3>Situação</h3>
        {d.configured
          ? <p className="alert alert-ok">Integração ligada (app {d.appId}). {d.autoConfirm ? 'Pedidos aceitos automaticamente assim que chegam.' : 'Aceite manual: confirme cada pedido em até 5 minutos.'}</p>
          : <p className="alert alert-info">Integração desligada. Depois que o 99Food aprovar o cadastro, coloque as variáveis <code>FOOD99_APP_ID</code> e <code>FOOD99_APP_SECRET</code> no servidor (Render › Environment) e faça um novo deploy.</p>}
        <p className="muted small">Pedidos do 99Food: {d.orders.total} no total, {d.orders.last24h} nas últimas 24 h. Eles aparecem na aba Pedidos com a etiqueta 99Food e saem na impressora como os do cardápio.</p>
        <label className="field"><span>Endereço de callback (cole no app do portal de desenvolvedores do 99Food)</span>
          <input readOnly value={d.webhookUrl} onFocus={(e) => e.target.select()} />
        </label>
      </section>

      <section className="card">
        <h3>Lojas ligadas</h3>
        {d.shops.length === 0 && <p className="muted">Nenhuma loja ligada ainda.</p>}
        <ul className="a-jobs">
          {d.shops.map((s) => (
            <li key={s.appShopId}>
              <div className="ai-line">
                <span><strong>{s.appShopId}</strong> · {s.bound ? 'ligada' : 'desligada'}</span>
                <span className={`pill pill-sm ${s.tokenOk ? 'p-ok' : 'p-fail'}`}>{s.tokenOk ? 'Token válido' : 'Sem token válido'}</span>
              </div>
              {s.tokenExpiresAt && <div className="muted small">Token vale até {formatDateTime(s.tokenExpiresAt)} (renovado sozinho).</div>}
              {s.lastError && <div className="field-error">{s.lastError}</div>}
              {manage && d.configured && <button className="btn btn-ghost btn-sm" onClick={() => refresh(s.appShopId)}>Renovar token agora</button>}
            </li>
          ))}
        </ul>
        {manage && d.configured && (
          <>
            <p className="muted small">Para ligar a loja: gere o link abaixo e abra com o usuário SuperAdmin da loja no 99Food. Ele vale 7 dias.</p>
            <button className="btn btn-secondary" onClick={bindLink}>Gerar link de autorização</button>
            {link && <p><a href={link} target="_blank" rel="noreferrer">Abrir link de autorização do 99Food</a></p>}
            <p className="muted small">Se a equipe do 99Food ligou a loja e passou o código da loja no seu sistema (app_shop_id), informe aqui:</p>
            <div className="a-row">
              <input value={shopId} maxLength={80} placeholder="app_shop_id" onChange={(e) => setShopId(e.target.value)} />
              <button className="btn btn-secondary" disabled={!shopId.trim()} onClick={addShop}>Ligar loja</button>
            </div>
          </>
        )}
      </section>

      <section className="card">
        <h3>Últimos avisos do 99Food</h3>
        {d.events.length === 0 ? <p className="muted">Nenhum aviso recebido ainda.</p> : (
          <ul className="a-history">
            {d.events.map((e, i) => (
              <li key={i}><strong>{e.type}</strong> · {formatDateTime(e.at)}{e.orderId ? ` · pedido ${e.orderId}` : ''}<div className="muted small">{e.result}</div></li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
