#!/bin/sh
# Fix Railway volume mount permissions (mounted as root, server runs as node)
chown -R node:node /app/audits 2>/dev/null || true
exec su -s /bin/sh node -c "node dist/pipeline-server-standalone.js"
