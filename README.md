# Rangasso Delivery

Sistema de delivery do Rangasso ("Rango de Verdade"): cardápio público, painel administrativo e agente de impressão para Windows (Epson TM-T20).

| Componente | Pasta | Endereço |
| --- | --- | --- |
| API + banco (Node.js, Fastify, PostgreSQL) | `apps/api` | `/api/*` |
| Cardápio público e painel (React) | `apps/web` | `/cardapio` e `/admin` |
| Agente de impressão Windows | `apps/agent` | instalado no PC da loja |

## Documentação

- [Publicação em produção](docs/IMPLANTACAO.md): servidor, domínio, HTTPS, primeiro admin, backup, ambientes, LGPD
- [Agente de impressão](docs/AGENTE.md): instalação na loja, Epson TM-T20 USB/rede, diagnóstico
- [Testes](docs/TESTES.md): o que foi testado, resultados e roteiro de homologação no balcão
- [Limitações e pendências](docs/LIMITACOES.md)

## Desenvolvimento

Requisitos: Node.js 22+ e PostgreSQL 16.

```bash
npm ci
cp apps/api/.env.example apps/api/.env      # ajuste DATABASE_URL
npm -w apps/api run seed-demo               # dados de TESTE (não roda em produção)
npm -w apps/api run create-admin -- --email voce@exemplo.com --name "Seu nome"
npm -w apps/web run build && npm -w apps/api run build && npm -w apps/api start
# http://localhost:3000/cardapio  e  http://localhost:3000/admin
```

Testes: `npm -w apps/api test`, `npm -w apps/agent test`, `npm -w apps/agent run test:integration` (banco descartável `*_integ`) e `npx playwright test`.
