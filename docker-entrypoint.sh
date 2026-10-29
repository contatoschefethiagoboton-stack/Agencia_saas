#!/bin/sh
# Sobe a API mesmo sem serviços externos configurados.
set -e

# Sem REDIS_URL: usa um Redis dentro do próprio container (cache/filas se perdem ao reiniciar).
if [ -z "$REDIS_URL" ]; then
  echo "[start] REDIS_URL não definida: usando Redis interno. Para produção, crie um Key Value no Render e defina REDIS_URL."
  redis-server --port 6379 --bind 127.0.0.1 --save '' --appendonly no --dir /tmp --daemonize yes
  export REDIS_URL=redis://127.0.0.1:6379
fi

node dist/migrate.js
exec "$@"
