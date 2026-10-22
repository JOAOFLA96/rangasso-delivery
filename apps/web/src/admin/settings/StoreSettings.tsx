import { useState } from 'react';
import { api } from '../../lib/api';
import { Toggle, errorText, useToast } from '../ui';
import { useSettings } from './useSettings';

export function StoreSettings() {
  const { data, reload } = useSettings();
  if (!data) return <p className="muted">Carregando…</p>;
  return <StoreForm s={data.settings} reload={reload} />;
}

function StoreForm({ s, reload }: { s: Record<string, any>; reload: () => Promise<void> }) {
  const toast = useToast();
  const [f, setF] = useState({
    displayName: s.displayName, tagline: s.tagline, phone: s.phone, whatsapp: s.whatsapp, address: s.address, menuMessage: s.menuMessage,
    closedMessage: s.closedMessage, deliveryInstructions: s.deliveryInstructions, privacyContact: s.privacyContact,
    acceptsCash: s.acceptsCash, acceptsPix: s.acceptsPix, acceptsCard: s.acceptsCard, pixKey: s.pixKey, pixInstructions: s.pixInstructions,
  });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  async function save() {
    try {
      await api('/api/admin/settings/store', { method: 'PUT', body: f });
      toast('Dados da loja salvos');
      reload();
    } catch (e) {
      toast(errorText(e), 'error');
    }
  }
  async function uploadLogo(file: File) {
    const form = new FormData();
    form.append('file', file);
    try {
      await api('/api/admin/settings/logo', { form });
      toast('Logo atualizada');
      reload();
    } catch (e) {
      toast(errorText(e), 'error');
    }
  }
  return (
    <div>
      <h2>Dados da loja</h2>
      <section className="card">
        <h3>Identidade</h3>
        <div className="a-row">
          <img src={s.logoUrl ?? '/brand/logo-rangasso-trim.png'} alt="Logo atual" className="a-logo-preview" />
          <div>
            <label className="btn btn-secondary btn-sm file-btn">Trocar logo<input type="file" accept="image/png,image/jpeg,image/webp" onChange={(e) => e.target.files?.[0] && uploadLogo(e.target.files[0])} /></label>
            <p className="muted small">{s.logoUrl ? 'Logo enviada pelo painel.' : 'Usando a logo oficial do Rangasso que veio com o sistema.'} Prefira PNG com fundo branco ou transparente, com boa resolução.</p>
          </div>
        </div>
        <div className="grid-2">
          <label className="field"><span>Nome comercial</span><input value={f.displayName} maxLength={60} onChange={set('displayName')} /></label>
          <label className="field"><span>Slogan</span><input value={f.tagline} maxLength={80} onChange={set('tagline')} /></label>
          <label className="field"><span>Telefone</span><input value={f.phone} maxLength={25} inputMode="tel" onChange={set('phone')} /></label>
          <label className="field"><span>WhatsApp (só números com DDD)</span><input value={f.whatsapp} maxLength={25} inputMode="tel" onChange={set('whatsapp')} /></label>
        </div>
        <label className="field"><span>Endereço</span><input value={f.address} maxLength={200} onChange={set('address')} /></label>
      </section>

      <section className="card">
        <h3>Mensagens do cardápio</h3>
        <label className="field"><span>Aviso no topo do cardápio</span><textarea rows={2} maxLength={300} value={f.menuMessage} onChange={set('menuMessage')} /></label>
        <label className="field"><span>Mensagem de loja fechada</span><textarea rows={2} maxLength={300} value={f.closedMessage} onChange={set('closedMessage')} /></label>
        <label className="field"><span>Instruções de entrega (aparece no checkout)</span><textarea rows={2} maxLength={400} value={f.deliveryInstructions} onChange={set('deliveryInstructions')} /></label>
        <label className="field"><span>Contato para privacidade/LGPD (e-mail ou telefone)</span><input value={f.privacyContact} maxLength={120} onChange={set('privacyContact')} /></label>
      </section>

      <section className="card">
        <h3>Formas de pagamento aceitas</h3>
        <Toggle checked={f.acceptsCash} onChange={(v) => setF({ ...f, acceptsCash: v })} label="Dinheiro (com opção de troco)" />
        <Toggle checked={f.acceptsPix} onChange={(v) => setF({ ...f, acceptsPix: v })} label="Pix" />
        <Toggle checked={f.acceptsCard} onChange={(v) => setF({ ...f, acceptsCard: v })} label="Cartão na entrega" />
        {f.acceptsPix && (
          <>
            <label className="field"><span>Chave Pix (uso interno/comanda)</span><input value={f.pixKey} maxLength={120} onChange={set('pixKey')} /></label>
            <label className="field"><span>Instrução de Pix para o cliente</span><textarea rows={2} maxLength={300} value={f.pixInstructions} onChange={set('pixInstructions')} placeholder="Ex.: o entregador leva o QR Code, ou envie o comprovante no WhatsApp." /></label>
          </>
        )}
        <p className="muted small">Não há pagamento online integrado: o pedido nunca aparece como "pago". A confirmação é feita pela equipe na entrega.</p>
      </section>
      <button className="btn btn-primary btn-lg" onClick={save}>Salvar dados da loja</button>
    </div>
  );
}
