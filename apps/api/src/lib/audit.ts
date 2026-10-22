import type { Db } from '../db/pool.js';

export interface AuditActor {
  storeId: string;
  userId?: string | null;
  deviceId?: string | null;
  ip?: string | null;
}

export async function audit(db: Db, actor: AuditActor, action: string, entity = '', entityId = '', data: object = {}) {
  await db.query(
    `INSERT INTO audit_log (store_id, user_id, device_id, action, entity, entity_id, data, ip)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [actor.storeId, actor.userId ?? null, actor.deviceId ?? null, action, entity, entityId, JSON.stringify(data), actor.ip ?? null],
  );
}
