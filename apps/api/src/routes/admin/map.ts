import type { FastifyInstance } from 'fastify';
import { TilesUnavailable, googleTile, tilesStatus } from '../../services/mapTiles.js';

export async function adminMapRoutes(app: FastifyInstance) {
  // Qual fundo usar: o painel tenta o Google e, se ele falhar, troca sozinho para o OpenStreetMap.
  app.get('/map', async () => {
    const s = tilesStatus();
    return { provider: s.configured && !s.pausedUntil ? 'google' : 'osm', lastError: s.lastError };
  });

  // Um mapa aberto pede dezenas de pedaços, por isso o limite aqui é maior que o geral.
  app.get<{ Params: { z: string; x: string; y: string } }>(
    '/map/tiles/:z/:x/:y',
    { config: { rateLimit: { max: 1500, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const z = Number(req.params.z), x = Number(req.params.x), y = Number(req.params.y);
      const max = 2 ** z;
      if (![z, x, y].every(Number.isInteger) || z < 0 || z > 22 || x < 0 || y < 0 || x >= max || y >= max) {
        return reply.code(400).send({ error: { code: 'bad_tile', message: 'Pedaço do mapa inválido.' } });
      }
      try {
        const t = await googleTile(z, x, y);
        return reply.type(t.type).header('cache-control', t.cache).send(t.body);
      } catch (e) {
        const msg = e instanceof TilesUnavailable ? e.message : 'Google fora do ar';
        if (!(e instanceof TilesUnavailable)) req.log.warn({ err: e }, 'mapa do Google falhou');
        return reply.code(503).header('cache-control', 'no-store').send({ error: { code: 'map_unavailable', message: msg } });
      }
    },
  );
}
