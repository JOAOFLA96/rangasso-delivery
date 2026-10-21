import { createContext, useContext } from 'react';

export interface AdminUser { id: string; name: string; email: string; role: 'owner' | 'manager' | 'staff' }
export const SessionCtx = createContext<{ user: AdminUser; logout: () => void } | null>(null);
export const useSession = () => useContext(SessionCtx)!;
export const ROLE_LABELS = { owner: 'Dono', manager: 'Gerente', staff: 'Atendente' } as const;
export const canManage = (u: AdminUser) => u.role === 'owner' || u.role === 'manager';
