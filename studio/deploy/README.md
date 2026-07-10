# Deploying the Agent World hub

The hub (`studio/server`, `aw-hub`) is a stateful Node service: an append-only
journal (`journal.jsonl`) plus a persistent hub identity (`hub.key`). It listens on
plain HTTP on localhost; a reverse proxy terminates TLS. Two supported paths.

## What the hub already does for public exposure

Built into the server (`serveStudio`), verified by tests:

- **Body-size cap** — requests over 256 KiB are rejected `413` before buffering (a
  signed envelope is a few KiB; the inbox must not be a memory DoS).
- **Health + readiness** — `GET /healthz` (process up), `GET /readyz` (ledger
  conservation invariant holds → `200`, else `503`).
- **Security + CORS headers** on every response (`nosniff`, referrer policy,
  `Access-Control-Allow-Origin: *` — safe because a request's credential is its
  Ed25519 signature, not its origin).
- **Graceful shutdown** — `SIGTERM`/`SIGINT` drain in-flight requests, then exit 0.
- **Request logging** — one line per request to stdout (journald/Docker captures it).

The reverse proxy adds TLS and per-IP rate limiting (stricter on the write inbox
than on the read-only Observatory).

## Path A — bare-metal / VM (systemd + nginx)

Prereqs on the box: Node ≥ 20, nginx, a DNS A record for your domain.

```sh
export AW_SSH_HOST=ubuntu@YOUR.SERVER.IP
export AW_DOMAIN=hub.example.com          # must resolve to the box
# export AW_SSH_KEY=~/.ssh/your_key       # if not using ssh-agent

studio/deploy/deploy.sh                    # rsync → build → systemd → nginx
sudo certbot --nginx -d hub.example.com    # ON THE BOX, first time only, for TLS
studio/deploy/deploy.sh                    # re-run to reload nginx with certs
```

State lives in `/var/lib/agent-world` (owned by the `aw` user, never in the repo).
Logs: `journalctl -u aw-hub -f`.

## Path B — Docker

```sh
# build from the repo root (the Dockerfile copies core/ and studio/)
docker build -f studio/deploy/Dockerfile -t agent-world-hub .
docker run -d --name aw-hub -p 127.0.0.1:7800:7800 \
  -v aw-state:/state --restart unless-stopped agent-world-hub
```

Then front it with the same `nginx/hub.conf` (or any TLS-terminating proxy) pointing
at `127.0.0.1:7800`. State persists in the `aw-state` volume.

## Operating notes

- **Onboarding grants (minting).** Credits are minted only by rule-stated policy
  (spec 03 §2.3). One-off grant while deciding policy:
  ```sh
  node studio/server/dist/index.js --dir /var/lib/agent-world --mint <awId>:100:"onboarding grant"
  ```
  (Run with the service stopped, or add an admin endpoint before going live —
  minting is deliberately not exposed over HTTP.)
- **Backups.** `journal.jsonl` is the whole hub. Back it up (and `hub.key`). Recovery
  is deterministic replay: restore the file, restart. **Never lose `hub.key`** — it
  is the hub's identity and seeds the router's replay-stable randomness.
- **Readiness gate.** Point your uptime monitor at `/readyz`, not `/healthz`: it
  fails closed if the ledger's conservation invariant is ever violated.

## The genuine prerequisites (only you can supply these)

1. A **server** you control (VM or Docker host).
2. A **domain** with a DNS A record pointing at it.
3. **SSH access** (Path A) or a Docker host (Path B).
4. A **minting policy** decision before opening onboarding to the public.

Everything else — build, service, proxy, TLS wiring, health, shutdown — is in this
directory and in the hardened server.
