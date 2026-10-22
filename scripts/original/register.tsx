import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Calib, CodexView, Win } from '../types'

// Shared files written by ~/Agentic_Work/usage/usage_snapshot.py (Codex side) and by this mod (Claude side).
const U = '~/Agentic_Work/usage'
const PY = '/opt/anaconda3/bin/python3'
const PANE = 'usage-both'
const REFRESH_MS = 10 * 60 * 1000

const claude = atom({ plugin: 'usage-both', key: 'claude' } as const, [])
const claudeAt = atom({ plugin: 'usage-both', key: 'claudeAt' } as const, 0)
const codex = atom({ plugin: 'usage-both', key: 'codex' } as const, {})
const calib = atom({ plugin: 'usage-both', key: 'calib' } as const, { running: false, calls: 0 })

const LABEL: Record<string, string> = { five_hour: '5-hour', seven_day: 'weekly' }
const WINDOW_S: Record<string, number> = { five_hour: 5 * 3600, seven_day: 7 * 86400 }

function fmtLeft(sec: number): string {
  if (!(sec > 0)) return 'now'
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60)
  return d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m`
}
function pace(used: number, resetEpochS: number, windowS: number, nowS: number): string {
  const elapsed = Math.min(Math.max(1 - (resetEpochS - nowS) / windowS, 0), 1) * 100
  return used < elapsed - 10 ? 'under pace' : used > elapsed + 10 ? 'OVER pace' : 'on pace'
}

// ---- controlled calibration burn (the author authorized 2026-10-19: burn the rest of the Claude week for data) ----
// Phases isolate one cost type per model: output-heavy, uncached input, 5-minute cache write, cache read.
// Stops a 5-hour window at FIVE_H_CAP (waits for its reset), stops for good at WEEK_CAP or the weekly reset.
const CAL_DIR = `${U}/claude_estimator`
let CAL_LOG = `${CAL_DIR}/calib_log.jsonl`   // rotated: the engine's fs.write fails near 4 MiB, so parts stay under 3 MB
const MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5']   // most meter signal first
const KINDS = ['output', 'uncached', 'write', 'read']
// the author 2026-10-19: use the entire remaining week; 3 model lanes run simultaneously; cost types rotate every 30 points.
// Independent call slots (no batch barrier: a slow Opus call never idles the fast lanes); one controller checks caps.
// the author (11:1x): Haiku data first; whatever budget remains goes to Opus output and Opus cache reads.
// Single-model phases (time-based): even = Haiku-only on one cost type; odd = Opus-only, output / cache read alternating.
// Caps use the LIVE meter (claude_meter.jsonl, written by a separate Haiku session reading the app's usage card),
// falling back to session.usage (which only refreshes on this conversation's own responses).
const FIVE_H_CAP = 95, WEEK_CAP = 100, MAX_SLOTS = 40, CTL_MS = 5000
const METER = `${U}/claude_live_meter.jsonl`   // written by pollUsage() below (app usage tool, no model)
const GAP_MS = 4 * 60 * 1000, PHASE_MAX_MS = 40 * 60 * 1000   // quiet gap lets the lagging card (~90 s + 2-min steps) settle
const PTS_PER_USD = 2.36   // Haiku fit 2026-10-19 night: 5-hour points per API-price dollar (best lag 90 s)
const API: Record<string, Record<string, number>> = {   // $/M: input, output, cache read, 5-minute cache write
  'claude-haiku-5-5': { input_tokens: 0.10, output_tokens: 0.50, cache_read_input_tokens: 0.01, cache_creation_input_tokens: 0.125 },
  'claude-opus-5-5': { input_tokens: 4, output_tokens: 20, cache_read_input_tokens: 0.20, cache_creation_input_tokens: 5 } }
// the author 2026-10-19 night (v4): Haiku write 10 pts, Haiku read 500M tokens, Haiku output +12 pts, Opus output 2M tokens,
// Opus 5-min write 10 pts, then Opus uncached until the 5-hour cap ends the run (v5). Opus cache read skipped: this chat supplies it. Sonnet skipped. Opus read/uncached go to the next session limits.
// A step ends at its token target (tokens of its own cost type), or its point target (local estimate x measured ratio, or live meter).
type Step = { model: string; kind: string; slots: number; target: number; tokens?: number; fill?: boolean; meterOnly?: boolean; maxMs?: number; prefix?: number; manual?: boolean }
const H = 'claude-haiku-5-5', O = 'claude-opus-5-5', SN = 'claude-sonnet-5-5'
// 2026-10-20 morning (the author): gap-filling run. meterOnly steps end on the live-meter delta (target), token count or maxMs,
// never on the API-price estimate (it overpriced Opus input ~100x last night). Long steps so the ~2-min card lag washes out.
// 2026-10-20 18:50 (the author): steps cleared to the overnight top-up only; earlier steps live in register.tsx.bak-20261020-1840.
const STEPS: Step[] = [
  // 2026-10-20 18:40 (the author): overnight top-up so every model x kind has >=25 direct card pts (start: calib_start 1).
  // Targets = 25 - pts already measured. Slots sized so the ~2-min card lag overshoots by <=~2 pts.
  { model: O, kind: 'write', slots: 8, target: 8, meterOnly: true, maxMs: 60 * 60000 },
  { model: O, kind: 'read', slots: 40, target: 13, tokens: 6e9, meterOnly: true, maxMs: 150 * 60000 },
  { model: H, kind: 'output', slots: 40, target: 16, meterOnly: true, maxMs: 120 * 60000 },
  { model: H, kind: 'read', slots: 40, target: 16, tokens: 6e9, meterOnly: true, maxMs: 180 * 60000 },
  // 2026-10-20 22:55 (the author): Sonnet +25 each (to ~50 direct pts); was 19/22/22 over 60/90/120 min.
  { model: SN, kind: 'write', slots: 1, target: 44, meterOnly: true, maxMs: 150 * 60000 },
  { model: SN, kind: 'read', slots: 2, target: 47, tokens: 2e9, meterOnly: true, maxMs: 210 * 60000 },
  { model: SN, kind: 'output', slots: 4, target: 47, meterOnly: true, maxMs: 270 * 60000 },
  // 2026-10-20 22:50 (the author): steps 8-11 are manual-only (semi-manual edge-locking, 'start N only P' / 'probe N').
  // An auto run never advances into them; started directly they run alone. Targets are defaults for 'start N'.
  { model: O, kind: 'uncached', slots: 40, target: 25, meterOnly: true, maxMs: 120 * 60000, manual: true },
  { model: O, kind: 'output', slots: 8, target: 25, meterOnly: true, maxMs: 120 * 60000, manual: true },
  { model: H, kind: 'uncached', slots: 40, target: 25, meterOnly: true, maxMs: 120 * 60000, manual: true },
  { model: H, kind: 'write', slots: 40, target: 25, meterOnly: true, maxMs: 120 * 60000, manual: true }]
const TOKF: Record<string, string> = { write: 'cache_creation_input_tokens', read: 'cache_read_input_tokens', output: 'output_tokens', uncached: 'input_tokens' }
let stepTok = 0
const ratio: Record<string, number> = { [H]: 1, [O]: 1 }   // meter points / estimated points, updated after each gap
let stepIdx = 0, stepStart = 0, stepEst = 0, stepMeter0 = -1, gapUntil = 0, lastMeter = -1
// 2026-10-20 22:55: a step cut by the 95% pause keeps its progress (stepCarry) instead of rerunning its full target.
let stepCarry = 0, pendCarry = 0
// 2026-10-20 19:00: the card only changes when the app re-fetches (every 70-130 s; server delay ~0-10 s), so a fast step
// overshoots between fetches (Haiku write: +25 in 97 s). Predict the card between fetches from our own calls:
// predicted = last card + points of calls since the last fetch (fetch = resetsAt changes). Rates are measured pts per 1M
// tokens (CALIBRATION_PLAN.md, 2026-10-20 evening), the higher of step-delta and fit, so the guess errs high.
const RATE: Record<string, Record<string, number>> = {
  'claude-opus-5-5': { input_tokens: 0.081, output_tokens: 18.9, cache_read_input_tokens: 0.0041, cache_creation_input_tokens: 0.104 },
  'claude-haiku-5-5': { input_tokens: 0.188, output_tokens: 1.21, cache_read_input_tokens: 0.0045, cache_creation_input_tokens: 0.248 },
  'claude-sonnet-5-5': { input_tokens: 2.8, output_tokens: 13, cache_read_input_tokens: 0.103, cache_creation_input_tokens: 3.25 } }
let sinceFetchPts = 0, lastFetchRa = '', holding = false
// 2026-10-20 19:30 (the author): semi-manual edge-locking. 'start N only P' runs step N alone to +P predicted pts and stops;
// 'probe N [P]' burns ~P pts (default 0.1) of step N's model/kind; 'tick PCT' logs the moment the author saw the card tick.
let onlyOne = false, targetOverride = -1, runFirst = 0
const autoEnd = (i: number) => !STEPS[i] || (!!STEPS[i].manual && i !== runFirst)   // auto runs stop before manual steps
const tgt = (st: Step) => (targetOverride >= 0 ? targetOverride : st.target)
function ratePts(model: string, u: Record<string, number> | undefined): number {
  const r = RATE[model]; if (!u || !r) return 0
  let p = 0; for (const k in r) p += (u[k] || 0) * r[k] / 1e6
  return p
}
function plan(_p: number): { model: string; kind: string; slots: number } {
  const st = STEPS[stepIdx]
  return !st || gapUntil || autoEnd(stepIdx) ? { model: H, kind: 'gap', slots: 0 } : st
}
function estPts(model: string, u: Record<string, number> | undefined): number {
  if (!u) return 0
  const pr = API[model]; let usd = 0
  for (const k in pr) usd += (u[k] || 0) * pr[k] / 1e6
  return usd * PTS_PER_USD
}
const PREFIX: Record<string, number> = { 'claude-haiku-5-5': 30000, 'claude-sonnet-5-5': 60000, 'claude-opus-5-5': 60000 }  // ~2.1 real tokens per unit: haiku ~62K stays under its 100K tier
let stopFlag = false
const readCalls: Record<number, number> = {}, readHits: Record<number, number> = {}   // per step: guards read steps that never hit the cache
let loopAlive = false   // module-local: false after any reload, so a persisted running=true from a dead loop is detectable
let phaseIdx = 0, pausedUntil = 0, finished = false, nSeq = 0
let pending: string[] = []
let ctlTimer: { cancel?: () => void } | undefined

function filler(seed: number, tokens: number): string {
  const words = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india', 'juliet', 'kilo', 'lima',
    'mike', 'november', 'oscar', 'papa', 'quebec', 'romeo', 'sierra', 'tango', 'uniform', 'victor', 'whiskey', 'xray', 'yankee', 'zulu',
    'river', 'stone', 'cloud', 'signal', 'vector', 'matrix', 'kernel', 'buffer', 'packet', 'router']
  let x = (seed * 2654435761) >>> 0
  const out: string[] = []
  for (let i = 0; i < Math.floor(tokens * 0.75); i++) {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0
    out.push(words[x % words.length] + (x % 7 === 0 ? String(x % 1000) : ''))
  }
  return out.join(' ')
}
function request(model: string, kind: string, n: number, prefix?: number) {
  if (kind === 'output')
    return { model, maxTokens: 6000, prompt: `Write a long, detailed technical essay (essay ${n}) on digital circuit design topics. Keep writing until you run out of space.` }
  if (kind === 'uncached')
    return { model, maxTokens: 8, prompt: [{ text: `nonce ${n} ${Math.random()} ` + filler(n * 7 + 1, PREFIX[model]) }, { text: 'Reply with OK.' }] }
  if (kind === 'write')
    return { model, maxTokens: 8, prompt: [{ text: `nonce ${n} ${Math.random()} ` + filler(n * 7 + 3, PREFIX[model]), cache: true as const }, { text: 'Reply with OK.' }] }
  return { model, maxTokens: 8, prompt: [{ text: `fixed prefix for ${model} ` + filler(MODELS.indexOf(model) + 99 + (prefix ?? 0), prefix ?? PREFIX[model]), cache: true as const }, { text: `Reply with OK. (${n})` }] }
}
function win(rl: { kind: string; percentUsed: number; resetsAt?: string }[], kind: string) {
  return rl.find(w => w.kind === kind)
}
async function appendLines(path: string, $: EngineInterface, lines: string[]) {
  let prev = ''
  try { prev = await $.fs.read(path) } catch { prev = '' }
  await $.fs.write(path, prev + lines.join('\n') + '\n')
}
async function liveMeter($: EngineInterface, now: number): Promise<Win[] | undefined> {
  try {
    const txt = String(await $.fs.read(METER)).trimEnd(); const last = txt.slice(txt.lastIndexOf('\n') + 1)
    const o = JSON.parse(last)
    return now / 1000 - o.t < 90 ? o.windows : undefined   // fresh (< 90 s) readings only
  } catch { return undefined }
}
async function logLines($: EngineInterface, lines: string[]) {
  let prev = ''
  try { prev = await $.fs.read(CAL_LOG) } catch { prev = '' }
  if (prev.length > 3e6) { CAL_LOG = `${CAL_DIR}/calib_log_${Math.floor((await $.clock.now()) / 1000)}.jsonl`; prev = '' }
  await $.fs.write(CAL_LOG, prev + lines.join('\n') + '\n')
}
async function flush($: EngineInterface) {
  if (!pending.length) return
  const lines = pending; pending = []
  try { await logLines($, lines) } catch (err) { pending = lines.concat(pending); throw err }   // keep lines on failure
}
async function controller($: EngineInterface) {
  if (!stopFlag && !finished) { try { await $.fs.write(BEAT_FILE, String(await $.clock.now())) } catch { /* heartbeat is best-effort */ } }
  if (stopFlag || finished) { await flush($); return }
  const u = await $.session.usage(); const now = await $.clock.now()
  if (now - cardAt > 90000) await maybeRecord($, u.rateLimits)   // headers lag the card; use them only when the card is stale
  const live = await liveMeter($, now)
  const rl = live ?? u.rateLimits
  const fh = win(rl, 'five_hour'), wk = win(rl, 'seven_day')
  if (live && fh) {
    lastMeter = fh.percentUsed
    if (fh.resetsAt && fh.resetsAt !== lastFetchRa) { lastFetchRa = fh.resetsAt; sinceFetchPts = 0; if (holding) { holding = false; pausedUntil = 0 } }   // new server fetch: real value replaces the guess
  }
  const predicted = lastMeter >= 0 ? lastMeter + sinceFetchPts : -1
  let note: string | undefined = live ? undefined : 'live meter not fresh: caps use session.usage (may lag)'
  if (wk && (wk.percentUsed >= WEEK_CAP || (wk.resetsAt && now >= Date.parse(wk.resetsAt) - 60000))) {
    finished = true; loopAlive = false; note = `finished: weekly ${wk.percentUsed}% or weekly reset reached`
  } else if (fh && fh.percentUsed >= FIVE_H_CAP && fh.resetsAt) {
    if (stepStart && !gapUntil && stepMeter0 >= 0 && fh.percentUsed >= stepMeter0) pendCarry = fh.percentUsed - stepMeter0
    pausedUntil = Math.max(Date.parse(fh.resetsAt) + 90000, now + 60000); holding = false
    note = `paused: 5-hour at ${fh.percentUsed}% (cap ${FIVE_H_CAP}%), resuming after ${fh.resetsAt}`
    const fs = STEPS[stepIdx]
    if (fs?.fill) {                                          // a fill step ends at the cap; the next step waits for the reset
      await logLines($, [JSON.stringify({ t: now / 1000, event: 'step-end', step: stepIdx, model: fs.model, kind: fs.kind,
        estPts: stepEst, tokens: stepTok, meter0: stepMeter0, meter1: fh.percentUsed, ratio: ratio[fs.model] })])
      stepIdx += 1; stepStart = 0; stepCarry = 0; pendCarry = 0; stepEst = 0; stepTok = 0; stepMeter0 = -1; gapUntil = 0; phaseIdx = stepIdx
      if (autoEnd(stepIdx)) { finished = true; loopAlive = false; note = `finished: last fill step reached the 5-hour cap (${fh.percentUsed}%)` }
    }
  } else if (predicted >= FIVE_H_CAP && now >= pausedUntil) {   // predicted at the cap: hold until the next fetch shows the real value
    pausedUntil = now + 150000; holding = true
    note = `holding: predicted 5-hour ${predicted.toFixed(1)}% >= cap ${FIVE_H_CAP}% (card ${lastMeter}%), waiting for the next card fetch`
  } else if (now >= pausedUntil) { pausedUntil = 0; holding = false }
  const st = STEPS[stepIdx]
  if (autoEnd(stepIdx)) { finished = true; loopAlive = false; note = 'finished: all auto steps done' }
  else if (now < pausedUntil) { if (!holding) stepStart = 0 }   // a prediction hold keeps the step's baseline               // waiting for the 5-hour reset: step clock starts after it
  else if (gapUntil) {
    if (now >= gapUntil) {                                   // gap over: learn the model's ratio, start the next step
      if (stepMeter0 >= 0 && lastMeter >= 0 && stepEst > 0.5) ratio[st.model] = Math.max(0.2, (lastMeter - stepMeter0) / stepEst)
      await logLines($, [JSON.stringify({ t: now / 1000, event: 'step-end', step: stepIdx, model: st.model, kind: st.kind,
        estPts: stepEst, tokens: stepTok, meter0: stepMeter0, meter1: lastMeter, predicted, carry: stepCarry, ratio: ratio[st.model] })])
      gapUntil = 0; stepIdx += 1; stepStart = now; stepCarry = 0; pendCarry = 0; stepEst = 0; stepTok = 0; stepMeter0 = lastMeter; phaseIdx = stepIdx
    }
  } else {
    if (!stepStart) { stepStart = now; stepMeter0 = lastMeter; stepCarry += pendCarry; pendCarry = 0 }
    if (stepMeter0 < 0 && lastMeter >= 0) stepMeter0 = lastMeter   // 2026-10-20 14:2x: a run started before the first card read kept -1 and never hit its meter target
    const meterDone = stepMeter0 >= 0 && predicted - stepMeter0 + stepCarry >= tgt(st)   // predicted = card + calls since its last fetch
    const tokDone = st.tokens !== undefined && stepTok >= st.tokens
    const estDone = !st.meterOnly && stepEst * ratio[st.model] >= st.target
    if (tokDone || estDone || meterDone || now - stepStart >= (st.maxMs ?? PHASE_MAX_MS)) {
      if (onlyOne) {                                         // single-step mode: stop now, no gap, no next step
        await logLines($, [JSON.stringify({ t: now / 1000, event: 'step-end', step: stepIdx, model: st.model, kind: st.kind, only: true,
          estPts: stepEst, tokens: stepTok, meter0: stepMeter0, meter1: lastMeter, predicted, carry: stepCarry, target: tgt(st) })])
        finished = true; loopAlive = false; note = `single step ${stepIdx + 1} done: predicted +${(predicted - stepMeter0).toFixed(2)} pts; now probe to the next tick`
      } else gapUntil = now + GAP_MS
    }
  }
  if (finished) await $.fs.write(`${U}/claude_estimator/calib_done.txt`, `${new Date(now).toISOString()} ${note}\n`)
  const pl = plan(phaseIdx)
  const phase = `step ${stepIdx}/${STEPS.length} ${(STEPS[stepIdx]?.model || '').replace('claude-', '').replace('-5-5', '')}:${STEPS[stepIdx]?.kind || '-'}${gapUntil ? ' (quiet gap)' : ` x${pl.slots}`} est ${stepEst.toFixed(1)} pts, predicted card ${predicted.toFixed(1)}%`
  await update($, calib, (c: Calib) => ({ ...c, running: !finished, phase, note }))
  await flush($)
  if (finished) { loopAlive = false; ctlTimer?.cancel?.() }
}
async function worker($: EngineInterface, slot: number) {
  if (stopFlag || finished) return
  const now = await $.clock.now()
  if (now < pausedUntil) { $.clock.after(pausedUntil - now, () => { void worker($, slot) }); return }
  const pl = plan(phaseIdx), step = stepIdx
  if (slot >= pl.slots) { $.clock.after(2000, () => { void worker($, slot) }); return }   // slot idle in this phase
  if (pl.kind === 'read' && slot > 0 && !readCalls[step]) { $.clock.after(2000, () => { void worker($, slot) }); return }   // one warm-up call writes the cache before fan-out
  const cur = STEPS[step], pred = lastMeter >= 0 ? lastMeter + sinceFetchPts : -1
  // 2026-10-20 23:05: !stepStart = controller hasn't re-baselined the step yet (e.g. workers woke at pausedUntil first)
  if (!stepStart || gapUntil || (pred >= 0 && (pred >= FIVE_H_CAP || (cur && stepMeter0 >= 0 && pred - stepMeter0 + stepCarry >= tgt(cur))))) {
    $.clock.after(2000, () => { void worker($, slot) }); return   // predicted target/cap reached: no new call until the controller moves on
  }
  const n = nSeq++, t0 = await $.clock.now()
  let r: { isAnswered: boolean; usage?: Record<string, number>; reason?: string }
  try { r = await $.model.complete(request(pl.model, pl.kind, n, (pl as Step).prefix), { timeoutMs: 240000 } as never) as never }
  catch (err) { r = { isAnswered: false, reason: `error: ${String(err).slice(0, 160)}` } }   // e.g. limit reached: slot survives
  const t1 = await $.clock.now()
  const rl = (await $.session.usage()).rateLimits
  sinceFetchPts += ratePts(pl.model, r.usage)
  if (step === stepIdx) { stepEst += estPts(pl.model, r.usage); stepTok += (r.usage && r.usage[TOKF[pl.kind]]) || 0 }
  pending.push(JSON.stringify({ t0: t0 / 1000, t1: t1 / 1000, model: pl.model, kind: pl.kind, phase: step, ok: r.isAnswered,
    reason: r.isAnswered ? undefined : r.reason, usage: r.usage, rateLimits: rl }))
  await update($, calib, (c: Calib) => ({ ...c, calls: c.calls + 1 }))
  if (pl.kind === 'read') {
    readCalls[step] = (readCalls[step] || 0) + 1
    if ((r.usage?.cache_read_input_tokens || 0) > 0) readHits[step] = (readHits[step] || 0) + 1
    if (readCalls[step] >= 100 && !readHits[step] && !stopFlag) {   // 2026-10-20 noon: 3,936 Opus 'read' calls all wrote, none read
      stopFlag = true; loopAlive = false; ctlTimer?.cancel?.()
      pending.push(JSON.stringify({ t: t1 / 1000, event: 'no-cache-hits', step, calls: readCalls[step] })); await flush($); return
    }
  }
  const u = r.usage, spent = u && ((u.input_tokens || 0) + (u.output_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0)) > 0
  $.clock.after(r.isAnswered || spent ? 200 : 30000, () => { void worker($, slot) })   // back off only on calls that used nothing
}

const LIVE_KIND: Record<string, string> = { '5-hour limit': 'five_hour', 'Weekly · all models': 'seven_day', 'Weekly · Fable': 'seven_day_fable' }
let cardAt = 0   // last successful card read; while fresh, per-call rate-limit headers (which lag) don't overwrite the band
async function pollUsage($: EngineInterface) {
  // The app's own usage card, read through its MCP tool with the engine's connection: no model call, no login handling.
  let wins: Win[] = []
  try {
    const r = await $.mcp.call('ccd_session_mgmt', 'get_usage', {})
    const block = (r.content || []).find((c: { type?: string }) => c.type === 'text') as { text?: string } | undefined
    const j = JSON.parse(block?.text || '{}')
    if (!j.plan || j.plan.status !== 'ok') return
    wins = (j.plan.windows || []).filter((w: { label: string }) => LIVE_KIND[w.label])
      .map((w: { label: string; percentUsed: number; resetsAt?: string }) => ({ kind: LIVE_KIND[w.label], percentUsed: w.percentUsed, resetsAt: w.resetsAt }))
  } catch { return }
  if (!wins.length) return
  const now = await $.clock.now()
  cardAt = now
  await appendLines(METER, $, [JSON.stringify({ t: now / 1000, source: 'app usage card', windows: wins })])
  await maybeRecord($, wins.filter(w => w.kind !== 'seven_day_fable'))
}

async function maybeRecord($: EngineInterface, rl: Win[]) {
  if (!rl.length) return
  const cur: Win[] = await read($, claude)
  const key = (ws: Win[]) => ws.map(w => `${w.kind}:${w.percentUsed}:${w.resetsAt}`).sort().join('|')
  if (key(cur) !== key(rl)) await recordClaude($, rl.map(w => ({ kind: w.kind, percentUsed: w.percentUsed, resetsAt: w.resetsAt })))
}

async function recordClaude($: EngineInterface, wins: Win[]) {
  const now = await $.clock.now()
  await update($, claude, () => wins)
  await update($, claudeAt, () => now)
  const plan = {
    plan: 'Max', source: 'usage-both mod (session.measure)', recorded_epoch: now / 1000,
    recorded: new Date(now).toISOString(),
    windows: wins.map(w => ({ label: w.kind === 'five_hour' ? '5-hour limit' : w.kind === 'seven_day' ? 'Weekly · all models' : w.kind,
                              percentUsed: w.percentUsed, resetsAt: w.resetsAt })),
  }
  await $.fs.write(`${U}/claude_plan.json`, JSON.stringify(plan, null, 1))
  const log = `${U}/claude_ticks.jsonl`   // calibration history for the Claude estimator
  let prev = ''
  try { prev = await $.fs.read(log) } catch { prev = '' }
  await $.fs.write(log, prev + JSON.stringify({ t: now / 1000, windows: wins }) + '\n')
  await showStatus($)
}

async function refreshCodex($: EngineInterface) {
  const now = await $.clock.now()
  const r = await $.process.run([PY, `${U}/usage_snapshot.py`, '--quiet', '--estimate'], { timeoutMs: 90000 })
  if (r.exitCode !== 0) {
    await update($, codex, (c: CodexView) => ({ ...c, error: (r.stderr || r.stdout).slice(-240), refreshedAt: now }))
    return
  }
  const j = JSON.parse(await $.fs.read(`${U}/usage.json`))
  const line = String(await $.fs.read(`${U}/estimator/estimate_now.txt`)).trim()
  const m = line.match(/([0-9]+(?:\.[0-9]+)?)%/)
  let claudeEst = ''
  try { claudeEst = String(await $.fs.read(`${U}/claude_estimator/estimate_now.txt`)).trim() } catch { claudeEst = '' }
  const pr = (j.codex_limits && j.codex_limits.primary) || {}
  await update($, codex, () => ({
    estimatePct: m ? Number(m[1]) : undefined, estimateLine: line, usedPct: pr.used_percent,
    resetsAt: pr.resets_at, windowMin: pr.window_minutes,
    credits: j.codex_limits && j.codex_limits.credits ? j.codex_limits.credits.balance : undefined,
    plan: j.codex_limits ? j.codex_limits.plan_type : undefined, refreshedAt: now, claudeEst,
  }))
  await showStatus($)
}

async function probe($: EngineInterface, si: number, pts: number): Promise<string> {
  const st = STEPS[si]; let got = 0, calls = 0, tok = 0, wave = 1
  while (got < pts && calls < 2000) {                    // first wave = 1 call (sizes the rest, warms a read cache)
    const rs = await Promise.all(Array.from({ length: wave }, async () => {
      const n = nSeq++, t0 = await $.clock.now()
      let r: { isAnswered: boolean; usage?: Record<string, number>; reason?: string }
      try { r = await $.model.complete(request(st.model, st.kind, n, st.prefix), { timeoutMs: 240000 } as never) as never }
      catch (err) { r = { isAnswered: false, reason: `error: ${String(err).slice(0, 160)}` } }
      pending.push(JSON.stringify({ t0: t0 / 1000, t1: (await $.clock.now()) / 1000, model: st.model, kind: st.kind, phase: si, probe: true,
        ok: r.isAnswered, reason: r.isAnswered ? undefined : r.reason, usage: r.usage }))
      return r }))
    for (const r of rs) { const p = ratePts(st.model, r.usage); got += p; sinceFetchPts += p; calls += 1; tok += (r.usage && r.usage[TOKF[st.kind]]) || 0 }
    if (got <= 0) break                                  // nothing billed (limit reached?): don't loop
    wave = Math.max(1, Math.min(16, Math.ceil((pts - got) / (got / calls))))
  }
  pending.push(JSON.stringify({ t: (await $.clock.now()) / 1000, event: 'probe', step: si, calls, tokens: tok, predictedPts: got }))
  await flush($)
  return `probe step ${si + 1} (${st.model.replace('claude-', '')} ${st.kind}): ${calls} calls, ${(tok / 1e6).toFixed(2)}M tok, ~${got.toFixed(3)} pts. Refresh the card: no tick -> probe again; tick -> /claude-calibrate tick <new %>`
}
async function startRun($: EngineInterface, first: number) {
  stopFlag = false; finished = false; phaseIdx = 0; pausedUntil = 0; onlyOne = false; targetOverride = -1; sinceFetchPts = 0; lastFetchRa = ''; holding = false; stepIdx = first; runFirst = first; stepStart = 0; stepCarry = 0; pendCarry = 0; stepEst = 0; stepTok = 0; stepMeter0 = -1; gapUntil = 0; nSeq = Math.floor((await $.clock.now()) / 1000)
  loopAlive = true
  const now = await $.clock.now()
  await update($, calib, () => ({ running: true, calls: 0, startedAt: now, phase: 'starting' }))
  await controller($)                                   // caps checked before any call is made
  ctlTimer = $.clock.every(CTL_MS, () => { void controller($) }) as never
  for (let k = 0; k < MAX_SLOTS; k++) $.clock.after(k * 150, () => { void worker($, k) })
}
// File trigger (plain program, no slash command needed): `usage/bin/calib_start [N]` writes a step number here;
// the 30-s meter timer starts the run at that step if none is running, then clears the file.
const START_FILE = `${U}/claude_estimator/calib_start.txt`
const BEAT_FILE = `${U}/claude_estimator/calib_heartbeat.txt`   // controller writes every 5 s; fresh = a run is alive in some session
const VER_FILE = `${U}/claude_estimator/calib_mod_version.txt`   // lets job control see which mod build the app has loaded
async function calibCmd($: EngineInterface, arg: string): Promise<string> {
  const c: Calib = await read($, calib)
  if (arg === 'start' || /^start \d+$/.test(arg)) {
    const first = arg === 'start' ? 0 : Math.max(0, Math.min(STEPS.length - 1, Number(arg.split(' ')[1]) - 1))   // 'start 2' = begin at step 2
    if (c.running && loopAlive) return `Calibration already running (${c.phase}, ${c.calls} calls).`
    await startRun($, first)
    return `Calibration started at step ${first + 1} of ${STEPS.length} (auto 1-7: Opus write/read, Haiku output/read, Sonnet write/read/output; manual-only 8-11: Opus uncached/output, Haiku uncached/write), 4-min quiet gap after each; 5-hour cap ${FIVE_H_CAP}% on the live meter. Done marker: ${U}/claude_estimator/calib_done.txt. Log: ${CAL_LOG}`
  }
  let m = /^start (\d+) only ([\d.]+)$/.exec(arg)
  if (m) {
    if (c.running && loopAlive) return `Calibration already running (${c.phase}).`
    const si = Math.max(0, Math.min(STEPS.length - 1, Number(m[1]) - 1))
    await startRun($, si); onlyOne = true; targetOverride = Number(m[2])
    return `Single step ${si + 1} started: stops at predicted +${m[2]} pts (no gap, no next step). Then probe to the tick.`
  }
  m = /^probe (\d+)(?: ([\d.]+))?$/.exec(arg)
  if (m) {
    if (c.running && loopAlive) return 'A run is active; stop it before probing.'
    return await probe($, Math.max(0, Math.min(STEPS.length - 1, Number(m[1]) - 1)), Number(m[2] ?? 0.1))
  }
  m = /^tick (\d+)$/.exec(arg)
  if (m) {
    pending.push(JSON.stringify({ t: (await $.clock.now()) / 1000, event: 'tick', pct: Number(m[1]), source: 'the author saw card' })); await flush($)
    return `tick ${m[1]}% logged at ${new Date(await $.clock.now()).toLocaleTimeString()}`
  }
  if (arg === 'stop') { stopFlag = true; loopAlive = false; ctlTimer?.cancel?.(); await flush($); return 'Stopping: in-flight calls finish, no new ones start.' }
  return `Calibration: ${c.running ? 'running' : 'idle'}, phase ${c.phase ?? '—'}, ${c.calls} calls${c.note ? ', ' + c.note : ''}`
}

async function checkStartFile($: EngineInterface) {
  try { await $.fs.write(VER_FILE, 'overnight-v8') } catch { /* best-effort */ }
  let t = ''
  try { t = String(await $.fs.read(START_FILE)).trim() } catch { return }
  if (!t) return
  await $.fs.write(START_FILE, '')
  let beat = 0
  try { beat = Number(String(await $.fs.read(BEAT_FILE)).trim()) || 0 } catch { beat = 0 }
  const busy = loopAlive || (await $.clock.now()) - beat < 60000
  if (!/^\d+$/.test(t)) {   // 2026-10-21 v8: calib_edge sends 'probe N P' / 'tick PCT' / 'start N only P' through this file
    const result = /^tick /.test(t) || !busy ? await calibCmd($, t) : 'ignored: a run is alive'
    await logLines($, [JSON.stringify({ t: (await $.clock.now()) / 1000, event: 'file-cmd', cmd: t, result })]); return
  }
  if (busy) { await logLines($, [JSON.stringify({ t: (await $.clock.now()) / 1000, event: 'start-file-ignored', reason: 'already running' })]); return }
  const first = Math.max(0, Math.min(STEPS.length - 1, (Number(t) || 1) - 1))
  await logLines($, [JSON.stringify({ t: (await $.clock.now()) / 1000, event: 'start-file', step: first + 1 })])
  await startRun($, first)
}
async function showStatus($: EngineInterface) {
  const c: Win[] = await read($, claude)
  const x: CodexView = await read($, codex)
  const parts = c.filter(w => LABEL[w.kind]).map(w => `${LABEL[w.kind]} ${w.percentUsed}%`)
  const cx = x.estimatePct !== undefined ? `Codex ${x.estimatePct.toFixed(1)}%` : x.usedPct !== undefined ? `Codex ${x.usedPct}%` : ''
  const cb: Calib = await read($, calib)
  const cal = cb.running ? `calib ${cb.phase} (${cb.calls})` : ''
  await $.ui.status([parts.length ? `Claude ${parts.join(' · ')}` : '', cx, cal].filter(Boolean).join(' | ') || undefined)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'usage-both', description: 'Show remaining Claude + OpenAI/Codex usage in a pane' })
    await $.command.register({ name: 'claude-calibrate', description: 'Controlled usage burn for the Claude estimator: start [N] | start N only P | probe N [P] | tick PCT | stop | status' })
    const u = await $.session.usage()
    if (u.rateLimits.length) await recordClaude($, u.rateLimits.map(w => ({ kind: w.kind, percentUsed: w.percentUsed, resetsAt: w.resetsAt })))
    void refreshCodex($)
    $.clock.every(REFRESH_MS, () => { void refreshCodex($) })   // plain code, no model calls
    void pollUsage($)
    $.clock.every(10000, () => { void pollUsage($); void checkStartFile($) })   // live app meter every 10 s: plain code, no model
    void $.ui.open({ id: PANE, title: 'Usage: Claude + OpenAI' })
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('rateLimits') && e.rateLimits.length && (await $.clock.now()) - cardAt > 90000)
      await recordClaude($, e.rateLimits.map(w => ({ kind: w.kind, percentUsed: w.percentUsed, resetsAt: w.resetsAt })))
    return next(e)
  })

  on('command.run', { command: 'claude-calibrate' }, async ($, e) => ({ text: await calibCmd($, String((e as { args?: string }).args || 'status').trim()) }))

  on('command.run', { command: 'usage-both' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Usage: Claude + OpenAI' })
    await pollUsage($)
    await refreshCodex($)
    const x: CodexView = await read($, codex)
    return { text: x.error ? `Usage pane opened; Codex refresh failed: ${x.error}` : 'Usage pane opened.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const nowS = (await $.clock.now()) / 1000
    const c: Win[] = await read($, claude)
    const cAt: number = await read($, claudeAt)
    const x: CodexView = await read($, codex)
    const rows: { head?: boolean; text: string; dim?: boolean }[] = []
    rows.push({ head: true, text: 'Claude (Max) — used · left · resets · pace' })
    if (!c.length) rows.push({ dim: true, text: '  no reading yet (arrives with the next response)' })
    for (const w of c) {
      const r = w.resetsAt ? Date.parse(w.resetsAt) / 1000 : 0
      const win = WINDOW_S[w.kind]
      rows.push({ text: `  ${(LABEL[w.kind] || w.kind).padEnd(8)} ${w.percentUsed.toFixed(1).padStart(5)}% · ${(100 - w.percentUsed).toFixed(1).padStart(5)}% left · ${r ? fmtLeft(r - nowS) : '?'}${r && win ? ' · ' + pace(w.percentUsed, r, win, nowS) : ''}` })
    }
    if (x.claudeEst) for (const part of x.claudeEst.split(' · ')) rows.push({ dim: true, text: `  est. ${part.replace('Claude ', '')}` })
    rows.push({ text: '' })
    rows.push({ head: true, text: `OpenAI / Codex (${x.plan || '?'}) — weekly` })
    if (x.estimatePct !== undefined || x.usedPct !== undefined) {
      const used = x.estimatePct !== undefined ? x.estimatePct : (x.usedPct as number)
      const win = (x.windowMin || 10080) * 60
      rows.push({ text: `  estimate ${used.toFixed(2).padStart(6)}% · ${(100 - used).toFixed(2)}% left · ${x.resetsAt ? fmtLeft(x.resetsAt - nowS) : '?'}${x.resetsAt ? ' · ' + pace(used, x.resetsAt, win, nowS) : ''}` })
      rows.push({ dim: true, text: `  official whole %: ${x.usedPct ?? '?'} · error ±0.14 pp median (held-out)${x.credits ? ` · credits ${Number(x.credits).toFixed(0)}` : ''}` })
    } else rows.push({ dim: true, text: '  refreshing…' })
    if (x.error) rows.push({ dim: true, text: `  last refresh failed: ${x.error}` })
    rows.push({ text: '' })
    rows.push({ dim: true, text: `updated: Claude ${cAt ? fmtLeft(nowS - cAt / 1000) + ' ago' : '—'} · Codex ${x.refreshedAt ? fmtLeft(nowS - x.refreshedAt / 1000) + ' ago' : '—'} · /usage-both refreshes` })
    return (
      <Box flexDirection="column">
        {rows.map(r => (r.head ? <Text bold>{r.text}</Text> : <Text dimColor={!!r.dim}>{r.text}</Text>))}
      </Box>
    )
  })
}
// reload marker 2026-10-20 v7 gap-fill
