# Publicação em produção

Este guia coloca o sistema no ar num servidor próprio (VPS) com Docker. O HTTPS é automático (Caddy + Let's Encrypt). Nada aqui foi executado num servidor real ainda. Os passos foram validados localmente e no CI: a imagem é construída, o banco é migrado, o cardápio é servido e o primeiro administrador é criado.

## 1. O que você precisa providenciar

| Item | Observação |
| --- | --- |
| Servidor (VPS) Linux | Ubuntu 24.04 LTS, 2 GB de RAM, 1 vCPU e 25 GB de disco atendem bem um delivery de uma loja. Escolha um datacenter no Brasil (latência menor para clientes e para o agente). |
| Domínio | Por exemplo, `pedidos.rangasso.com.br`. Um registro **A** (e AAAA, se houver IPv6) aponta para o IP do servidor. |
| E-mail | Usado para o certificado HTTPS (avisos de expiração). |
| Local para backup fora do servidor | Google Drive, S3, Backblaze ou outro, via `rclone`. |

Os custos dependem do provedor e do plano: confira nos sites dos provedores na hora de contratar.

## 2. Preparar o servidor

```bash
# como root ou com sudo
apt update && apt -y upgrade
curl -fsSL https://get.docker.com | sh
ufw allow OpenSSH && ufw allow 80/tcp && ufw allow 443/tcp && ufw --force enable
mkdir -p /opt && cd /opt
git clone https://github.com/JOAOFLA96/rangasso-delivery.git rangasso
```

O repositório é privado. Para clonar, use uma *deploy key* de leitura ou um token de acesso pessoal com escopo mínimo. Não deixe esse token gravado em arquivos do servidor.

## 3. Configurar

```bash
cd /opt/rangasso/deploy
cp .env.example .env
openssl rand -hex 24   # cole em DB_PASSWORD
openssl rand -hex 32   # cole em IP_HASH_SECRET
nano .env              # preencha DOMAIN e ACME_EMAIL
chmod 600 .env
```

| Variável | Para que serve |
| --- | --- |
| `DOMAIN` | Endereço público, sem `https://` |
| `ACME_EMAIL` | E-mail do certificado HTTPS |
| `DB_PASSWORD` | Senha do PostgreSQL (só dentro do Docker; o banco não é exposto) |
| `IP_HASH_SECRET` | Segredo para guardar o IP do cliente apenas como hash (antiabuso, LGPD) |
| `STORE_SLUG` | Identificador da loja (padrão `rangasso`) |
| `SESSION_TTL_HOURS` | Duração do login no painel (padrão 12 h) |

## 4. Subir

```bash
docker compose up -d --build
docker compose ps          # db, app e caddy "running"/"healthy"
docker compose logs -f app # "migração aplicada" e "Server listening"
```

Acesse `https://SEU-DOMINIO/cardapio`. O primeiro acesso pode levar alguns segundos, enquanto o certificado é emitido.

## 5. Primeiro administrador

```bash
docker compose exec app node dist/scripts/create-admin.js --email voce@exemplo.com --name "João Paulo"
```

A senha é gerada e mostrada **uma única vez**. Entre em `https://SEU-DOMINIO/admin` e troque-a em **Configurações > Minha conta**. Depois, cadastre o resto da equipe em **Configurações > Usuários** (dono, gerente ou atendente).

## 6. Configurar a loja no painel (antes de divulgar o link)

1. **Dados da loja:** nome, telefone/WhatsApp, endereço, contato de privacidade (LGPD).
2. **Cardápio:** categorias, produtos, fotos, adicionais, promoções e estoque.
3. **Entrega e horários:** bairros atendidos com taxa, pedido mínimo, tempo estimado, funcionamento por dia, feriados e fechamentos, modo de abertura.
4. **Impressora:** conexão, nome ou IP, largura do papel e chave do agente (veja [AGENTE.md](AGENTE.md)).
5. Faça um pedido de teste pelo celular, acompanhe no painel e confira a comanda impressa.

Nenhum dado de demonstração entra em produção: o `seed-demo` se recusa a rodar com `NODE_ENV=production`.

## 7. Atualizar a versão

```bash
cd /opt/rangasso && git pull
cd deploy && ./backup.sh && docker compose up -d --build
```

As migrações de banco rodam sozinhas ao iniciar, em transação e com trava, de modo que duas instâncias não migram ao mesmo tempo. Faça a atualização fora do horário de pedidos.

## 8. Backup e restauração

- `deploy/backup.sh` gera `pg_dump` do banco e `.tar.gz` das fotos, com retenção de 30 dias (`KEEP_DAYS`).
- Agende diariamente no `crontab -e`:
  `30 4 * * * /opt/rangasso/deploy/backup.sh >> /var/log/rangasso-backup.log 2>&1`
- **Copie para fora do servidor.** Exemplo com rclone, já configurado:
  `45 4 * * * rclone sync /var/backups/rangasso remoto:rangasso-backups`
- Para restaurar: `deploy/restore.sh /var/backups/rangasso/db_AAAA-MM-DD_HHMM.dump`. Ele pede confirmação, porque substitui os dados atuais.
- **Teste a restauração** uma vez por mês num ambiente de homologação. Backup que nunca foi restaurado não é garantia.

## 9. Ambientes: desenvolvimento, homologação e produção

| Ambiente | Onde | Banco | Uso |
| --- | --- | --- | --- |
| Desenvolvimento | Computador do desenvolvedor | `rangasso_dev` local com `seed-demo` | Programar e testar |
| Homologação | Outro domínio (ex.: `teste.pedidos...`), mesmo `docker compose`, outro `.env` | Separado, pode receber cópia anonimizada | Testar versão nova e treinar equipe |
| Produção | Servidor principal | Separado, com backup diário | Clientes reais |

Nunca aponte homologação para o banco de produção. Cada ambiente tem suas próprias senhas, seu `IP_HASH_SECRET` e suas chaves de agente.

## 10. Rotina de LGPD

Pedidos finalizados há mais de 1 ano podem ter nome, telefone e endereço anonimizados. Os valores e itens são mantidos para o histórico financeiro.

```bash
docker compose exec app node dist/scripts/anonymize-old-orders.js --days 365 --dry-run   # mostra quantos
docker compose exec app node dist/scripts/anonymize-old-orders.js --days 365
```

O prazo deve ser definido pelo responsável da loja (com o contador). Ele deve constar na página de privacidade (`/cardapio/privacidade`).

## 11. Checklist de segurança

- [ ] `.env` com `chmod 600` e fora do Git.
- [ ] Somente as portas 22, 80 e 443 abertas (`ufw status`).
- [ ] Acesso SSH por chave; senha de root desativada.
- [ ] Senha inicial do admin trocada; um usuário por pessoa e sem senha compartilhada.
- [ ] Chave do agente revogada quando o computador da loja for trocado.
- [ ] Backup diário copiado para fora do servidor, com restauração testada.
- [ ] `docker compose pull && docker compose up -d --build` periodicamente, para atualizações de segurança das imagens.

## 12. Diagnóstico rápido

| Sintoma | Verifique |
| --- | --- |
| Site não abre | `docker compose ps`, DNS do domínio (`dig +short SEU-DOMINIO`), portas 80/443 |
| Certificado não sai | `docker compose logs caddy`: o DNS precisa já apontar para o servidor |
| Painel não atualiza sozinho | Proxy/antivírus da rede bloqueando SSE; o painel recarrega a lista ao reconectar |
| Pedidos não imprimem | Painel > Impressora: agente online? Fila? Veja [AGENTE.md](AGENTE.md) |
