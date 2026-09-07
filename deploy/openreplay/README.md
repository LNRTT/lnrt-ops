# Shared LNRT OpenReplay

Deployed on 2026-09-07 at **https://replay.lnrtdev.cz**. This is a separate
service from `@lnrt/ops`; applications install the tracker and configure their
own project. Docházka production is project `1`, preview is project `2`.
The initial owner is the existing OPS operator, using the existing OPS password.
OpenReplay account/password changes are independent after initialization.

## Deployment

Host: LNRT NetCup VPS (`159.195.82.254`, SSH port `2222`). Use the devbox broker:

```sh
srv 'SSH Key - Client lnrt' main@159.195.82.254 -p 2222
sudo -i
cd /data/openreplay/stack
```

The upstream sparse checkout is `/data/openreplay/upstream`, pinned to
`af5422d6806c433dbfbc71f9c2bea83e59c9a4b3`. The deployed stack derives from
`scripts/docker-compose` at that revision; `common.env` preserves its exact
component versions (v1.27.x), PostgreSQL 17, Valkey 8, ClickHouse 26.2 and RustFS
1.0.0-beta.1. Nginx is pinned to `1.28-alpine`.

`prepare.py` reproduces the infrastructure adaptations. It takes the upstream
Compose directory and an empty destination, creates random credentials locally
on the host, and never prints them. It deliberately refuses to overwrite an
existing stack. Do not use the upstream installer on this shared host: its Caddy
claims ports 80/443 and its database container names are global.

- Compose project `lnrt-openreplay`, isolated internal network and named volumes.
- Only Nginx joins the existing `coolify` proxy network. No host database, S3
  console or web ports are published. Traefik provides HTTPS/Let's Encrypt.
- `/etc/systemd/system/lnrt-openreplay.slice` caps the whole service at 7 GiB
  (6 GiB high watermark), 1 GiB swap and 4.5 CPUs. Containers also have individual
  memory limits and rotating logs (3 × 10 MB). Current idle usage is about 2.3 GiB.
- Services restart unless stopped. Schema migration jobs remain explicit and
  must exit zero; ClickHouse migration errors are not suppressed.
- Credentials are under `/data/openreplay/stack/common.env` and `docker-envs/`,
  protected by root-only parent directories. Never commit them or print expanded
  `docker compose config`. Use `docker compose config --quiet` to validate.
- The first tenant was provisioned before exposing the dashboard, with telemetry
  opted out. Further public tenant signup is refused by OpenReplay.
- Recording objects in `mobs`, `records` and `spots` expire after 30 days using
  S3 lifecycle rules. OPS error history is independent; an old replay link can
  outlive its recording. Shared assets and diagnostic database metadata are not
  included in that object expiration policy.

## Operations

```sh
docker compose ps
docker compose logs --tail 100 http-openreplay sink-openreplay storage-openreplay
docker compose up -d
systemctl status lnrt-openreplay.slice
```

Pull images serially (`COMPOSE_PARALLEL_LIMIT=1 docker compose pull`) because
anonymous parallel pulls from public ECR can hit rate limits. To upgrade, back up
configuration and the dedicated databases/volumes first, review upstream schema
changes, run the relevant migrations and verify a real new recording. Do not
rerun the initial SQL on an existing database. Do not run `down -v`.

A bootstrap bcrypt hash copied from Node must be compatible with PostgreSQL
`pgcrypto`: normalize the modern `$2b$` prefix to `$2a$` for OpenReplay's password
column. Verify `crypt` compatibility before declaring operator login configured.
No plaintext OPS password is needed or logged during provisioning.

## Host application and verification

Docházka uses `@lnrt/ops` 0.3.0 and tracker 18.1.5, with runtime configuration in
Coolify. Its repository contains the masked worker-only recording lifecycle,
24 real-SDK regression checks and an actual browser → ingest → OPS test.

The SDK has a pinned postinstall patch in the application: privateMode alone in
18.1.5 misses initial referrer/worker URL redaction, and stop() alone does not cancel
in-flight startup before the next page is captured. The patch addresses both.
Review that proof before adding another application; the library privacy preset
alone does not solve those upstream SDK bugs.

Disable an application by unsetting its `OPENREPLAY_PROJECT_KEY` and redeploying.
The existing OPS error reporter and attendance remain operational without replay.
Stop the entire service with `docker compose stop`; volumes remain intact.
