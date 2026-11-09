#!/usr/bin/env python3
# ─── Load lab: node-side sampler (one JSON line per second) ───
# Runs on OUR lab node VM (never on a node another project runs) beside scripts/bwlab/load.mjs:
#   sudo python3 node-sampler.py --wan ens4 --out /var/tmp/sampler.jsonl [--seconds 3600]
# Per line: ts (epoch ms), CPU % per core and total (user+system+softirq split), per-process CPU %
# and RSS for every dvpnd and protocol server, memory available, conntrack entries, and NIC
# bytes / packets / drops per second on the WAN interface. Stops on SIGTERM or --seconds.
import argparse, json, os, signal, time

PROCS = ('dvpnd', 'openvpn', 'xray', 'v2ray', 'hysteria', 'hysteria2', 'wireguard-go', 'amneziawg-go', 'awg')
TICK = os.sysconf('SC_CLK_TCK')
PAGE = os.sysconf('SC_PAGE_SIZE')

def cpu_times():
    out = {}
    for line in open('/proc/stat'):
        if not line.startswith('cpu'):
            break
        p = line.split()
        v = list(map(int, p[1:9]))  # user nice system idle iowait irq softirq steal
        out[p[0]] = v
    return out

def proc_times():
    out = {}
    for pid in os.listdir('/proc'):
        if not pid.isdigit():
            continue
        try:
            comm = open(f'/proc/{pid}/comm').read().strip()
            if comm not in PROCS:
                continue
            st = open(f'/proc/{pid}/stat').read().rsplit(')', 1)[1].split()
            rss = int(st[21]) * PAGE
            out[pid] = (comm, int(st[11]) + int(st[12]), rss)  # utime + stime (ticks)
        except (FileNotFoundError, ProcessLookupError, IndexError, ValueError):
            continue
    return out

def nic(wan):
    base = f'/sys/class/net/{wan}/statistics/'
    return {k: int(open(base + k).read()) for k in ('rx_bytes', 'tx_bytes', 'rx_packets', 'tx_packets', 'rx_dropped', 'tx_dropped')}

def read_int(path):
    try:
        return int(open(path).read().split()[0])
    except (FileNotFoundError, ValueError, IndexError):
        return None

def mem_available():
    for line in open('/proc/meminfo'):
        if line.startswith('MemAvailable:'):
            return int(line.split()[1]) * 1024
    return None

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--wan', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--seconds', type=int, default=3600)
    a = ap.parse_args()
    stop = {'v': False}
    signal.signal(signal.SIGTERM, lambda *_: stop.__setitem__('v', True))
    signal.signal(signal.SIGINT, lambda *_: stop.__setitem__('v', True))
    c0, p0, n0, t0 = cpu_times(), proc_times(), nic(a.wan), time.time()
    end = t0 + a.seconds
    with open(a.out, 'a', buffering=1) as f:
        while not stop['v'] and time.time() < end:
            time.sleep(1)
            c1, p1, n1, t1 = cpu_times(), proc_times(), nic(a.wan), time.time()
            dt = t1 - t0
            cores = {}
            for k, v in c1.items():
                d = [x - y for x, y in zip(v, c0.get(k, v))]
                tot = sum(d) or 1
                cores[k] = {'busy': round(100 * (tot - d[3] - d[4]) / tot, 1), 'sys': round(100 * d[2] / tot, 1), 'softirq': round(100 * d[6] / tot, 1), 'steal': round(100 * d[7] / tot, 1)}
            procs = {}
            for pid, (comm, ticks, rss) in p1.items():
                prev = p0.get(pid)
                cpu = round(100 * (ticks - prev[1]) / TICK / dt, 1) if prev else None
                e = procs.setdefault(comm, {'n': 0, 'cpu': 0.0, 'rss': 0})
                e['n'] += 1
                e['cpu'] = round(e['cpu'] + (cpu or 0), 1)
                e['rss'] += rss
            line = {
                'ts': int(t1 * 1000),
                'cpu': cores.pop('cpu', None), 'cores': cores, 'procs': procs,
                'memAvail': mem_available(),
                'conntrack': read_int('/proc/sys/net/netfilter/nf_conntrack_count'),
                'nic': {k: round((n1[k] - n0[k]) / dt) for k in n1},
            }
            f.write(json.dumps(line) + '\n')
            c0, p0, n0, t0 = c1, p1, n1, t1

if __name__ == '__main__':
    main()
