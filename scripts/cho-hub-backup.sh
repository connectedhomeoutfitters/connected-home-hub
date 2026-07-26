#!/bin/bash
# Production DB backup — reference copy of what's deployed on the VPS at
# /usr/local/bin/cho-hub-backup.sh, run daily (2:30am) by root's crontab:
#   30 2 * * * /usr/local/bin/cho-hub-backup.sh
# Uses MariaDB unix_socket auth (root, no password in the script). Keeps 14 days of
# gzipped, root-only dumps. To restore: gunzip -c <file> | mysql choHub
set -euo pipefail
DIR=/var/backups/cho-hub
STAMP=$(date +%F-%H%M%S)
FILE="$DIR/choHub-$STAMP.sql.gz"
mkdir -p "$DIR"
mysqldump --single-transaction --quick --routines --triggers --events choHub | gzip > "$FILE"; chmod 600 "$FILE"
# Retention: delete dumps older than 14 days
find "$DIR" -name 'choHub-*.sql.gz' -mtime +14 -delete
echo "$(date '+%F %T') backup ok -> $FILE ($(du -h "$FILE" | cut -f1))" >> "$DIR/backup.log"
