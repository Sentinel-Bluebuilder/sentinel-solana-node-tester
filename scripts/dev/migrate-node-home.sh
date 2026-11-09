#!/bin/bash
# ─── Move a dfe36c7 dvpnd node home to the cf4c372 layout (values kept) ───
#   sudo bash scripts/dev/migrate-node-home.sh <home>      (stop the node first)
# The devnet program was redeployed to cf4c372 on 2026-10-21. A cf4c372 dvpnd refuses the old
# node config ("hosts min=1") and, started on a data.db written by dfe36c7, spins a CPU core
# forever (old rows read back with zero timestamps; demo node, 2026-10-21). So:
#   - top-level config.toml: daemon pipe → endpoint; tx keys get their unit suffix
#   - node/config.toml: [api] addrs → hosts; [redeem] threshold → threshold_base_units;
#     [sessions] new names (idle_timeout ns → idle_seconds); [lease] min_prepay_seconds
#   - node/data.db* moved to node/db-pre-cf4c372/ (check `dvpnctl node positions` first:
#     every position should be redeemed — nothing in the old DB is owed)
# Backups: config.toml.pre-cf4c372, node/config.toml.pre-cf4c372. Running it twice is safe.
set -eu
H=${1:?usage: migrate-node-home.sh <home>}
[ -f "$H/node/config.toml" ] || { echo "no node config under $H" >&2; exit 1; }
if grep -q '^hosts = ' "$H/node/config.toml"; then echo "$H: already cf4c372"; exit 0; fi
cp -p "$H/config.toml" "$H/config.toml.pre-cf4c372"
cp -p "$H/node/config.toml" "$H/node/config.toml.pre-cf4c372"
sed -i -E 's/^pipe = /endpoint = /; s/^compute_unit_margin = /compute_unit_margin_percent = /; s/^loaded_data_limit = /loaded_data_limit_bytes = /; s/^max_priority_fee = /max_priority_fee_lamports = /; s/^priority_fee = /priority_fee_lamports = /' "$H/config.toml"
python3 - "$H/node/config.toml" <<'PY'
import re, sys
p = sys.argv[1]
s = open(p).read()
def section(name):
    return re.search(r'^\[' + re.escape(name) + r'\]\n(.*?)(?=^\[|\Z)', s, re.M | re.S)
def val(key, text, default):
    m = re.search(r'^' + key + r' = (.+)$', text, re.M)
    return m.group(1).strip() if m else default
def replace(name, body):
    global s
    m = section(name)
    block = '[' + name + ']\n' + body + '\n\n'
    s = s[:m.start()] + block + s[m.end():] if m else s.rstrip() + '\n\n' + block
api = section('api').group(1)
replace('api', 'hosts = %s\nport = %s' % (val('addrs', api, '[]'), val('port', api, '0')))
replace('lease', 'min_prepay_seconds = 3600')
red = section('redeem')
replace('redeem', 'threshold_base_units = %s' % val('threshold', red.group(1) if red else '', '10000000'))
ses = section('sessions')
st = ses.group(1) if ses else ''
idle = int(val('idle_timeout', st, '900000000000')) // 1_000_000_000
replace('sessions', 'heartbeat_seconds = 5\nidle_seconds = %d\nmax_peers = %s\nmin_prepay_bytes = %s\nmin_prepay_seconds = %s' % (
    idle, val('max_peers', st, '250'), val('prepay_min_bytes', st, '100000000'), val('prepay_min_seconds', st, '60')))
open(p, 'w').write(s.rstrip() + '\n')
PY
if ls "$H/node/data.db"* >/dev/null 2>&1; then
  mkdir -p "$H/node/db-pre-cf4c372"
  mv "$H/node/data.db"* "$H/node/db-pre-cf4c372/"
fi
echo "$H: migrated (backups *.pre-cf4c372, old DB in node/db-pre-cf4c372/)"
