#!/bin/sh
set -eu

# Bring the public sandbox up, end to end, on the host that already runs the
# live platform.
#
# The sandbox existed as a compose file nobody had ever run, and the public
# demonstration page described it while `DEMONSTRATION_URL` was empty — so a
# visitor read that a sandbox was "kept separately", went looking, and found
# nothing. Reported in those words: *loaded demo accounts are nowhere to be
# found.* This is the missing half: the commands, in order, with the checks
# that stop the two deployments becoming one.
#
# ------------------------------------------------------------------ what it does
#
#   check the secret is not the live one   <- the one that matters
#        -> build and start the sandbox stack
#        -> wait for /readyz on its loopback port
#        -> write the gateway's site block and reload it
#        -> wait for https://<demo domain>/readyz
#        -> set DEMONSTRATION_URL on the live deployment and restart it
#
# Every step is idempotent. Running it twice rebuilds and re-checks; it does
# not create a second anything.
#
# --------------------------------------------------------------- before running
#
#   1. A DNS A record (and AAAA if the host has IPv6) for the sandbox hostname,
#      pointing at this host's address — the same address the live domain
#      points at. Caddy cannot be issued a certificate for a name that does not
#      resolve to it, and the reload below will report exactly that.
#
#   2. An `.env.demo` beside `.env`, with its OWN `GATEWAY_JWT_SECRET`:
#
#          cp .env.example .env.demo
#          printf 'GATEWAY_JWT_SECRET=%s\n' "$(openssl rand -hex 32)" >> .env.demo
#
#      A shared secret is refused below and it is not a formality. A token
#      minted for a fictional sandbox identity would verify on the live
#      platform, which is an authentication bypass built out of two correct
#      deployments.
#
# Usage, from the checkout root:
#
#     CONSTRUX_DEMO_DOMAIN=demo.example.com sh deploy/demo-up.sh
#
# Omit the variable and it defaults to `demo.` in front of CONSTRUX_DOMAIN.

APP_DIR="${CONSTRUX_APP_DIR:-$(pwd)}"
cd "$APP_DIR"

log() { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) demo-up: $*"; }
die() { log "FAILED: $*"; exit 1; }

# ------------------------------------------------------------------- settings

[ -f .env ] || die "no .env in $APP_DIR — run this from the deployment checkout"
[ -f .env.demo ] || die "no .env.demo. Copy .env.example to it and give it its own GATEWAY_JWT_SECRET — see the header of this file"

# Read a variable out of an env file without sourcing it. Sourcing would run
# whatever is in there, and these files hold secrets rather than script.
value_of() {
  sed -n "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*//p" "$2" 2>/dev/null | head -1 | tr -d '\r'
}

LIVE_DOMAIN="${CONSTRUX_DOMAIN:-$(value_of CONSTRUX_DOMAIN .env)}"
[ -n "$LIVE_DOMAIN" ] || die "CONSTRUX_DOMAIN is not set in .env and not in the environment"

DEMO_DOMAIN="${CONSTRUX_DEMO_DOMAIN:-demo.$LIVE_DOMAIN}"
DEMO_PORT="${CONSTRUX_DEMO_HOST_PORT:-8091}"
EDGE_NETWORK="${CONSTRUX_EDGE_NETWORK:-construx-edge}"
READY_TIMEOUT="${CONSTRUX_READY_TIMEOUT:-180}"

# Read by compose.demo.yaml, which sets the sandbox's own PUBLIC_BASE_URL from
# it — so every link the sandbox generates points at the sandbox rather than at
# the live platform.
export CONSTRUX_DEMO_DOMAIN="$DEMO_DOMAIN"

COMPOSE_DEMO="docker compose -f deploy/compose.demo.yaml --env-file .env.demo"

# ------------------------------------------------------- the check that matters

LIVE_SECRET="$(value_of GATEWAY_JWT_SECRET .env)"
DEMO_SECRET="$(value_of GATEWAY_JWT_SECRET .env.demo)"

[ -n "$DEMO_SECRET" ] || die ".env.demo has no GATEWAY_JWT_SECRET. Add one: printf 'GATEWAY_JWT_SECRET=%s\\n' \"\$(openssl rand -hex 32)\" >> .env.demo"

if [ "$DEMO_SECRET" = "$LIVE_SECRET" ]; then
  die "the sandbox and the live platform share a GATEWAY_JWT_SECRET.
        A session minted for a fictional sandbox identity would verify against
        the live platform. Give .env.demo its own:
          printf 'GATEWAY_JWT_SECRET=%s\\n' \"\$(openssl rand -hex 32)\" >> .env.demo"
fi

if [ "$DEMO_SECRET" = "construx-development-secret" ]; then
  die ".env.demo still carries the published development secret. Anyone who has read this repository can mint a session on it."
fi

# The sandbox is a sandbox because of two settings. Checked rather than assumed:
# an .env.demo copied from a live .env brings AI_MODE=production with it, and a
# sandbox open to the internet spending a real wallet is the one accident this
# whole arrangement exists to prevent. The compose file overrides both, so this
# is belt and braces — and it is the belt that has to hold.
DEMO_AI_MODE="$(value_of AI_MODE .env.demo)"
case "$DEMO_AI_MODE" in
  ''|local) ;;
  *) log "note: .env.demo sets AI_MODE=$DEMO_AI_MODE; compose.demo.yaml overrides it to local, so nothing is spent" ;;
esac

log "sandbox  : https://$DEMO_DOMAIN"
log "live     : https://$LIVE_DOMAIN"
log "container: construx-demo on 127.0.0.1:$DEMO_PORT"

# ------------------------------------------------------------------ the network

# The sandbox joins the edge network so the gateway can reach it by name. On a
# host running compose.gateway.yaml the gateway is on its own compose network
# instead, so the network may have to be created and the gateway attached — both
# are idempotent and both are cheap to get wrong silently, so both are done here.
if ! docker network inspect "$EDGE_NETWORK" >/dev/null 2>&1; then
  log "creating network $EDGE_NETWORK"
  docker network create "$EDGE_NETWORK" >/dev/null
fi

GATEWAY="$(docker ps --filter 'name=construx-gateway' --format '{{.Names}}' | head -1)"
[ -n "$GATEWAY" ] || die "no running container named construx-gateway. Bring the live stack up with compose.gateway.yaml first."

if ! docker network inspect "$EDGE_NETWORK" --format '{{range .Containers}}{{.Name}} {{end}}' | grep -q "$GATEWAY"; then
  log "attaching $GATEWAY to $EDGE_NETWORK"
  docker network connect "$EDGE_NETWORK" "$GATEWAY"
fi

# ------------------------------------------------------------------- the stack

log "building and starting the sandbox"
BUILD_COMMIT="$(git rev-parse HEAD 2>/dev/null || echo unknown)"
export BUILD_COMMIT
$COMPOSE_DEMO up -d --build

# Poll until it answers, or give up. A cold start replays the journal first.
i=0
until curl -fsS --max-time 5 "http://127.0.0.1:$DEMO_PORT/readyz" >/dev/null 2>&1; do
  i=$((i + 2))
  [ "$i" -lt "$READY_TIMEOUT" ] || {
    docker logs --tail 40 construx-demo 2>&1 | sed 's/^/    /' || true
    die "the sandbox did not become ready within ${READY_TIMEOUT}s"
  }
  sleep 2
done
log "sandbox answering on 127.0.0.1:$DEMO_PORT"

# ------------------------------------------------------------------ the gateway

# The site block, written where the Caddyfile's `import conf.d/*.caddy` will
# find it. Not in the Caddyfile itself: a block for a hostname with no DNS
# record makes Caddy ask for a certificate it cannot be issued, on every
# deployment that never wanted a sandbox.
mkdir -p deploy/conf.d
cat > deploy/conf.d/demo.caddy <<CADDY
# The public sandbox. Written by deploy/demo-up.sh — edit that, not this.
#
# A second deployment of the same image on a second hostname, with the seeded
# demonstration tenancy switched on and the AI on its local engines so a
# visitor spends nothing. Its own volume, its own journal and its own signing
# secret: nothing here can reach the live record.
$DEMO_DOMAIN {
	reverse_proxy construx-demo:8080 {
		header_up X-Forwarded-For {remote_host}
		header_up X-Forwarded-Proto {scheme}
		header_up X-Real-IP {remote_host}
		transport http {
			response_header_timeout 120s
		}
		lb_try_duration 30s
		lb_try_interval 500ms
		fail_duration 0s
	}

	encode zstd gzip

	header {
		Strict-Transport-Security "max-age=31536000; includeSubDomains"
		X-Content-Type-Options nosniff
		Referrer-Policy strict-origin-when-cross-origin
		-Server
		# Said on every response the sandbox serves, so a page from it is
		# identifiable as a sandbox page wherever it ends up — in a screenshot,
		# in a support ticket, in somebody's saved bookmark.
		X-Construx-Environment "sandbox"
	}

	log {
		output stdout
		format json
	}
}
CADDY
log "wrote deploy/conf.d/demo.caddy"

# Validate before reloading. A reload with a bad file leaves the *live* site on
# the old config, which is the safe failure — but it fails silently unless
# somebody looks, so it is checked here and reported.
if ! docker exec "$GATEWAY" caddy validate --config /etc/caddy/Caddyfile >/dev/null 2>&1; then
  docker exec "$GATEWAY" caddy validate --config /etc/caddy/Caddyfile 2>&1 | sed 's/^/    /' || true
  die "the gateway refused the configuration; the live site is untouched and still on the old one"
fi

log "reloading the gateway"
docker exec "$GATEWAY" caddy reload --config /etc/caddy/Caddyfile >/dev/null

# --------------------------------------------------------------- the front door

# A certificate has to be issued on first use, which takes a few seconds and
# needs the DNS record to already point here. This is the step that fails when
# the record is missing, so its message says so.
i=0
until curl -fsS --max-time 10 "https://$DEMO_DOMAIN/readyz" >/dev/null 2>&1; do
  i=$((i + 3))
  if [ "$i" -ge 60 ]; then
    log "WARNING: https://$DEMO_DOMAIN/readyz did not answer within 60s"
    log "         The container is healthy on its own port, so this is the name or the certificate."
    log "         Check the DNS record resolves to this host:"
    log "           dig +short $DEMO_DOMAIN"
    log "           curl -s ifconfig.me"
    log "         Then watch the gateway obtain the certificate:"
    log "           docker logs -f $GATEWAY"
    exit 3
  fi
  sleep 3
done
log "sandbox live on https://$DEMO_DOMAIN"

# ------------------------------------------------- tell the live site about it

# The last step, and the one whose absence started all this: the live platform
# has to know the address to send visitors to. Without it the demonstration page
# offers the guided session and the trial and does not mention a sandbox — which
# is correct, and is not what anybody wants once there is one.
CURRENT="$(value_of DEMONSTRATION_URL .env)"
WANTED="https://$DEMO_DOMAIN"

if [ "$CURRENT" = "$WANTED" ]; then
  log "DEMONSTRATION_URL already set; the live site is already pointing here"
else
  log "setting DEMONSTRATION_URL=$WANTED in .env"
  # Replace the line if it exists, append it if it does not. A backup, because
  # this edits the file the live deployment boots from.
  cp .env ".env.backup.$(date -u +%Y%m%dT%H%M%SZ)"
  if grep -q '^[[:space:]]*DEMONSTRATION_URL[[:space:]]*=' .env; then
    sed -i "s#^[[:space:]]*DEMONSTRATION_URL[[:space:]]*=.*#DEMONSTRATION_URL=$WANTED#" .env
  else
    printf '\n# The public sandbox, set by deploy/demo-up.sh.\nDEMONSTRATION_URL=%s\n' "$WANTED" >> .env
  fi

  log "restarting the live platform so it reads the new value"
  docker compose -f deploy/compose.yaml -f deploy/compose.gateway.yaml --env-file .env up -d
fi

log "done."
log "  sandbox   https://$DEMO_DOMAIN"
log "  demo page https://$LIVE_DOMAIN/demo   (now links to the sandbox)"
log ""
log "To take it down again:"
log "  rm deploy/conf.d/demo.caddy && docker exec $GATEWAY caddy reload --config /etc/caddy/Caddyfile"
log "  $COMPOSE_DEMO down"
log "  then clear DEMONSTRATION_URL from .env and restart the live stack"
