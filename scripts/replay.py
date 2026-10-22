"""Replay the published logs against the 5-hour usage card with the locked per-cell rates.
Usage: python3 scripts/replay.py [LAG_SECONDS=180] [--no-sessions]
Per 5h window: bias/RMSE of (card - 0.5) - predicted at every card fetch; predicted = sum of calls finished <= fetch - LAG.
The card is an integer that appears to round up, hence -0.5."""
import csv, gzip, sys, time, calendar, collections
LAG = float(next((a for a in sys.argv[1:] if not a.startswith('-')), 180))
SINCE = 1792544400   # 2026-10-20 18:00 PDT: first window measured with the final harness
RATE = {  # card points per 1M tokens: uncached input, output, cache write (5m), cache read
    'opus':   [0.081, 18.8, 0.123, 0.0060],
    'haiku':  [0.164, 0.84, 0.205, 0.0041],
    'sonnet': [2.8, 12.5, 3.13, 0.064],   # not edge-locked
}
K = ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens']
rd = lambda f: csv.DictReader(gzip.open(f'data/{f}', 'rt'))
calls = []
for r in rd('calib_calls.csv.gz'):
    if float(r['t1']) > SINCE:
        m = r['model'].split('-')[1]; calls.append((float(r['t1']), m, sum(x * int(r[k]) / 1e6 for x, k in zip(RATE[m], K))))
if '--no-sessions' not in sys.argv:
    for r in rd('claude_code_session_calls.csv.gz'):
        m = r['model'].split('-')[1]
        if float(r['t']) > SINCE and m in RATE: calls.append((float(r['t']), m + '*', sum(x * int(r[k]) / 1e6 for x, k in zip(RATE[m], K))))
calls.sort()
win = collections.defaultdict(list)
for r in rd('usage_card.csv.gz'):
    if float(r['t']) < SINCE or not r['five_hour_resets']: continue
    w = round(calendar.timegm(time.strptime(r['five_hour_resets'][:16], '%Y-%m-%dT%H:%M')) / 600) * 600
    win[w].append((float(r['t']), int(r['five_hour_pct'])))
print(f'lag {LAG:.0f}s   window start (UTC)   fetches  card-range   bias   rmse   predicted pts by model (* = Claude Code sessions)')
for w, obs in sorted(win.items()):
    st = w - 5 * 3600; cs = [c for c in calls if st <= c[0] < w]
    res = [card - 0.5 - sum(c[2] for c in cs if c[0] <= t - LAG) for t, card in obs]
    by = collections.Counter()
    for c in cs: by[c[1]] += c[2]
    b = sum(res) / len(res); rm = (sum(x * x for x in res) / len(res)) ** .5
    print(f'{time.strftime("%m-%d %H:%M", time.gmtime(st)):>18} {len(obs):9} {min(o[1] for o in obs):5}-{max(o[1] for o in obs):<4} {b:+6.2f} {rm:6.2f}   '
          + ' '.join(f'{k} {v:.1f}' for k, v in sorted(by.items())))
