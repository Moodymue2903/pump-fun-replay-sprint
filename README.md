# Pump.fun Replay Sprint — Paper Bot

[![make.fun](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122.svg)](https://make.fun/c/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/Moodymue2903/pump-fun-replay-sprint/rank.svg)](https://make.fun/c/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/Moodymue2903/pump-fun-replay-sprint/reward.svg)](https://make.fun/c/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)

A paper trading bot for the [Pump.fun Replay Sprint](https://make.fun/c/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122) competition on make.fun. It trades 10 SOL of paper money on a 24h replay of pump.fun bonding-curve activity. Best net PnL wins; a paid place needs net PnL above 0 after all fees.

## Strategy

A young high-flow rocket scalper (see `joint-plan.md` for the full plan and the
revision log — the data rejected the original two-window design, so this is
what the evidence supports):

- **Entry:** a coin 120–600 slots old, real SOL 15–65, creator never sold, with
  net flow >= 3 SOL over the last 300 slots, buy SOL >= 0.40, price already up
  >= 25% in the window, and at least 4 distinct buyers / 6 trades / 4 buys.
  No W2 rule and no absolute microstructure caps — the data shows those kill
  the whole tradeable population (see the revision log).
- **Size:** 0.08 SOL per trade, capped at 0.009x the real reserve, never below
  0.05 SOL. No pyramiding. Max 5 open positions, max 5 buys per batch.
- **Exits (first trigger wins):** take profit +12%, stop loss -5%, trail 4%
  below peak once +6%, max hold 600 slots, stall exit (< +2% after 400 slots
  with negative 300-slot net flow), reversal exit (150-slot net flow
  < -0.05 SOL or creator sells).
- **Safety:** new entries pause at 5% drawdown and halt at 12% (exits
  continue). Tier-B guardrail fallback: if fewer than 20 distinct mints have
  traded by 75% of the window, entry relaxes to net flow >= 0.20 SOL,
  >= 3 buyers, reserve floor 15 SOL.
- **Determinism:** everything derives from the event stream and slot numbers
  only — no clock, no randomness, no env reads. Two runs produce
  byte-identical action logs (confirmed by `grade-local`: L1 regrade
  reproduced byte for byte).

## Measured results (dev window, `grade-local --driver process`)

- Net PnL **-0.0587 SOL** (90% interval -0.175 to +0.061), 116 fills over
  58 coins, 58 round trips, win rate 36.2%, max drawdown 1.14%.
- Stress (5 rebuilt copies): median **-0.09 SOL**, p10 -0.16, p90 +0.09;
  4 of 5 copies lost money.
- Guardrails met (58 coins with a round trip >= 0.01 SOL, drawdown ok).
- Top 3 coins made 35% of the gains; without them net PnL is -0.13 SOL.
- Fees: 0.1154 SOL curve + 0.0125 SOL tx; at 2x fees net PnL -0.1847 SOL.

**Honest verdict: this entry does NOT meet the submit bar** (dev PnL >= +0.20
SOL, stress median >= +0.10 SOL, >= 60% of stress copies > 0). It is the best
configuration found after testing the plan's v1 (zero signals), the pullback
and cross-20 variants (both negative), exit sweeps, size sweeps and split-half
validation — every configuration lost money on dev, because the 2-slot fill
latency taxes exactly the fast-moving population that shows momentum. It is
kept here as the measured best effort, not as a submission candidate.

## Files

- `main.ts` — entrypoint (`node /bot/main.ts`).
- `strategy.ts` — the strategy (parameterised; `createStrategy(params?)`).
- `vendor/makefun-bot.ts` — the kit's wire shim, vendored byte for byte.
- `joint-plan.md` — the joint build plan plus the revision log with every
  measurement behind the config above.
- `LICENSE` — MIT.

## Grade it locally

From the unpacked kit directory:

```sh
node cli/makefun.mjs grade-local --kit . --bot <this repo> --driver process
node cli/makefun.mjs grade-local --kit . --bot <this repo> --driver process --stress 5
```
