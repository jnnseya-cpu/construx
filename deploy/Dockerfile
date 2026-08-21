# CONSTRUX.AI — one process, no build step, no runtime dependencies.
#
# There is nothing to compile. Node 22 strips the types at load, the frontend is
# plain ES modules, and the only npm packages in the tree are TypeScript and
# @types/node, which the running service never imports. So this is a single
# stage: a build stage would exist only to copy files into a stage that then
# copies them again.
#
# `npm ci --omit=dev` is still run rather than skipped, because it is what makes
# the absence provable: it installs the production dependency set, and if
# something ever gains a runtime dependency this image gets it rather than
# failing mysteriously at 3am.

FROM node:22.18-bookworm-slim

# tini reaps zombies and forwards signals. Without an init, SIGTERM reaches PID 1
# and Node's default handler is to ignore it — the platform's graceful shutdown,
# which closes the journal, would never run and every deploy would look like a
# crash.
RUN apt-get update \
 && apt-get install --no-install-recommends -y tini \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    PORT=8080 \
    LEDGER_JOURNAL_PATH=/data/ledger.jsonl

WORKDIR /srv

# Dependency manifests first, so a change to source does not invalidate the
# install layer.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY backend/ ./backend/
COPY frontend/ ./frontend/
COPY shared/ ./shared/
COPY tsconfig.json ./

# The journal's directory. Mount a volume here — without one the container is
# writable but ephemeral, and the record dies with it.
RUN mkdir -p /data && chown -R node:node /data /srv

# Never root. The service opens a socket and appends to one file; nothing it
# does needs more than that.
USER node

EXPOSE 8080

# Checks readiness rather than liveness: /healthz answers as soon as the process
# is up, which would report a container ready while it is still replaying the
# journal and answering "no such project" to everything.
HEALTHCHECK --interval=30s --timeout=4s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/readyz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "backend/src/main.ts"]
