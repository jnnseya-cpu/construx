# Extra gateway site blocks

The Caddyfile ends with `import /etc/caddy/conf.d/*.caddy`, and
`deploy/compose.gateway.yaml` mounts this directory into the gateway. A host
with nothing extra to serve leaves it empty — a glob matching nothing is not an
error, where a missing `import` file would be.

`deploy/demo-up.sh` writes `demo.caddy` here when it brings the public sandbox
up, and removing that file and reloading the gateway takes the sandbox off the
internet without touching the live site.

Nothing in here is committed (`.gitignore`), because a site block names one
deployment's real hostname. This file is the exception, so the directory
exists in a fresh checkout.
