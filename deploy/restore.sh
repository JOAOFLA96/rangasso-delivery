#!/usr/bin/env bash
# Restaura um backup do banco. APAGA os dados atuais do banco. Uso: ./restore.sh /var/backups/rangasso/db_AAAA-MM-DD_HHMM.dump
set -euo pipefail
cd "$(dirname "$0")"
FILE="${1:?informe o arquivo .dump}"
read -r -p "Isto substitui TODOS os dados atuais do banco por $FILE. Digite RESTAURAR para continuar: " ok
[ "$ok" = "RESTAURAR" ] || { echo "Cancelado."; exit 1; }
docker compose stop app
docker compose exec -T db pg_restore -U rangasso -d rangasso --clean --if-exists --no-owner < "$FILE"
docker compose start app
echo "Restaurado. Confira o painel."
