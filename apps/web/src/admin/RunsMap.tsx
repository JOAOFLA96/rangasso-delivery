import { useEffect, useRef } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

// Mapa da tela de Entregas: a loja, a rota de cada saída (traçado do Google) e as paradas numeradas, uma cor por motoboy.
// Fundo do OpenStreetMap (grátis, sem chave). Saída montada sem o Google não tem pontos e não aparece no mapa.

export interface MapRun {
  id: string; number: number; status: string; courierName: string | null; polyline: string | null;
  courierLocation?: { lat: number; lng: number; accuracyM: number | null; at: string } | null;
  stops: { orderId: string; number: number; position: number; customerName: string; lat: number | null; lng: number | null; outcome: string | null }[];
}
export const RUN_COLORS = ['#c2410c', '#1d4ed8', '#157f3b', '#7c3aed', '#b42318', '#0e7490', '#a16207', '#be185d'];

const esc = (t: string) => t.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const hhmm = (iso: string) => new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });

// Polyline codificada do Google (precisão 5).
export function decodePolyline(str: string): [number, number][] {
  const out: [number, number][] = [];
  let i = 0, lat = 0, lng = 0;
  while (i < str.length) {
    for (const k of [0, 1]) {
      let b, shift = 0, result = 0;
      do {
        b = str.charCodeAt(i++) - 63;
        result |= (b & 0x1f) << shift;
        shift += 5;
      } while (b >= 0x20);
      const d = result & 1 ? ~(result >> 1) : result >> 1;
      if (k === 0) lat += d;
      else lng += d;
    }
    out.push([lat / 1e5, lng / 1e5]);
  }
  return out;
}

export function RunsMap({ runs, store }: { runs: MapRun[]; store: { lat: number; lng: number } | null }) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const layer = useRef<L.LayerGroup | null>(null);

  useEffect(() => {
    if (!el.current || map.current) return;
    map.current = L.map(el.current, { scrollWheelZoom: false }).setView(store ? [store.lat, store.lng] : [-23.09, -47.21], 13);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap' }).addTo(map.current);
    layer.current = L.layerGroup().addTo(map.current);
    return () => {
      map.current?.remove();
      map.current = null;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const m = map.current;
    const g = layer.current;
    if (!m || !g) return;
    g.clearLayers();
    const bounds: L.LatLngExpression[] = [];
    if (store) {
      L.marker([store.lat, store.lng], { icon: L.divIcon({ className: 'rm-store', html: '🏠', iconSize: [28, 28] }), title: 'Loja' }).addTo(g);
      bounds.push([store.lat, store.lng]);
    }
    runs.forEach((r, i) => {
      const color = RUN_COLORS[i % RUN_COLORS.length];
      if (r.polyline) {
        const pts = decodePolyline(r.polyline);
        L.polyline(pts, { color, weight: 4, opacity: r.status === 'out' ? 0.9 : 0.6, dashArray: r.status === 'planned' ? '6 6' : undefined }).addTo(g);
      }
      for (const s of r.stops) {
        if (s.lat == null || s.lng == null) continue;
        const done = !!s.outcome;
        L.marker([s.lat, s.lng], {
          icon: L.divIcon({ className: 'rm-stop', html: `<span style="background:${done ? '#9a948f' : color}">${s.position}</span>`, iconSize: [26, 26] }),
          title: `#${s.number}`,
        }).bindTooltip(`Saída #${r.number} · ${esc(r.courierName ?? 'sem motoboy')}<br>${s.position}ª parada: pedido #${s.number} · ${esc(s.customerName)}${done ? ' (baixado)' : ''}`).addTo(g);
        bounds.push([s.lat, s.lng]);
      }
      // Onde o motoboy está agora (celular dele, durante a saída).
      const loc = r.courierLocation;
      if (loc && r.status === 'out') {
        const mins = Math.max(0, Math.round((Date.now() - new Date(loc.at).getTime()) / 60000));
        L.marker([loc.lat, loc.lng], {
          icon: L.divIcon({ className: `rm-courier${mins >= 3 ? ' stale' : ''}`, html: `<span style="border-color:${color}">🛵</span>`, iconSize: [34, 34] }),
          zIndexOffset: 1000,
          title: r.courierName ?? 'Motoboy',
        }).bindTooltip(`${esc(r.courierName ?? 'Motoboy')} · saída #${r.number}<br>Posição das ${hhmm(loc.at)}${mins >= 3 ? ` (há ${mins} min, sem sinal)` : ''}${loc.accuracyM ? ` · ±${loc.accuracyM} m` : ''}`).addTo(g);
        bounds.push([loc.lat, loc.lng]);
      }
    });
    if (bounds.length > 1) m.fitBounds(L.latLngBounds(bounds as L.LatLngTuple[]), { padding: [24, 24], maxZoom: 16 });
  }, [runs, store]);

  return <div ref={el} className="rm-map" role="img" aria-label="Mapa das rotas dos motoboys" />;
}
