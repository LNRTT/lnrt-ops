#!/usr/bin/env python3
"""Prepare the pinned upstream Docker stack for LNRT's existing Traefik host.
Usage: prepare.py UPSTREAM_COMPOSE_DIR NEW_STACK_DIR
Requires PyYAML. Does not start services or initialize users/databases.
"""
from pathlib import Path
import os
import secrets
import shutil
import sys
import yaml

source, destination = map(Path, sys.argv[1:])
if destination.exists():
    raise SystemExit('Destination must not exist; refusing to overwrite credentials')
os.umask(0o077)
shutil.copytree(source, destination)
env = {}
for line in (destination / 'common.env').read_text().splitlines():
    if line and not line.startswith('#') and '=' in line:
        key, value = line.split('=', 1)
        env[key] = value
for key, value in env.items():
    if 'change_me' in value:
        env[key] = 'replay.lnrtdev.cz' if key == 'COMMON_DOMAIN_NAME' else secrets.token_hex(32)
(destination / 'common.env').write_text(''.join(f'{k}={v}\n' for k, v in env.items()))
(destination / 'common.env').chmod(0o600)
(destination / '.env').symlink_to('common.env')
for file in (destination / 'docker-envs').glob('*.env'):
    text = file.read_text()
    for key, value in env.items():
        text = text.replace('${' + key + '}', value)
    if 'change_me' in text:
        raise SystemExit(f'Unresolved placeholder in {file.name}')
    file.write_text(text)
    file.chmod(0o600)

file = destination / 'docker-compose.yaml'
compose = yaml.safe_load(file.read_text())
compose['name'] = 'lnrt-openreplay'
compose['services'].pop('caddy')
for name in ('caddy_data', 'caddy_config'):
    compose['volumes'].pop(name)
compose['networks']['coolify'] = {'external': True}
for name, service in compose['services'].items():
    service.pop('container_name', None)
    service.pop('ports', None)
    service['logging'] = {'driver': 'json-file', 'options': {'max-size': '10m', 'max-file': '3'}}
    if 'migration' in service.get('profiles', []):
        service['mem_limit'] = '512m'
    else:
        service.update(restart='unless-stopped', cpus=2, cgroup_parent='lnrt-openreplay.slice')
        service['mem_limit'] = {'clickhouse': '2g', 'postgresql': '768m', 'minio': '768m',
                                'chalice-openreplay': '1g'}.get(name, '384m')
compose['services']['minio']['environment']['RUSTFS_CONSOLE_ENABLE'] = 'false'
service = compose['services']['clickhouse-migration']
service['entrypoint'][-1] = service['entrypoint'][-1].replace(' || true', '')
service = compose['services']['nginx-openreplay']
service.update(image='nginx:1.28-alpine', networks=['openreplay-net', 'coolify'])
service['labels'] = {
    'traefik.enable': 'true', 'traefik.docker.network': 'coolify',
    'traefik.http.routers.lnrt-openreplay-http.entrypoints': 'http',
    'traefik.http.routers.lnrt-openreplay-http.rule': 'Host(`replay.lnrtdev.cz`)',
    'traefik.http.routers.lnrt-openreplay-http.middlewares': 'redirect-to-https',
    'traefik.http.routers.lnrt-openreplay-https.entrypoints': 'https',
    'traefik.http.routers.lnrt-openreplay-https.rule': 'Host(`replay.lnrtdev.cz`)',
    'traefik.http.routers.lnrt-openreplay-https.tls': 'true',
    'traefik.http.routers.lnrt-openreplay-https.tls.certresolver': 'letsencrypt',
    'traefik.http.services.lnrt-openreplay.loadbalancer.server.port': '80',
}
file.write_text(yaml.safe_dump(compose, sort_keys=False))
(destination / 'lnrt-openreplay.slice').write_text('''[Unit]
Description=LNRT OpenReplay resource budget
[Slice]
MemoryHigh=6G
MemoryMax=7G
MemorySwapMax=1G
CPUQuota=450%
''')
print('Prepared stack. Install the generated systemd slice before starting services.')
