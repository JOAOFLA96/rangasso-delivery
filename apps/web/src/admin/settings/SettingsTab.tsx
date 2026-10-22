import { NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { canManage, useSession } from '../session';
import { MenuSettings } from './MenuSettings';
import { DeliverySettings } from './DeliverySettings';
import { PrinterSettings } from './PrinterSettings';
import { StoreSettings } from './StoreSettings';
import { UsersSettings } from './UsersSettings';
import { AuditLog } from './AuditLog';
import { MyAccount } from './MyAccount';

export function SettingsTab() {
  const { user } = useSession();
  const manage = canManage(user);
  const items = [
    ['cardapio', 'Cardápio'],
    ['entrega', 'Entrega e horários'],
    ['impressora', 'Impressora'],
    ...(manage ? [['loja', 'Dados da loja'], ['auditoria', 'Auditoria']] : []),
    ...(user.role === 'owner' ? [['usuarios', 'Usuários']] : []),
    ['conta', 'Minha conta'],
  ];
  return (
    <div className="a-settings">
      <nav className="a-subnav" aria-label="Configurações">
        {items.map(([path, label]) => <NavLink key={path} to={`/admin/configuracoes/${path}`}>{label}</NavLink>)}
      </nav>
      <div className="a-settings-body">
        {!manage && <p className="alert alert-info">Seu perfil é de atendente: você pode marcar produtos como esgotados e imprimir teste. As demais alterações são feitas por gerente ou dono.</p>}
        <Routes>
          <Route path="cardapio" element={<MenuSettings />} />
          <Route path="entrega" element={<DeliverySettings />} />
          <Route path="impressora" element={<PrinterSettings />} />
          <Route path="loja" element={<StoreSettings />} />
          <Route path="usuarios" element={<UsersSettings />} />
          <Route path="auditoria" element={<AuditLog />} />
          <Route path="conta" element={<MyAccount />} />
          <Route path="*" element={<Navigate to="cardapio" replace />} />
        </Routes>
      </div>
    </div>
  );
}
