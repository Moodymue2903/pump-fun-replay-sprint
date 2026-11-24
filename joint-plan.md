# Joint Plan — Pump.fun Replay Sprint Paper Bot

Reconciled from three independent consultant plans. This is the build authority for
the entry in this repo. Every number and test below is kept as specified; the build
follows the steps in order and stops at the first failed gate.

## Competition facts

- Slug: `u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122`.
- Capital 10 SOL. Max 5 open positions. Max 100 bps (1%) of a coin's real SOL reserve
  per order. Max 16 orders per batch. No shorts, no leverage. Latency 2 slots
  (orders decided at slot s fill at s+2).
- Fees per order: 95 bps protocol + 30 bps creator + 5,000 lamports base +
  100,000 lamports priority. 2% of orders fail (seeded) and still pay 105,000 lamports.
- Round-trip breakeven: 2.71% at 0.10 SOL, 2.92% at 0.05 SOL, 4.6% at 0.01 SOL.
  Never trade below 0.05 SOL.
- Guardrails: min 20 distinct mints, each with a round trip >= 0.01 SOL;
  max drawdown 50%. Bot runs twice; logs must match byte-for-byte (fully
  deterministic: no clock, no Math.random, no env reads; seed any randomness from
  hello.seed).
- Final scoring is Net PnL (SOL) on a FRESH 24h window collected after the deadline
  (2026-11-27T04:50:00Z). A paid place needs Net PnL > 0 after all fees.
- Dev window: 1,222 mints, 126,801 trades, 35 completers in 24h. Completion
  threshold is EXACTLY 85.0 real SOL.
- P(complete | max real SOL >= X): 10 -> 9.8%, 20 -> 21.5%, 30 -> 33%,
  40 -> 46%, 50 -> 62.5%, 60 -> 74.5%, 70 -> 77.8%.
- Median peak price multiplier from first crossing real = 20: completers 3.86x,
  non-completers 1.39x. BUT median slots from crossing 20 to completion = 0
  (burst: most completers cross 20 and complete in the same slot, so a buy decided
  at the cross batch fills at s+2 AFTER completion and is rejected).
  Completion-chasing is therefore a VARIANT, not the primary mechanism.
- Live leaderboard (8 entries): #1 "Dawn Patrol" +0.0757 SOL (1,053 fills, 498 coins,
  DD 3.6%); #2 +0.0589 SOL (382 fills, 96 coins, DD 11.4%); #3 -0.0095; #4 -0.070;
  #5 -0.220; #6 -0.237; #7 -2.567; #8 -2.595 SOL. Only 2 of 8 profitable on dev;
  both inside wide 90% bootstrap intervals (+/-0.7-1.7 SOL). Dev score is noise;
  stress percentiles are the bar.
- Baselines on the FULL dev window: pilot-momentum -9.489 SOL (DD 95.7%, 77 trips,
  45 coins, 31,164 rejections, nearly all insufficient_cash); pilot-sniper
  -0.475 SOL (347 trips, 347 coins, win rate 13%); pilot-reversion -3.995 SOL
  (426 trips, 197 coins, win 27%); equal-weight -0.019 SOL (only 5 coins, never
  sells, slots blocked); hold-cash 0.0. ALL pilots lose.

## 1. Mechanism v1 — two-window continuation momentum scalper

Per mint track price (virtual SOL / virtual token), real SOL, rolling buy/sell SOL
+ distinct buyers, creator-sold flag.

ELIGIBILITY (all must hold):
- Age 240-7,200 slots since CreateEvent.
- Real SOL 20-65.
- Creator never sold.
- No open position in the mint.
- No round-trip in the mint in the last 900 slots.

SIGNAL (per batch; fills at s+2):
- W1 = last 600 slots: net flow >= +0.30 SOL, buy SOL >= 0.40, sell SOL <= 30%
  of buy SOL.
- W2 = prior 600-1,800 slots: net flow > 0 and price +3% to +30%.
- Price move W1 +4% to +25%, within 8% of the W1 high.
- Breadth W1: >= 4 distinct buyers, >= 6 trades, >= 4 buys, largest buyer
  <= 40% of W1 buy SOL.
- Latency guard: last trade not a single buy > 0.15 SOL; price did not jump
  > 10% in the last 30 slots.
- No single sell > 0.05 SOL in W1.

RANKING: score = (W1 net flow / real reserve) x (1 + 0.1 x distinct buyers);
sort score desc, mint asc tie-break. Max 5 open, max 1 buy per mint, max 5 buys
per batch.

SIZE: fixed 0.10 SOL, capped at 0.009 x real reserve. NO pyramiding.

EXITS (first trigger wins):
- TP +12% from fill.
- SL -5%.
- Trailing: once +6%, trail 4% below peak.
- Max hold 600 slots.
- Stall exit: < +2% after 400 slots AND W1 net flow negative.
- Reversal exit: 150-slot net flow < -0.05 SOL or creator sells -> exit immediately.
- CompleteEvent force-close accepted.

TIER-B GUARDRAIL FALLBACK (slot-based): if by 75% of the window distinct mints
traded < 20, relax ONLY: W1 net flow >= +0.20, buyers >= 3, reserve floor 15 SOL
with size floored at 0.05. NEVER relax creator-sell ban, overextension cap
(+25% W1), sell-ratio, or the two-window rule. Flag Tier-B trades.

RISK HALT: pause new entries at 5% drawdown, halt at 12% (exits continue).

## 2. Step 0 first (no trading): signal diagnostic

Log every v1 signal; forward price at +150/+300/+600 slots; hit rate of +5%
before -5%; median forward return. KEEP if hit rate >= 52% AND median forward
return >= +1.5% before fees AND >= 40 signals on dev. REJECT the entry signal if
hit rate <= 50% or median forward <= 0% — stop, do not proceed to sweeps.

## 3. Step 1: entry-threshold sweep, one variable at a time

W1 300/600/1,200 slots; net flow 0.15/0.30/0.60 SOL; buyers 3/4/6; price-band
upper 15%/25%/40%; sell-ratio 20%/30%/50%. Keep best by sim-full + split-half.
Reject if no config beats v1 or best needs < 40 trips.

## 4. Step 2: exits sweep

TP 8/12/20%; SL 4/5/8%; trailing off/3%/4%/6% (after +6%); hold 180/600/900
slots; stall on/off. Keep best by sim + split-half. Reject if sim median <= 0
or win rate < 40% at TP/SL >= 2:1.

## 5. Step 3: size/reserve sweep

Size 0.05/0.08/0.10 SOL; reserve floor 15/20/25 SOL; cap 0.9%/1.0% of reserve.
Keep if median improves/flat AND 10th-percentile proxy does not worsen > 0.05 SOL
AND >= 20 mints cleared.

## 6. Step 4 variants (only if v1 is short of the bar)

Each must BEAT v1 on the same test — sim full + split-half — or be rejected with
the reason recorded.
- (a) Skeptic pullback entry: real >= 25, 50-slot price +2% to +10% and 1-6%
  below 50-slot high, >= 8 distinct buyers in 100 slots, TP+12/SL-5, hold 180.
- (b) Cross-20 trigger entry: buy on upward cross of real 20 with net inflow > 0
  and >= 8 buyers, TP+12/SL-5, hold 600.
- (c) Reserve-progression adds: +0.05 SOL when real crosses 35 with price above
  entry, max total 0.20 SOL.

## 7. Step 5 final validation

Freeze best config; full-dev sim + split-half (first/second 12h separately) +
grade-local dev + grade-local --stress 5 (then 10 if time allows); determinism
check (run twice, byte-identical action logs); guardrail check (>= 20 mints,
max DD, fills, rejections <= 5%).

## 8. Submit bar (all must pass for the entry to be offered for submission)

- Dev Net PnL >= +0.20 SOL.
- Stress median >= +0.10 SOL.
- Stress 10th percentile >= -0.25 SOL.
- >= 60% of stress copies > 0.
- Top-1 coin <= 20% of |gross PnL|.
- Max DD <= 12% dev.
- Breadth 35-90 distinct mints.
- Avg size >= 0.08 SOL.
- Rejection rate <= 5%.
- +/-20% perturbation of TP/SL/real-threshold keeps stress median > 0.

## 8. Submit bar (all must pass for the entry to be offered for submission)

- Dev Net PnL >= +0.20 SOL.
- Stress median >= +0.10 SOL.
- Stress 10th percentile >= -0.25 SOL.
- >= 60% of stress copies > 0.
- Top-1 coin <= 20% of |gross PnL|.
- Max DD <= 12% dev.
- Breadth 35-90 distinct mints.
- Avg size >= 0.08 SOL.
- Rejection rate <= 5%.
- +/-20% perturbation of TP/SL/real-threshold keeps stress median > 0.

Otherwise HOLD and say so plainly.

## 9. Revision log — what the dev data actually said (2026-11-24)

The plan above was written from three consultant plans before touching the
data. Step 0 measured it, and the data rejected most of it. This section is
the record; the shipped DEFAULT_PARAMS in strategy.ts follow the revised
config, not the original v1.

### Step 0: v1 as specified yields ZERO signals
- Diagnostic (no trading) on the full dev window: 0 raw signals, 0 deduped.
- Gate-fail census (69,315 evaluations): eligibility 60,815 (age < 240 slots
  22,539; real < 20 SOL 17,358; creator sold 9,010; age > 7,200 slots 8,806;
  real > 65 SOL 3,102); of the 8,500 that passed eligibility, sell-ratio
  killed 6,362, W1 net 1,759, W2 net 313, W2 rise 46, W1 rise 12.
- The flow population (eligible + W1 net >= 0.30 + buy >= 0.40): 6,741 raw
  evaluations, 81 deduped signals. Overall hit rate (+5% before -5%) 50.6%,
  median forward return +150 slots 0%, +300 -3.3%, +600 -8.1% — FAILS the
  Step 0 KEEP bar (hit >= 52%, median forward >= +1.5%, >= 40 signals).
  The two-window rule is structurally broken for young coins: for a coin
  younger than ~600 slots the W2 window is mostly pre-creation (net 0), and
  the W1 rise anchor falls back to the creation price, so a coin at real
  20-65 shows a W1 rise of +178% or more and trips the +25% overextension cap.
- Per-bucket forward returns (deduped, resolved): the only bucket with n >= 30
  and hit rate above the bar is young rockets — age < 600 slots, W1 rise
  > 25%, W1 net > 5 SOL: n = 35, hit rate +5%-before--5% 63%, +12%-before--5%
  51%, median forward +600 -35.1% (they spike, then dump hard). Old rockets
  (rise > 25%, age > 600) hit only 22%. Old steady risers (age > 1,800,
  rise 1-25%, net 0.6-5) hit 60% but n = 10-15 total.
- Relaxing age to 60 slots / real floor to 15 SOL made it WORSE: the young
  rocket bucket grew to n = 72 but hit rate fell to 42% (the earliest phase
  is the most chaotic). minAge 240 was helping; the revised config uses 120
  as a compromise measured in the sim, not the diagnostic.

### Microstructure gates do not scale
- With the rocket gates (net >= 5, rise >= 25%, age <= 600), the plan's
  absolute microstructure caps kill 100% of the 3,465 flow-passing
  evaluations: near-high 8% kills 57% (W1 highs are single-trade spikes),
  single sell 0.05 SOL kills most of the rest (a 0.05 sell is 1% of a 5+ SOL
  flow window), last buy 0.15, 30-slot jump 10%, and buyer share 40% kill the
  remainder — the last 39 candidates all have one buyer above 60% of W1 buy
  SOL (rockets are single-whale pumps with many small followers). The caps
  were calibrated for ~0.3-0.5 SOL flow windows; the tradeable population has
  10-20x that flow. The revised config turns them off (near-high 0, single
  sell / last buy effectively infinite, jump 10x, buyer share 1.0) and keeps
  only breadth counts (≥ 4 buyers, ≥ 6 trades, ≥ 4 buys), which never bind.

### Step 4 variants: both REJECTED (sim, full dev)
- (a) Pullback: -0.1135 SOL, 40 trips, 24 mints, 7 winning / 17 losing coins.
- (b) Cross-20: -0.1505 SOL, 31 trips, 26 mints, 7 / 19; only 4
  max-slippage rejections (the feared token_complete bloodbath did not
  materialise — the fills land, they just lose).
- (c) Adds: not tested standalone; no working entry to add to.

### Step 2/3 sweeps on the rocket base (sim, full dev)
- Minimal rocket (age 240-600, net >= 5, rise >= 25%, exits TP12/SL5/trail
  4%/hold 600): -0.2235 SOL, 35 trips, 35 mints, trip win rate 37%,
  avg win +0.0111 SOL, avg loss -0.0084 SOL (exits work roughly as designed;
  the loss is the win rate, not the exits).
- Exit sweep (TP 8/12/20, SL 4/5/8, trail off/3/4%, hold 180/600/900,
  lottery TP20/SL8 and TP30/SL10): all -0.21 to -0.31 SOL. No exit shape
  fixes a 34-37% win rate against a ~43-45% breakeven.
- Earlier entry (minAge 120, real 15; W1 300, net 3): -0.0969 SOL, 58 trips,
  58 mints, win 34.5% — best config. Split-half: first 12h -0.0396 (21 trips,
  33.3%), second 12h -0.0564 (37 trips, 35.1%) — consistently negative, not
  a one-half fluke.
- Size sweep (same base): 0.10 -> -0.0969, 0.08 -> -0.0801, 0.05 -> -0.0548
  per run (smaller size loses less through lower price impact, but the
  per-trade EV stays negative at every size). 0.08 chosen: least loss among
  sizes meeting the bar's avg-size floor (>= 0.08).
- Cooldown 300 (re-trade rockets sooner): -0.1949 — worse; 900 kept.
- Old-steady population (age > 1,800, net >= 0.6, rise 1-25%): -0.0604 SOL,
  29 trips, 13 mints, win 24.1% — also fails, and 13 mints is below the
  20-mint guardrail.

### Why the diagnostic edge does not survive the sim
- The diagnostic measures from the signal price with no latency. The sim
  buys at s+2: rockets move so fast that the fill lands several % above the
  signal price, which pushes +12% further away and -5% closer. Diagnostic
  hit12 51% becomes realised trip win rate 34-35%. The 2-slot latency is a
  structural tax on exactly the population that shows momentum.

### Final config (shipped as DEFAULT_PARAMS)
- Young rockets: age 120-600 slots, real 15-65 SOL, creator never sold,
  W1 = 300 slots, net flow >= 3 SOL, buy SOL >= 0.40, price +25% or more in
  W1 (no upper cap), >= 4 buyers / >= 6 trades / >= 4 buys in W1; no W2
  rule, no sell-ratio cap, no microstructure caps.
- Size 0.08 SOL, capped at 0.009 x real reserve, min 0.05 SOL. Exits TP +12%,
  SL -5%, trail 4% below peak once +6%, max hold 600, stall (< +2% after 400
  slots and W1 net negative), reversal (150-slot net < -0.05 or creator
  sells). Cooldown 900 slots. Risk halt 5% pause / 12% halt. Tier-B
  guardrail fallback retained (never triggers at this breadth).
- Measured (research sim, full dev): -0.0801 SOL, 116 fills, 58 mints,
  58 trips, trip win rate 34.5%, avg win +0.0088, avg loss -0.0068,
  max DD 1.12%, rejections 4 (3.4% of orders).
- VERDICT: DOES NOT MEET THE SUBMIT BAR. Dev PnL -0.08 is 0.28 SOL short of
  the +0.20 bar; trip win rate 34.5% is below the ~43% breakeven and below
  the Step 2 reject rule (win rate < 40% at TP/SL >= 2:1). HOLD — do not
  submit. What would be needed: a signal whose realised trip win rate clears
  ~45% at TP12/SL5 after the 2-slot latency, i.e. an entry that fires BEFORE
  the burst rather than during it; nothing tested here does that.

