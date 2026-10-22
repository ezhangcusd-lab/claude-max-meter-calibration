# Claude Max 5-hour usage meter: calibration data

How many "percent of the 5-hour limit" points does Claude Code use per million tokens, per model and per token kind?
This repo holds a 3-day measurement (2026-10-19 → 10-21, one Claude Max subscription) so others can repeat or extend it.

## Result: points of the 5-hour card per 1M tokens

| Model | Uncached input | Output | Cache write (5 min) | Cache read |
|---|---|---|---|---|
| Opus 5.5  | **0.081** | **18.8** | **0.123** | **0.0060** (cells 0.0065 / 0.0054) |
| Haiku 5.5 | **0.164** | **0.84** | **0.205** | **0.0041** |
| Sonnet 5.5 (not edge-locked) | ~2.8 | ~12.5 | 3.13 | 0.064 |

Edge-locked cells (card tick → card tick; start and end each pinned by a probe that makes the integer card tick):

| Cell | Card ticks | Points | Tokens of that kind | pts / 1M |
|---|---|---|---|---|
| Haiku uncached input | 21 → 37 | 16 | 97.2M | 0.165 |
| Haiku cache write | 37 → 54 | 17 | 83.0M | 0.205 |
| Opus uncached input | 54 → 73 | 19 | 233.0M | 0.082 |
| Opus output | 73 → 93 | 20 | 1.07M | 18.7 |
| Opus cache read | 3 → 18 | 15 | 2222.6M | 0.0065 |
| Haiku cache read | 19 → 36 | 17 | 4145.7M | 0.0041 |
| Haiku output | 37 → ~52.5 | 15.5 ± 0.5 | 18.50M | 0.84 |
| Opus cache read (recheck) | 2 → 12 | 10 | 1840.9M | 0.0054 |
| Opus cache write | 13 → [22, 23) | 9.5 ± 0.5 | 77.36M | 0.123 |

Pooled values (all burns, not only the locked span) agree within ~2% for uncached/write/output cells.

## How good is it

- Card increments vs. prediction over long spans: +91 vs +90.4 (ratio 1.006) and +37 vs +36.8 (1.005).
- Whole-window replay (`scripts/replay.py`), mean of (card − 0.5) − predicted: −0.03 to +2.75 points per daytime window, RMSE 1–3 points (billing lag of ~3–5 min during fast burns).
- The card is an integer that appears to round **up** (it shows 1% before any measurable usage).
- 1 Max card point ≈ 1/9.5 of a weekly point (8–11, inferred from one stretch).

## Open questions (help welcome)

1. **Overnight Opus.** In the 22:00–03:00 PDT window, Opus cache read/write billed ~0.89× the daytime rates (predicted 40.3 pts vs. ~22 observed in the first 36 min). Haiku in the same window matched daytime rates. Not resolved.
2. **Opus cache read** is the least stable cell (0.0065 vs 0.0054 between two runs).
3. Sonnet rates are ~10% high in replay (window ratio 0.899); not pursued.
4. Weekday-peak multipliers: none seen (Haiku uncached 0.165 at peak vs 0.164 off-peak; Opus uncached 0.082 vs 0.081).
5. Claude Code 1-hour cache writes are priced here as 5-minute writes (small effect in this data).

## Data (`data/`), all times Unix seconds UTC

- `calib_calls.csv.gz`: 376,069 burn API calls: model, kind of burn, token usage, plus the 5h/7d percent from response headers. Prompts were synthetic filler text; `ok=0 / empty-reply` calls are still billed and must be counted.
- `calib_events.jsonl`: harness events (card ticks typed in by the operator, step starts/ends, probe results).
- `usage_card.csv.gz`: the app's usage card read every ~10 s (5h %, weekly %, Fable weekly %, reset times).
- `claude_code_session_calls.csv.gz`: token counts of the operator's ordinary Claude Code calls in the same period (counts only, no content).

## Method

A Claude Code desktop mod (`scripts/original/register.tsx`) sends many parallel calls shaped to burn one token kind (e.g. 125k-token cached prompts with 1-token replies for cache read).
`calib_edge` pins each cell between two card ticks: probe until the card ticks, burn, wait 5 min for late billing, probe until it ticks again.
`replay_locked_rates.py` / `scripts/replay.py` check the rates against every card reading.
The scripts in `scripts/original/` are as-run (paths shortened) and depend on that mod harness; `scripts/replay.py` runs on this repo's data alone:

    python3 scripts/replay.py          # lag 180 s, with Claude Code session calls
    python3 scripts/replay.py 300 --no-sessions

The first window (10-21 00:00 UTC) started before the final harness and is not meaningful.
