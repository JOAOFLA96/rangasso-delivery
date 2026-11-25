import type { PoolClient } from 'pg';
import type { Db } from '../db/pool.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { getSettings } from './store.js';
import { addressLine, planTrip, tripPlannerEnabled, type Point, type TripLeg } from './google.js';
import { canTransition, changeStatus, type OrderStatus } from './orders.js';

// Saídas dos motoboys: junta pedidos de entrega, ordena as paradas (Google, saindo e voltando à loja) e acompanha cada entrega.
// Sem a chave do Google (ou se ele falhar), a ordem é pela distância de cada pedido até a loja e o motoboy ainda recebe o link.

export const MAX_STOPS = 10; // o link do Google Maps no celular aceita até 9 paradas intermediárias + o destino
const ACTIVE_RUN = `('planned','out')`;
// Pedido que pode entrar numa saída: entrega (não retirada), ainda não concluído/cancelado e fora de outra saída.
export const AVAILABLE_SQL = `o.fulfillment = 'delivery' AND o.status NOT IN ('completed','cancelled') AND o.delivery_run_id IS NULL`;

export interface StopOrder {
  id: string; number: number; status: OrderStatus; street: string; street_number: string; neighborhood_name: string; city: string; cep: string;
  delivery_distance_km: string | null;
}
interface Planned { orderIds: string[]; legs: (TripLeg | null)[]; meters: number | null; seconds: number | null; by: 'google' | 'google_manual' | 'distance'; error: string | null }

// "Av. Itororó, 681 - Cidade Nova I, Indaiatuba - SP, 13334-050" → cidade e UF, para completar endereço de pedido sem cidade.
export function cityOf(storeAddress: string) {
  const m = /,\s*([^,]+?)\s*-\s*([A-Z]{2})\b/.exec(storeAddress ?? '');
  return m ? { city: m[1].trim(), state: m[2] } : { city: '', state: '' };
}

export function stopAddress(o: Pick<StopOrder, 'street' | 'street_number' | 'neighborhood_name' | 'city' | 'cep'>, storeAddress: string) {
  const def = cityOf(storeAddress);
  const city = o.city?.trim() || def.city;
  return addressLine({ street: o.street, number: o.street_number, neighborhood: o.neighborhood_name, city, state: city === def.city ? def.state : '', cep: o.cep });
}

// Link para o celular do motoboy: sai de onde ele estiver (a loja), passa pelas paradas na ordem e termina na última.
export function mapsUrl(addresses: string[]) {
  if (!addresses.length) return null;
  const u = new URL('https://www.google.com/maps/dir/');
  u.searchParams.set('api', '1');
  u.searchParams.set('destination', addresses[addresses.length - 1]);
  if (addresses.length > 1) u.searchParams.set('waypoints', addresses.slice(0, -1).join('|'));
  u.searchParams.set('travelmode', 'driving');
  return u.toString();
}

async function storeOrigin(db: Db, storeId: string): Promise<{ origin: Point | string | null; address: string }> {
  const s = await getSettings(db, storeId);
  const origin = s.store_lat != null && s.store_lng != null ? { lat: s.store_lat, lng: s.store_lng } : s.address?.trim() || null;
  return { origin, address: s.address ?? '' };
}

// Ordem das paradas. optimize = Google escolhe; senão mede a ordem recebida. Falhou ou sem Google: pela distância até a loja.
export async function planStops(db: Db, storeId: string, orders: StopOrder[], optimize: boolean): Promise<Planned> {
  const { origin, address } = await storeOrigin(db, storeId);
  let error: string | null = null;
  if (origin && tripPlannerEnabled()) {
    try {
      const t = await planTrip(origin, orders.map((o) => stopAddress(o, address)), optimize);
      if (t && t.legs.length === orders.length + 1) {
        return { orderIds: t.order.map((i) => orders[i].id), legs: t.legs.slice(0, -1), meters: t.meters, seconds: t.seconds, by: optimize ? 'google' : 'google_manual', error: null };
      }
      error = 'o Google não devolveu a rota';
    } catch (e) {
      error = (e as Error).message;
    }
  } else if (!origin) error = 'endereço da loja não cadastrado';
  else error = null; // sem chave do Google: ordem aproximada, sem aviso de erro
  const sorted = optimize
    ? [...orders].sort((a, b) => (Number(a.delivery_distance_km ?? 999) - Number(b.delivery_distance_km ?? 999)) || a.number - b.number)
    : orders;
  return { orderIds: sorted.map((o) => o.id), legs: sorted.map(() => null), meters: null, seconds: null, by: 'distance', error };
}

const ORDER_COLS = `o.id, o.number, o.status, o.street, o.street_number, o.neighborhood_name, o.city, o.cep, o.delivery_distance_km`;

async function loadOrders(db: Db, storeId: string, ids: string[], runId: string | null, lock = false): Promise<StopOrder[]> {
  const uniq = [...new Set(ids)];
  if (!uniq.length) throw badRequest('no_orders', 'Escolha pelo menos um pedido.');
  if (uniq.length > MAX_STOPS) throw badRequest('too_many_stops', `Uma saída leva no máximo ${MAX_STOPS} pedidos.`);
  const r = await db.query(
    `SELECT ${ORDER_COLS}, o.fulfillment, o.delivery_run_id FROM orders o WHERE o.store_id = $1 AND o.id = ANY($2::uuid[]) ${lock ? 'FOR UPDATE' : ''}`,
    [storeId, uniq],
  );
  const byId = new Map(r.rows.map((o) => [o.id, o]));
  for (const id of uniq) {
    const o = byId.get(id);
    if (!o) throw notFound('Pedido');
    if (o.fulfillment !== 'delivery') throw badRequest('not_delivery', `O pedido #${o.number} é para retirar na loja.`);
    if (o.status === 'completed' || o.status === 'cancelled') throw badRequest('order_closed', `O pedido #${o.number} já foi ${o.status === 'completed' ? 'concluído' : 'cancelado'}.`);
    if (o.delivery_run_id && o.delivery_run_id !== runId) throw conflict('order_in_run', `O pedido #${o.number} já está em outra saída.`);
  }
  return uniq.map((id) => byId.get(id));
}

async function writeStops(db: PoolClient, runId: string, plan: Planned) {
  await db.query('DELETE FROM delivery_run_stops WHERE run_id = $1', [runId]);
  for (const [i, id] of plan.orderIds.entries()) {
    const leg = plan.legs[i];
    await db.query(
      `INSERT INTO delivery_run_stops (run_id, order_id, position, leg_distance_m, leg_duration_s) VALUES ($1,$2,$3,$4,$5)`,
      [runId, id, i + 1, leg?.meters ?? null, leg?.seconds ?? null],
    );
  }
  await db.query(`UPDATE orders SET delivery_run_id = $1 WHERE id = ANY($2::uuid[])`, [runId, plan.orderIds]);
  await db.query(
    `UPDATE delivery_runs SET route_by = $2, route_error = $3, total_distance_m = $4, total_duration_s = $5 WHERE id = $1`,
    [runId, plan.by, plan.error, plan.meters, plan.seconds],
  );
}

async function checkCourier(db: Db, storeId: string, courierId: string | null) {
  if (!courierId) return;
  const c = await db.query('SELECT active FROM couriers WHERE id = $1 AND store_id = $2', [courierId, storeId]);
  if (!c.rows[0]) throw notFound('Motoboy');
  if (!c.rows[0].active) throw badRequest('courier_inactive', 'Esse motoboy está desativado.');
}

// O Google é chamado fora da transação (pode levar alguns segundos); dentro dela os pedidos são conferidos de novo.
export async function createRun(tx: <T>(fn: (db: PoolClient) => Promise<T>) => Promise<T>, db: Db, storeId: string, userId: string, input: { courierId: string | null; orderIds: string[]; optimize: boolean }) {
  await checkCourier(db, storeId, input.courierId);
  const orders = await loadOrders(db, storeId, input.orderIds, null);
  const plan = await planStops(db, storeId, orders, input.optimize);
  return tx(async (c) => {
    await loadOrders(c, storeId, input.orderIds, null, true);
    await c.query('SELECT 1 FROM store_settings WHERE store_id = $1 FOR UPDATE', [storeId]); // numeração sem repetir
    const n = (await c.query('SELECT coalesce(max(number),0)+1 AS n FROM delivery_runs WHERE store_id = $1', [storeId])).rows[0].n;
    const run = (await c.query(
      `INSERT INTO delivery_runs (store_id, number, courier_id, created_by) VALUES ($1,$2,$3,$4) RETURNING id, number`,
      [storeId, n, input.courierId, userId],
    )).rows[0];
    await writeStops(c, run.id, plan);
    return { id: run.id as string, number: run.number as number, routeBy: plan.by, routeError: plan.error };
  });
}

async function lockRun(db: PoolClient, storeId: string, runId: string) {
  const r = await db.query('SELECT * FROM delivery_runs WHERE id = $1 AND store_id = $2 FOR UPDATE', [runId, storeId]);
  if (!r.rows[0]) throw notFound('Saída');
  return r.rows[0];
}

// Troca as paradas de uma saída que ainda não saiu (incluir, tirar ou reordenar). optimize=false mantém a ordem recebida.
export async function updateRun(tx: <T>(fn: (db: PoolClient) => Promise<T>) => Promise<T>, db: Db, storeId: string, runId: string, input: { courierId?: string | null; orderIds?: string[]; optimize: boolean }) {
  if (input.courierId !== undefined) await checkCourier(db, storeId, input.courierId);
  const plan = input.orderIds ? await planStops(db, storeId, await loadOrders(db, storeId, input.orderIds, runId), input.optimize) : null;
  return tx(async (c) => {
    const run = await lockRun(c, storeId, runId);
    if (input.courierId !== undefined) {
      if (run.status !== 'planned' && run.status !== 'out') throw badRequest('run_closed', 'Essa saída já terminou.');
      await c.query('UPDATE delivery_runs SET courier_id = $2 WHERE id = $1', [runId, input.courierId]);
    }
    if (plan) {
      if (run.status !== 'planned') throw badRequest('run_started', 'O motoboy já saiu: não dá para mudar as paradas.');
      await loadOrders(c, storeId, input.orderIds!, runId, true);
      await c.query('UPDATE orders SET delivery_run_id = NULL WHERE delivery_run_id = $1 AND NOT (id = ANY($2::uuid[]))', [runId, plan.orderIds]);
      await writeStops(c, runId, plan);
    }
    return { number: run.number as number, routeBy: plan?.by, routeError: plan?.error ?? null };
  });
}

export async function cancelRun(c: PoolClient, storeId: string, runId: string) {
  const run = await lockRun(c, storeId, runId);
  if (run.status !== 'planned') throw badRequest('run_started', 'Só dá para desfazer uma saída antes do motoboy sair.');
  await c.query(`UPDATE delivery_runs SET status = 'cancelled', finished_at = now() WHERE id = $1`, [runId]);
  await c.query('UPDATE orders SET delivery_run_id = NULL WHERE delivery_run_id = $1', [runId]);
  return { number: run.number as number };
}

// Motoboy saiu: cada pedido vai para "Saiu para entrega" (o cliente recebe o aviso). Pedido cancelado no meio fica de fora.
export async function departRun(c: PoolClient, storeId: string, runId: string, userId: string) {
  const run = await lockRun(c, storeId, runId);
  if (run.status !== 'planned') throw badRequest('run_started', 'Essa saída já foi registrada.');
  if (!run.courier_id) throw badRequest('courier_required', 'Escolha o motoboy antes de registrar a saída.');
  const stops = (await c.query(
    `SELECT s.order_id, o.number, o.status FROM delivery_run_stops s JOIN orders o ON o.id = s.order_id WHERE s.run_id = $1 ORDER BY s.position FOR UPDATE OF o`,
    [runId],
  )).rows;
  const changed: { orderId: string; number: number; from: OrderStatus }[] = [];
  let live = 0;
  for (const s of stops) {
    if (s.status === 'cancelled' || s.status === 'completed') {
      await c.query(`UPDATE delivery_run_stops SET outcome = 'not_delivered', outcome_note = $3, outcome_at = now() WHERE run_id = $1 AND order_id = $2`,
        [runId, s.order_id, s.status === 'cancelled' ? 'pedido cancelado antes da saída' : 'pedido já concluído antes da saída']);
      if (s.status === 'cancelled') await c.query('UPDATE orders SET delivery_run_id = NULL WHERE id = $1', [s.order_id]);
      continue;
    }
    live++;
    if (canTransition(s.status, 'out_for_delivery')) {
      await changeStatus(c, storeId, s.order_id, 'out_for_delivery', userId, `Saída #${run.number}`);
      changed.push({ orderId: s.order_id, number: s.number, from: s.status });
    }
  }
  if (!live) throw badRequest('no_orders', 'Nenhum pedido desta saída pode sair (todos cancelados ou concluídos).');
  await c.query(`UPDATE delivery_runs SET status = 'out', departed_at = now() WHERE id = $1`, [runId]);
  return { number: run.number as number, changed };
}

// Baixa de cada parada. Entregue conclui o pedido; não entregue devolve o pedido para montar outra saída.
export async function stopOutcome(c: PoolClient, storeId: string, runId: string, orderId: string, outcome: 'delivered' | 'not_delivered', note: string, userId: string) {
  const run = await lockRun(c, storeId, runId);
  if (run.status !== 'out') throw badRequest('run_not_out', run.status === 'planned' ? 'Registre a saída do motoboy primeiro.' : 'Essa saída já terminou.');
  const s = (await c.query(
    `SELECT s.outcome, o.number, o.status FROM delivery_run_stops s JOIN orders o ON o.id = s.order_id WHERE s.run_id = $1 AND s.order_id = $2 FOR UPDATE OF s, o`,
    [runId, orderId],
  )).rows[0];
  if (!s) throw notFound('Parada');
  if (s.outcome) throw badRequest('stop_done', `O pedido #${s.number} já teve baixa nesta saída.`);
  if (outcome === 'not_delivered' && !note.trim()) throw badRequest('reason_required', 'Informe o motivo (ex.: cliente não atendeu).');
  let changed: { from: OrderStatus } | null = null;
  if (outcome === 'delivered') {
    if (s.status === 'cancelled') throw badRequest('order_closed', `O pedido #${s.number} foi cancelado.`);
    if (canTransition(s.status, 'completed')) {
      await changeStatus(c, storeId, orderId, 'completed', userId, `Entregue na saída #${run.number}`);
      changed = { from: s.status };
    }
  } else {
    await c.query('UPDATE orders SET delivery_run_id = NULL WHERE id = $1', [orderId]);
  }
  await c.query(`UPDATE delivery_run_stops SET outcome = $3, outcome_note = $4, outcome_at = now() WHERE run_id = $1 AND order_id = $2`, [runId, orderId, outcome, note.trim()]);
  return { number: s.number as number, changed };
}

// Motoboy voltou à loja. Toda parada precisa de baixa, para o tempo e o resultado de cada entrega ficarem certos.
export async function finishRun(c: PoolClient, storeId: string, runId: string) {
  const run = await lockRun(c, storeId, runId);
  if (run.status !== 'out') throw badRequest('run_not_out', run.status === 'planned' ? 'Registre a saída do motoboy primeiro.' : 'Essa saída já terminou.');
  const open = (await c.query(
    `SELECT o.number FROM delivery_run_stops s JOIN orders o ON o.id = s.order_id WHERE s.run_id = $1 AND s.outcome IS NULL ORDER BY s.position`,
    [runId],
  )).rows;
  if (open.length) throw badRequest('stops_open', `Dê baixa antes nos pedidos ${open.map((o) => '#' + o.number).join(', ')} (entregue ou não entregue).`);
  await c.query(`UPDATE delivery_runs SET status = 'done', finished_at = now() WHERE id = $1`, [runId]);
  return { number: run.number as number };
}

// Saídas com paradas e dados do pedido para a tela e para a mensagem do motoboy.
export async function listRuns(db: Db, storeId: string, where: string, params: unknown[]) {
  const { address } = await storeOrigin(db, storeId);
  const runs = (await db.query(
    `SELECT r.*, c.name AS courier_name, c.phone AS courier_phone FROM delivery_runs r LEFT JOIN couriers c ON c.id = r.courier_id
      WHERE r.store_id = $1 AND ${where} ORDER BY r.created_at DESC LIMIT 100`,
    [storeId, ...params],
  )).rows;
  if (!runs.length) return [];
  const stops = (await db.query(
    `SELECT s.run_id, s.position, s.leg_distance_m, s.leg_duration_s, s.outcome, s.outcome_note, s.outcome_at,
            o.id AS order_id, o.number, o.status, o.customer_name, o.customer_phone, o.street, o.street_number, o.complement, o.reference,
            o.neighborhood_name, o.city, o.cep, o.payment_method, o.change_for_cents, o.total_cents, o.delivery_fee_cents, o.created_at AS order_created_at
       FROM delivery_run_stops s JOIN orders o ON o.id = s.order_id WHERE s.run_id = ANY($1::uuid[]) ORDER BY s.position`,
    [runs.map((r) => r.id)],
  )).rows;
  return runs.map((r) => {
    const own = stops.filter((s) => s.run_id === r.id);
    // Previsão de chegada a cada parada: soma dos trechos desde a saída (sem o tempo parado em cada entrega).
    let acc = 0;
    const st = own.map((s) => {
      acc += s.leg_duration_s ?? 0;
      return {
        orderId: s.order_id, number: s.number, status: s.status, position: s.position, customerName: s.customer_name, customerPhone: s.customer_phone,
        street: s.street, streetNumber: s.street_number, complement: s.complement, reference: s.reference, neighborhood: s.neighborhood_name,
        paymentMethod: s.payment_method, changeForCents: s.change_for_cents, totalCents: s.total_cents, deliveryFeeCents: s.delivery_fee_cents,
        legDistanceM: s.leg_distance_m, legDurationS: s.leg_duration_s, etaOffsetS: s.leg_duration_s != null ? acc : null,
        outcome: s.outcome, outcomeNote: s.outcome_note, outcomeAt: s.outcome_at, orderCreatedAt: s.order_created_at,
        address: stopAddress(s, address),
      };
    });
    const pending = st.filter((s) => !s.outcome && s.status !== 'cancelled');
    return {
      id: r.id, number: r.number, status: r.status, courierId: r.courier_id, courierName: r.courier_name, courierPhone: r.courier_phone,
      routeBy: r.route_by, routeError: r.route_error, totalDistanceM: r.total_distance_m, totalDurationS: r.total_duration_s,
      createdAt: r.created_at, departedAt: r.departed_at, finishedAt: r.finished_at, stops: st,
      // Depois da saída, o link leva só às paradas que faltam.
      mapsUrl: mapsUrl((r.status === 'out' ? pending : st.filter((s) => s.status !== 'cancelled')).map((s) => s.address)),
    };
  });
}

export const ACTIVE_RUNS_WHERE = `r.status IN ${ACTIVE_RUN}`;
