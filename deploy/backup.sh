#!/usr/bin/env bash
# Backup diário do banco (pg_dump compactado) e das imagens do cardápio, com retenção.
# Agende no servidor (crontab -e):  30 4 * * * /opt/rangasso/deploy/backup.sh >> /var/log/rangasso-backup.log 2>&1
# Copie a pasta de backups para FORA do servidor (ex.: rclone para Google Drive/S3). Backup só no mesmo disco não protege contra perda do servidor.
set -euo pipefail
cd "$(dirname "$0")"
DEST="${BACKUP_DIR:-/var/backups/rangasso}"
KEEP_DAYS="${KEEP_DAYS:-30}"
STAMP="$(date +%Y-%m-%d_%H%M)"
mkdir -p "$DEST"
docker compose exec -T db pg_dump -U rangasso -d rangasso --format=custom --no-owner > "$DEST/db_$STAMP.dump.tmp"
mv "$DEST/db_$STAMP.dump.tmp" "$DEST/db_$STAMP.dump"
docker compose run --rm --no-deps -T -v "$DEST:/backup" --entrypoint sh app -c "tar -czf /backup/uploads_$STAMP.tar.gz -C /data uploads"
find "$DEST" -name 'db_*.dump' -mtime +"$KEEP_DAYS" -delete
find "$DEST" -name 'uploads_*.tar.gz' -mtime +"$KEEP_DAYS" -delete
echo "$(date -Is) backup ok: $DEST/db_$STAMP.dump ($(du -h "$DEST/db_$STAMP.dump" | cut -f1))"
