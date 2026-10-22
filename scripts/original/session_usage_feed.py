"""All-sessions token feed (2026-10-21): per-API-call usage from Claude Code transcripts (~/.claude/projects/**/*.jsonl,
main + subagent), deduped by message.id (streamed lines repeat; keep the max-output copy). Writes session_calls.jsonl:
{t, model, in, out, cw, cr, src}. Calib calls come from calib_log*.jsonl separately (they never pass through transcripts)."""
import calendar, glob, json, os, time
U = os.path.expanduser('~/Agentic_Work/usage')
best = {}
for p in glob.glob(os.path.expanduser('~/.claude/projects/**/*.jsonl'), recursive=True):
    for l in open(p, errors='ignore'):
        if '"usage"' not in l: continue
        try: e = json.loads(l)
        except ValueError: continue
        m = e.get('message')
        if not isinstance(m, dict) or not isinstance(m.get('usage'), dict) or not m.get('model', '').startswith('claude-'): continue
        u = m['usage']; k = m.get('id') or (e.get('requestId'), e.get('timestamp'))
        rec = {'t': calendar.timegm(time.strptime(e['timestamp'][:19], '%Y-%m-%dT%H:%M:%S')), 'model': m['model'],
               'in': u.get('input_tokens') or 0, 'out': u.get('output_tokens') or 0,
               'cw': u.get('cache_creation_input_tokens') or 0, 'cr': u.get('cache_read_input_tokens') or 0,
               'src': os.path.relpath(p, os.path.expanduser('~/.claude/projects'))}
        if k not in best or rec['out'] >= best[k]['out']: best[k] = rec
with open(f'{U}/claude_estimator/session_calls.jsonl', 'w') as f:
    for r in sorted(best.values(), key=lambda r: r['t']): f.write(json.dumps(r) + '\n')
v = sorted(best.values(), key=lambda r: r['t'])
print(len(v), 'calls', time.strftime('%m-%d %H:%M', time.localtime(v[0]['t'])), '->', time.strftime('%m-%d %H:%M', time.localtime(v[-1]['t'])))
