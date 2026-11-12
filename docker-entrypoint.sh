#!/bin/sh
set -e

# /app/workplaces is often bind-mounted from the host. Bind mounts hide the
# pre-baked workspaces that were COPY'd into the image. Restore any missing
# baked workspaces from the backup copy.
if [ -d /app/.workplaces-baked ]; then
  mkdir -p /app/workplaces
  for src in /app/.workplaces-baked/*/; do
    [ -d "$src" ] || continue
    name=$(basename "$src")
    dest="/app/workplaces/$name"
    if [ -d "$dest" ]; then
      echo "[entrypoint] removing stale workspace $name"
      rm -rf "$dest"
    fi
    echo "[entrypoint] restoring baked workspace $name"
    cp -a "$src" "$dest"
  done
fi

# Ensure runtime directories are writable by the node user (uid 1000). If the
# host bind mount is owned by root, this chown makes runtime agent creation work.
chown -R node:node /app/workplaces /app/data /app/.pi 2>/dev/null || true

exec su-exec node "$@"
