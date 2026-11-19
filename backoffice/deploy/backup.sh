#!/bin/sh
# Nightly backup of the trace back-office: a custom-format dump of the database, then the blob
# folder, both into a restic repository (encrypted, deduplicated, off the server).
# Run as root from a systemd timer (OPERATIONS.md). Reads /etc/tars-backoffice/backup.env:
#   RESTIC_REPOSITORY, RESTIC_PASSWORD_FILE, and the store's own credentials if it needs any.
set -eu
set -a
. /etc/tars-backoffice/backup.env
set +a

dump=/var/lib/tars-backoffice/backup/db.dump
mkdir -p /var/lib/tars-backoffice/backup
chmod 700 /var/lib/tars-backoffice/backup
runuser -u postgres -- pg_dump --format=custom --dbname=tars_backoffice > "$dump.tmp"
mv "$dump.tmp" "$dump"

# Blobs never change once written, so each run sends only the new ones.
restic backup --tag tars-backoffice /var/lib/tars-backoffice/backup /var/lib/tars-backoffice/blobs
# Backups age out in 35 days, so a deletion reaches the backups within 35 days too.
restic forget --tag tars-backoffice --keep-daily 7 --keep-weekly 4 --keep-within 35d --prune
