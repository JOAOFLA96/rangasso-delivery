import type { FastifyInstance } from 'fastify';
import { config } from '../../config.js';

export async function adminMapRoutes(app: FastifyInstance) {
  // Fundo do mapa do painel: Google Maps quando há a chave do mapa (travada no endereço do site), senão OpenStreetMap.
  // É uma chave separada da GOOGLE_MAPS_API_KEY, que calcula a taxa de entrega e nunca vai para a página.
  app.get('/map', async () => {
    const key = config.GOOGLE_MAPS_BROWSER_KEY;
    return key ? { provider: 'google', key } : { provider: 'osm' };
  });
}
