"""Replay the calib logs against the 5h card using the 2026-10-21 locked-cell rates (pts per 1M tokens).
Per window: bias/RMSE of (card + 0.5) - predicted at each card fetch, predicted = sum of calls with t1 <= fetch - LAG.
Card is integer, rounded UP (2026-10-21 evidence: every window shows 1% before any logged usage), hence -0.5. SESSIONS=1 adds Claude Code transcript calls (model* in the by-model column); claude.ai chat stays unlogged."""
import calendar, glob, json, os, sys, time, collections
U = os.path.expanduser('~/Agentic_Work/usage')
LAG = float(sys.argv[1]) if len(sys.argv) > 1 else 180
SINCE = 1792544400   # 2026-10-20 18:00 PDT (start of the overnight top-up run)
K = ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens']
RATE = {   # locked cells (CALIBRATION_PLAN.md 2026-10-21); Sonnet = overnight direct, not locked
    'opus':   [0.081, 18.8, 0.123, 0.0060],
    'haiku':  [0.164, 0.84, 0.205, 0.0041],
    'sonnet': [2.8, 12.5, 3.13, 0.064],   # read = 47 pts / 737.9M (step 5, unlocked)
}

calls = []
for p in glob.glob(f'{U}/claude_estimator/calib_log*.jsonl'):
    for l in open(p):
        try: e = json.loads(l)
        except ValueError: continue
        if 'usage' in e and 'event' not in e and e.get('t1', 0) > SINCE:
            m = e['model'].split('-')[1]
            calls.append((e['t1'], m, sum(r * (e['usage'].get(k) or 0) / 1e6 for r, k in zip(RATE[m], K))))
if os.environ.get('SESSIONS'):   # all-sessions feed (analysis/session_usage_feed.py); 1h cache writes priced as 5m (TBD)
    for l in open(f'{U}/claude_estimator/session_calls.jsonl'):
        r = json.loads(l); m = r['model'].split('-')[1]
        if r['t'] > SINCE and m in RATE:
            calls.append((r['t'], m + '*', sum(x * r[k] / 1e6 for x, k in zip(RATE[m], ('in', 'out', 'cw', 'cr')))))
calls.sort()

win = collections.defaultdict(list)   # reset ts -> [(t, card)]
for l in open(f'{U}/claude_live_meter.jsonl'):
    try: d = json.loads(l)
    except ValueError: continue
    if d['t'] < SINCE: continue
    w = next((w for w in d['windows'] if w['kind'] == 'five_hour' and 'resetsAt' in w), None)
    if not w: continue
    r = round(calendar.timegm(time.strptime(w['resetsAt'][:16], '%Y-%m-%dT%H:%M')) / 600) * 600  # UTC; bucket the :59/:00 jitter
    win[r].append((d['t'], w['percentUsed']))

print(f'lag {LAG:.0f}s   window(local start)   n   card-range   bias(card-pred)   rmse   by-model pts')
for r, obs in sorted(win.items()):
    start = r - 5 * 3600
    cs = [c for c in calls if start <= c[0] < r]
    res = []
    for t, card in obs:
        pred = sum(c[2] for c in cs if c[0] <= t - LAG)
        res.append(card - 0.5 - pred)
    by = collections.Counter()
    for c in cs: by[c[1]] += c[2]
    b = sum(res) / len(res); rm = (sum(x * x for x in res) / len(res)) ** .5
    print(f'{time.strftime("%m-%d %H:%M", time.localtime(start)):>14} {len(obs):5} {min(o[1] for o in obs):3}-{max(o[1] for o in obs):<3} '
          f'{b:+8.2f} {rm:8.2f}   ' + ' '.join(f'{k} {v:.1f}' for k, v in sorted(by.items())))
