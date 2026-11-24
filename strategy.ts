// Two-window continuation momentum scalper for the pump.fun replay sprint
// (agent-fun/replay/v2). Written fresh from joint-plan.md.
//
// Idea: most pump.fun coins die fast, but a coin that has already attracted
// 20-65 real SOL, with a second, older window of steady inflow behind it and a
// fresh 600-slot window of broad-based buying (many distinct buyers, no single
// wallet dominating, no big sells, no single-trade spike), tends to keep rising
// for a few hundred slots. We buy a fixed 0.10 SOL, take +12% or cut at -5%,
// trail winners, and never hold longer than 600 slots. Fees make the round
// trip cost ~2.7% at this size, so the edge has to come from the entry filter,
// not from trading often.
//
// Determinism: everything derives from the event stream and slot numbers only.
// No clock, no Math.random, no env reads. Order output is sorted (score desc,
// mint asc) so two runs produce byte-identical action logs.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

const LAMPORTS_PER_SOL = 1_000_000_000n;
const SOL = 1e9;

export type Mode = 'v1' | 'pullback' | 'cross20';

export interface Params {
  // Windows (slots).
  w1Slots: number;
  w2Start: number;
  w2End: number;
  // v1 entry signal.
  minNetFlowW1: number;
  minBuySolW1: number;
  maxSellRatio: number;
  w2MinRise: number;
  w2MaxRise: number;
  w1MinRise: number;
  w1MaxRise: number;
  nearHigh: number;
  minBuyers: number;
  minTradesW1: number;
  minBuysW1: number;
  maxBuyerShare: number;
  maxLastBuySol: number;
  maxJump30: number;
  maxSingleSellW1: number;
  // Eligibility.
  minAge: number;
  maxAge: number;
  minRealSol: number;
  maxRealSol: number;
  cooldownSlots: number;
  // Sizing.
  buySizeSol: number;
  capBpsOfReserve: number;
  minBuySol: number;
  maxOpen: number;
  maxBuysPerBatch: number;
  // Exits.
  tp: number;
  sl: number;
  trailArm: number;
  trail: number;
  maxHold: number;
  stallSlots: number;
  stallMaxGain: number;
  stallOn: boolean;
  reversalWindow: number;
  reversalNet: number;
  // Risk halt (fractions of peak equity).
  pauseDd: number;
  haltDd: number;
  // Tier-B guardrail fallback (relaxed entry, latched at 75% of the window).
  tierBNetFlow: number;
  tierBBuyers: number;
  tierBMinReal: number;
  // Research toggle: when false, skip the W2 (prior-window) gates entirely.
  w2Required: boolean;
  // Variants.
  mode: Mode;
  adds: boolean;
  pullbackHold: number;
  // Slippage.
  buySlipBps: number;
  sellSlipBps: number;
  // Research: log signals and forward prices instead of trading.
  diagnostic: boolean;
}

export const DEFAULT_PARAMS: Params = {
  // Revised v1 (see joint-plan.md revision log): the plan's two-window
  // continuation filter yields ZERO signals on dev — its gates are calibrated
  // for flow scales that do not exist in this data. The tradeable population
  // the Step 0 diagnostic found is young high-flow rockets: coins 120-600
  // slots old, real 15-65 SOL, W1 (300-slot) net flow >= 3 SOL, already up
  // >= 25% in the window. The W2 rule and the absolute microstructure caps
  // (single sell 0.05, last buy 0.15, 8% near-high, 40% buyer share) are off:
  // each of them kills the whole rocket population, because a 3-5+ SOL flow
  // window routinely contains 0.5 SOL sells, 1.5 SOL buys and 25% 30-slot
  // jumps. Even so this config LOSES on dev (-0.08 SOL); it is the best
  // measured config, not a passing one — see joint-plan.md.
  w1Slots: 300,
  w2Start: 600,
  w2End: 1800,
  minNetFlowW1: 3,
  minBuySolW1: 0.4,
  maxSellRatio: 10,
  w2MinRise: 0.03,
  w2MaxRise: 0.3,
  w1MinRise: 0.25,
  w1MaxRise: 10,
  nearHigh: 0,
  minBuyers: 4,
  minTradesW1: 6,
  minBuysW1: 4,
  maxBuyerShare: 1,
  maxLastBuySol: 1000000000,
  maxJump30: 10,
  maxSingleSellW1: 1000000000,
  minAge: 120,
  maxAge: 600,
  minRealSol: 15,
  maxRealSol: 65,
  cooldownSlots: 900,
  buySizeSol: 0.08,
  capBpsOfReserve: 90,
  minBuySol: 0.05,
  maxOpen: 5,
  maxBuysPerBatch: 5,
  tp: 0.12,
  sl: 0.05,
  trailArm: 0.06,
  trail: 0.04,
  maxHold: 600,
  stallSlots: 400,
  stallMaxGain: 0.02,
  stallOn: true,
  reversalWindow: 150,
  reversalNet: -0.05,
  pauseDd: 0.05,
  haltDd: 0.12,
  tierBNetFlow: 0.2,
  tierBBuyers: 3,
  tierBMinReal: 15,
  w2Required: false,
  mode: 'v1',
  adds: false,
  pullbackHold: 180,
  buySlipBps: 500,
  sellSlipBps: 10000,
  diagnostic: false,
};

// ---------------------------------------------------------------- tape

interface TradeRec {
  slot: number;
  buy: boolean;
  sol: number;
  user: string;
  price: number;
}

interface MintState {
  mint: Pubkey;
  createdSlot: number | null;
  creator: string | null;
  creatorSold: boolean;
  creationPrice: number;
  trades: TradeRec[];
  lastPrice: number;
  lastRealSol: number;
  lastTradeSlot: number;
  complete: boolean;
  lastRoundTripSlot: number;
  lastDedupSignalSlot: number;
}

interface Position {
  mint: Pubkey;
  entryPrice: number;
  entrySlot: number;
  peakPrice: number;
  investedLamports: bigint;
  tierB: boolean;
  added35: boolean;
  added50: boolean;
}

interface PendingBuy {
  clientId: string;
  kind: 'entry' | 'add35' | 'add50';
  tierB: boolean;
}

export interface Observation {
  mint: Pubkey;
  slot: number;
  price: number;
  deduped: boolean;
  bucket: string;
  hitUp: boolean;
  hitUpSlot: number;
  hit12: boolean;
  hit12Slot: number;
  hitDown: boolean;
  hitDownSlot: number;
  p150: number;
  p300: number;
  p600: number;
  seen150: boolean;
  seen300: boolean;
  resolved: boolean;
  completed: boolean;
}

export interface Diagnostics {
  signals: Observation[];
  gateFails: Record<string, number>;
  evaluated: number;
  // Near-miss histogram: for candidates past the flow gates, the joint
  // distribution of age bucket x W1-rise bucket x W1-net bucket.
  hist: Record<string, number>;
}

export interface BucketStats {
  n: number;
  hitRate5BeforeNeg5: number;
  hitRate12BeforeNeg5: number;
  medianForward150: number;
  medianForward300: number;
  medianForward600: number;
  shareGeTp: number;
  shareLeSl: number;
  completedBefore600: number;
}

export interface DiagnosticSummary {
  rawSignals: number;
  dedupedSignals: number;
  resolved: number;
  completedBefore600: number;
  hitRate5BeforeNeg5: number;
  hitRate12BeforeNeg5: number;
  medianForward150: number;
  medianForward300: number;
  medianForward600: number;
  shareGeTp: number;
  shareLeSl: number;
  gateFails: Record<string, number>;
  buckets: Record<string, BucketStats>;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export function diagnosticSummary(d: Diagnostics): DiagnosticSummary {
  const deduped = d.signals.filter((o) => o.deduped && o.resolved);
  const fwd = (f: (o: Observation) => number) => deduped.map(f);
  const hits = deduped.filter((o) => o.hitUp && (!o.hitDown || o.hitUpSlot <= o.hitDownSlot)).length;
  const hits12 = deduped.filter((o) => o.hit12 && (!o.hitDown || o.hit12Slot <= o.hitDownSlot)).length;
  const buckets: Record<string, BucketStats> = {};
  for (const o of deduped) {
    const b = (buckets[o.bucket] ??= {
      n: 0,
      hitRate5BeforeNeg5: 0,
      hitRate12BeforeNeg5: 0,
      medianForward150: 0,
      medianForward300: 0,
      medianForward600: 0,
      shareGeTp: 0,
      shareLeSl: 0,
      completedBefore600: 0,
    });
    b.n++;
  }
  for (const [key, b] of Object.entries(buckets)) {
    const obs = deduped.filter((o) => o.bucket === key);
    const h = obs.filter((o) => o.hitUp && (!o.hitDown || o.hitUpSlot <= o.hitDownSlot)).length;
    const h12 = obs.filter((o) => o.hit12 && (!o.hitDown || o.hit12Slot <= o.hitDownSlot)).length;
    b.hitRate5BeforeNeg5 = obs.length > 0 ? h / obs.length : 0;
    b.hitRate12BeforeNeg5 = obs.length > 0 ? h12 / obs.length : 0;
    b.medianForward150 = median(obs.map((o) => o.p150 / o.price - 1));
    b.medianForward300 = median(obs.map((o) => o.p300 / o.price - 1));
    b.medianForward600 = median(obs.map((o) => o.p600 / o.price - 1));
    b.shareGeTp = obs.length > 0 ? obs.filter((o) => o.p600 / o.price - 1 >= 0.12).length / obs.length : 0;
    b.shareLeSl = obs.length > 0 ? obs.filter((o) => o.p600 / o.price - 1 <= -0.05).length / obs.length : 0;
    b.completedBefore600 = obs.filter((o) => o.completed).length;
  }
  return {
    rawSignals: d.signals.length,
    dedupedSignals: d.signals.filter((o) => o.deduped).length,
    resolved: deduped.length,
    completedBefore600: deduped.filter((o) => o.completed).length,
    hitRate5BeforeNeg5: deduped.length > 0 ? hits / deduped.length : 0,
    hitRate12BeforeNeg5: deduped.length > 0 ? hits12 / deduped.length : 0,
    medianForward150: median(fwd((o) => o.p150 / o.price - 1)),
    medianForward300: median(fwd((o) => o.p300 / o.price - 1)),
    medianForward600: median(fwd((o) => o.p600 / o.price - 1)),
    shareGeTp: deduped.length > 0 ? deduped.filter((o) => o.p600 / o.price - 1 >= 0.12).length / deduped.length : 0,
    shareLeSl: deduped.length > 0 ? deduped.filter((o) => o.p600 / o.price - 1 <= -0.05).length / deduped.length : 0,
    gateFails: d.gateFails,
    buckets,
  };
}

// First index with slot > x (trades are in slot order).
function upperBound(trades: TradeRec[], x: number): number {
  let lo = 0;
  let hi = trades.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (trades[mid].slot <= x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

interface Agg {
  net: number;
  buySol: number;
  sellSol: number;
  trades: number;
  buys: number;
  buyers: Set<string>;
  buyerSol: Map<string, number>;
  maxSell: number;
  high: number;
}

function aggregate(T: TradeRec[], from: number, to: number): Agg {
  const a: Agg = {
    net: 0,
    buySol: 0,
    sellSol: 0,
    trades: 0,
    buys: 0,
    buyers: new Set<string>(),
    buyerSol: new Map<string, number>(),
    maxSell: 0,
    high: 0,
  };
  for (let i = from; i < to; i++) {
    const t = T[i];
    a.trades++;
    if (t.price > a.high) a.high = t.price;
    if (t.buy) {
      a.buys++;
      a.buySol += t.sol;
      a.net += t.sol;
      a.buyers.add(t.user);
      a.buyerSol.set(t.user, (a.buyerSol.get(t.user) ?? 0) + t.sol);
    } else {
      a.sellSol += t.sol;
      a.net -= t.sol;
      if (t.sol > a.maxSell) a.maxSell = t.sol;
    }
  }
  return a;
}

// Price at or before slot x: last trade price at or before x, else the anchor
// (creation price, or the first trade's price when no creation was seen).
function priceAt(T: TradeRec[], anchor: number, x: number): number {
  const i = upperBound(T, x) - 1;
  if (i >= 0) return T[i].price;
  return anchor;
}

function anchorPrice(m: MintState): number {
  if (m.creationPrice > 0) return m.creationPrice;
  return m.trades.length > 0 ? m.trades[0].price : m.lastPrice;
}

// ---------------------------------------------------------------- strategy

export function createStrategy(overrides?: Partial<Params>): Bot & { diagnostics: Diagnostics } {
  const p: Params = { ...DEFAULT_PARAMS, ...(overrides ?? {}) };
  const mints = new Map<Pubkey, MintState>();
  const positions = new Map<Pubkey, Position>();
  const pendingBuy = new Map<Pubkey, PendingBuy>();
  const pendingSell = new Set<Pubkey>();
  const diagnostics: Diagnostics = { signals: [], gateFails: {}, evaluated: 0, hist: {} };
  let orderCounter = 0;
  let peakEquity = 0;
  let halted = false;
  let windowStartMs: number | null = null;
  let tierBChecked = false;
  let tierBActive = false;
  const tradedMints = new Set<Pubkey>();
  let txFee = 105000n;

  function mintState(mint: Pubkey): MintState {
    let m = mints.get(mint);
    if (m === undefined) {
      m = {
        mint,
        createdSlot: null,
        creator: null,
        creatorSold: false,
        creationPrice: 0,
        trades: [],
        lastPrice: 0,
        lastRealSol: 0,
        lastTradeSlot: -1,
        complete: false,
        lastRoundTripSlot: -1,
        lastDedupSignalSlot: -1,
      };
      mints.set(mint, m);
    }
    return m;
  }

  function failGate(gate: string): null {
    diagnostics.gateFails[gate] = (diagnostics.gateFails[gate] ?? 0) + 1;
    return null;
  }

  function bumpHist(key: string): void {
    diagnostics.hist[key] = (diagnostics.hist[key] ?? 0) + 1;
  }

  // Eligibility shared by every entry mode. Position/cooldown/pending checks
  // are the caller's job (the diagnostic has no positions). Each failing
  // sub-check is counted separately so the diagnostic shows which binds.
  function eligible(m: MintState, now: number, minReal: number): boolean {
    const created = m.createdSlot ?? (m.trades.length > 0 ? m.trades[0].slot : now);
    const age = now - created;
    if (age < p.minAge) return failGate('elig_age_low');
    if (age > p.maxAge) return failGate('elig_age_high');
    if (m.lastRealSol < minReal) return failGate('elig_real_low');
    if (m.lastRealSol > p.maxRealSol) return failGate('elig_real_high');
    if (m.creatorSold) return failGate('elig_creator');
    if (m.complete) return failGate('elig_complete');
    return true;
  }

  function tradeBlocked(m: MintState, now: number): boolean {
    if (positions.has(m.mint)) return true;
    if (pendingBuy.has(m.mint)) return true;
    if (pendingSell.has(m.mint)) return true;
    if (m.lastRoundTripSlot >= 0 && now - m.lastRoundTripSlot <= p.cooldownSlots) return true;
    return false;
  }

  function bucketOf(m: MintState, now: number, w1Net: number, w1Rise: number): string {
    const created = m.createdSlot ?? (m.trades.length > 0 ? m.trades[0].slot : now);
    const age = now - created;
    const ageB = age < 600 ? 'age<600' : age < 1800 ? 'age600-1800' : 'age>1800';
    const riseB = w1Rise < 0 ? 'rise<0' : w1Rise < 0.01 ? 'rise0-1' : w1Rise < 0.04 ? 'rise1-4' : w1Rise <= 0.25 ? 'rise4-25' : 'rise>25';
    const netB = w1Net < 0.6 ? 'net0.3-0.6' : w1Net < 1 ? 'net0.6-1' : w1Net < 2 ? 'net1-2' : w1Net < 5 ? 'net2-5' : 'net>5';
    return `${ageB}|${riseB}|${netB}`;
  }

  // Diagnostic population: every candidate that passes eligibility and the
  // W1 flow gates, tagged with its age/rise/net bucket. The per-bucket
  // forward returns show which population, if any, is tradeable.
  function diagnosticBucket(m: MintState, now: number): string | null {
    if (!eligible(m, now, p.minRealSol)) return null;
    const T = m.trades;
    const anchor = anchorPrice(m);
    const iW1 = upperBound(T, now - p.w1Slots);
    const w1 = aggregate(T, iW1, T.length);
    if (w1.net < p.minNetFlowW1) return null;
    if (w1.buySol < p.minBuySolW1) return null;
    const rise = m.lastPrice / priceAt(T, anchor, now - p.w1Slots) - 1;
    return bucketOf(m, now, w1.net, rise);
  }

  // v1 two-window continuation signal. Returns the ranking score, or null.
  function evaluateV1(m: MintState, now: number, tierB: boolean): number | null {
    diagnostics.evaluated++;
    const minReal = tierB ? p.tierBMinReal : p.minRealSol;
    const minNet = tierB ? p.tierBNetFlow : p.minNetFlowW1;
    const minBuyers = tierB ? p.tierBBuyers : p.minBuyers;
    if (!eligible(m, now, minReal)) return null;
    const T = m.trades;
    const anchor = anchorPrice(m);
    const iW1 = upperBound(T, now - p.w1Slots);
    const iW2a = upperBound(T, now - p.w2End);
    const iW2b = upperBound(T, now - p.w2Start);
    const w1 = aggregate(T, iW1, T.length);
    const w2 = aggregate(T, iW2a, iW2b);
    if (w1.net < minNet) return failGate('w1_net');
    if (w1.buySol < p.minBuySolW1) return failGate('w1_buy_sol');
    if (w1.sellSol > p.maxSellRatio * w1.buySol) return failGate('sell_ratio');
    if (p.w2Required) {
      if (w2.net <= 0) return failGate('w2_net');
      const priceW2Start = priceAt(T, anchor, now - p.w2End);
      const priceW2End = priceAt(T, anchor, now - p.w2Start);
      const w2Rise = priceW2End / priceW2Start - 1;
      if (w2Rise < p.w2MinRise || w2Rise > p.w2MaxRise) return failGate('w2_rise');
    }
    const priceW1Start = priceAt(T, anchor, now - p.w1Slots);
    const w1Rise = m.lastPrice / priceW1Start - 1;
    // Near-miss histogram (candidates that passed the flow gates).
    bumpHist(bucketOf(m, now, w1.net, w1Rise));
    if (w1Rise < p.w1MinRise || w1Rise > p.w1MaxRise) return failGate('w1_rise');
    const w1High = Math.max(w1.high, m.lastPrice);
    if (m.lastPrice < p.nearHigh * w1High) return failGate('near_high');
    if (w1.buyers.size < minBuyers) return failGate('buyers');
    if (w1.trades < p.minTradesW1) return failGate('trades');
    if (w1.buys < p.minBuysW1) return failGate('buys');
    let largest = 0;
    for (const v of w1.buyerSol.values()) if (v > largest) largest = v;
    if (w1.buySol > 0 && largest > p.maxBuyerShare * w1.buySol) return failGate('buyer_share');
    const last = T[T.length - 1];
    if (last !== undefined && last.buy && last.sol > p.maxLastBuySol) return failGate('last_buy');
    const price30 = priceAt(T, anchor, now - 30);
    if (m.lastPrice / price30 - 1 > p.maxJump30) return failGate('jump30');
    if (w1.maxSell > p.maxSingleSellW1) return failGate('single_sell');
    return (w1.net / m.lastRealSol) * (1 + 0.1 * w1.buyers.size);
  }

  // Variant (a): skeptic pullback — a modest 50-slot rise that has pulled back
  // 1-6% off its 50-slot high, with broad buying in the last 100 slots.
  function evaluatePullback(m: MintState, now: number): number | null {
    diagnostics.evaluated++;
    if (!eligible(m, now, 25)) return null;
    const T = m.trades;
    const anchor = anchorPrice(m);
    const rise50 = m.lastPrice / priceAt(T, anchor, now - 50) - 1;
    if (rise50 < 0.02 || rise50 > 0.1) return failGate('rise50');
    const i50 = upperBound(T, now - 50);
    let high50 = m.lastPrice;
    for (let i = i50; i < T.length; i++) if (T[i].price > high50) high50 = T[i].price;
    if (m.lastPrice > 0.99 * high50 || m.lastPrice < 0.94 * high50) return failGate('pullback_depth');
    const i100 = upperBound(T, now - 100);
    const w100 = aggregate(T, i100, T.length);
    if (w100.buyers.size < 8) return failGate('buyers100');
    return (w100.net / m.lastRealSol) * (1 + 0.1 * w100.buyers.size);
  }

  // Variant (b): buy the upward cross of real 20, with net inflow and breadth.
  // realBefore is the mint's real SOL before this batch's trades.
  function evaluateCross20(m: MintState, now: number, realBefore: number): number | null {
    diagnostics.evaluated++;
    if (!(realBefore < 20 && m.lastRealSol >= 20)) return failGate('no_cross');
    if (!eligible(m, now, 20)) return null;
    const T = m.trades;
    const iW1 = upperBound(T, now - p.w1Slots);
    const w1 = aggregate(T, iW1, T.length);
    if (w1.net <= 0) return failGate('w1_net');
    if (w1.buyers.size < 8) return failGate('buyers');
    return (w1.net / m.lastRealSol) * (1 + 0.1 * w1.buyers.size);
  }

  function w1Net(m: MintState, now: number): number {
    const T = m.trades;
    return aggregate(T, upperBound(T, now - p.w1Slots), T.length).net;
  }

  function netOver(m: MintState, now: number, window: number): number {
    const T = m.trades;
    return aggregate(T, upperBound(T, now - window), T.length).net;
  }

  // First exit trigger that fires, else null. Expensive window aggregates run
  // only after the cheap preconditions for that trigger already hold.
  function exitReason(pos: Position, m: MintState, now: number): string | null {
    const price = m.lastPrice;
    if (price <= 0 || pos.entryPrice <= 0) return null;
    if (price > pos.peakPrice) pos.peakPrice = price;
    const r = price / pos.entryPrice - 1;
    const held = now - pos.entrySlot;
    if (r >= p.tp) return 'tp';
    if (r <= -p.sl) return 'sl';
    if (p.trail > 0 && pos.peakPrice / pos.entryPrice - 1 >= p.trailArm && price <= pos.peakPrice * (1 - p.trail)) return 'trail';
    if (held >= p.maxHold) return 'hold';
    if (p.stallOn && held >= p.stallSlots && r < p.stallMaxGain && w1Net(m, now) < 0) return 'stall';
    if (m.creatorSold) return 'reversal';
    if (netOver(m, now, p.reversalWindow) < p.reversalNet) return 'reversal';
    return null;
  }

  function applyFill(
    f: {
      client_id: string;
      mint: Pubkey;
      side: 'buy' | 'sell';
      status: 'filled' | 'rejected' | 'failed';
      slot: number;
      quote_lamports: string;
      token_amount: string;
    },
    state: BotState,
    creditedThisBatch: Map<Pubkey, bigint>,
  ): void {
    const m = mints.get(f.mint);
    if (f.client_id.startsWith('_')) {
      // Harness close (complete / flatten / writeoff): the position is gone.
      const pos = positions.get(f.mint);
      if (pos !== undefined) {
        if (m !== undefined) m.lastRoundTripSlot = f.slot;
        positions.delete(f.mint);
      }
      pendingSell.delete(f.mint);
      return;
    }
    if (f.side === 'buy') {
      const pend = pendingBuy.get(f.mint);
      pendingBuy.delete(f.mint);
      if (f.status !== 'filled' || pend === undefined) return;
      tradedMints.add(f.mint);
      const price = m !== undefined && m.lastPrice > 0 ? m.lastPrice : 0;
      const newTokens = BigInt(f.token_amount);
      const paid = BigInt(f.quote_lamports);
      const existing = positions.get(f.mint);
      if (existing === undefined) {
        positions.set(f.mint, {
          mint: f.mint,
          entryPrice: price,
          entrySlot: f.slot,
          peakPrice: price,
          investedLamports: paid,
          tierB: pend.tierB,
          added35: pend.kind === 'add35',
          added50: pend.kind === 'add50',
        });
      } else {
        // Reserve-progression add: re-average the fill price by tokens. The
        // account already includes this fill, so old tokens = live total
        // minus this fill minus any earlier fill for this mint this batch.
        const live = state.positions.get(f.mint);
        const liveTokens = live !== undefined ? BigInt(live.token_amount) : 0n;
        const alreadyCredited = creditedThisBatch.get(f.mint) ?? 0n;
        const oldTokens = liveTokens - newTokens - alreadyCredited;
        if (oldTokens > 0n && newTokens > 0n && price > 0) {
          const wOld = Number(oldTokens);
          const wNew = Number(newTokens);
          existing.entryPrice = (existing.entryPrice * wOld + price * wNew) / (wOld + wNew);
        }
        if (price > existing.peakPrice) existing.peakPrice = price;
        existing.investedLamports += paid;
        if (pend.kind === 'add35') existing.added35 = true;
        if (pend.kind === 'add50') existing.added50 = true;
      }
      creditedThisBatch.set(f.mint, (creditedThisBatch.get(f.mint) ?? 0n) + newTokens);
    } else {
      pendingSell.delete(f.mint);
      if (f.status !== 'filled') return;
      if (positions.has(f.mint)) {
        if (m !== undefined) m.lastRoundTripSlot = f.slot;
        positions.delete(f.mint);
      }
    }
  }

  // Open (unresolved) diagnostic observations, kept apart from the full log
  // so the per-batch update stays cheap when thousands of signals exist.
  const openObs: Observation[] = [];

  function recordObservation(m: MintState, now: number, bucket: string): void {
    const deduped = m.lastDedupSignalSlot < 0 || now - m.lastDedupSignalSlot > p.cooldownSlots;
    if (deduped) m.lastDedupSignalSlot = now;
    const o: Observation = {
      mint: m.mint,
      slot: now,
      price: m.lastPrice,
      deduped,
      bucket,
      hitUp: false,
      hitUpSlot: -1,
      hit12: false,
      hit12Slot: -1,
      hitDown: false,
      hitDownSlot: -1,
      p150: m.lastPrice,
      p300: m.lastPrice,
      p600: m.lastPrice,
      seen150: false,
      seen300: false,
      resolved: false,
      completed: false,
    };
    diagnostics.signals.push(o);
    openObs.push(o);
  }

  function updateObservations(now: number): void {
    for (let i = openObs.length - 1; i >= 0; i--) {
      const o = openObs[i];
      const m = mints.get(o.mint);
      if (m === undefined) continue;
      const price = m.lastPrice;
      if (price <= 0) continue;
      if (!o.hitUp && price >= o.price * 1.05) {
        o.hitUp = true;
        o.hitUpSlot = now;
      }
      if (!o.hit12 && price >= o.price * 1.12) {
        o.hit12 = true;
        o.hit12Slot = now;
      }
      if (!o.hitDown && price <= o.price * 0.95) {
        o.hitDown = true;
        o.hitDownSlot = now;
      }
      if (!o.seen150 && now >= o.slot + 150) {
        o.p150 = price;
        o.seen150 = true;
      }
      if (!o.seen300 && now >= o.slot + 300) {
        o.p300 = price;
        o.seen300 = true;
      }
      if (now >= o.slot + 600 || m.complete) {
        o.p600 = price;
        o.completed = m.complete;
        o.resolved = true;
        openObs.splice(i, 1);
      }
    }
  }

  const bot: Bot & { diagnostics: Diagnostics } = {
    diagnostics,

    onHello(state: BotState): void {
      txFee = BigInt(state.hello.fees.base_fee_lamports) + BigInt(state.hello.fees.priority_fee_lamports);
      peakEquity = Number(BigInt(state.hello.capital.lamports));
    },

    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      const orders: OrderInput[] = [];

      // Snapshot real SOL before this batch's trades (cross-20 trigger).
      const realBefore = new Map<Pubkey, number>();
      const tradedNow = new Set<Pubkey>();
      for (const e of batch.events) {
        if (e.event === 'TradeEvent' && !realBefore.has(e.mint)) {
          const m = mints.get(e.mint);
          realBefore.set(e.mint, m !== undefined ? m.lastRealSol : 0);
          tradedNow.add(e.mint);
        }
      }

      // Fold events into the per-mint tapes.
      for (const e of batch.events) {
        if (e.event === 'CreateEvent') {
          const m = mintState(e.mint);
          if (m.createdSlot === null) m.createdSlot = e.slot;
          if (m.creator === null) m.creator = e.creator;
          m.creationPrice = Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves);
          m.lastPrice = m.creationPrice;
          if (windowStartMs === null && e.block_time !== null) windowStartMs = e.block_time * 1000;
        } else if (e.event === 'TradeEvent') {
          const m = mintState(e.mint);
          if (m.createdSlot === null && m.trades.length === 0) m.createdSlot = e.slot;
          if (m.creator === null) m.creator = e.creator;
          if (!e.is_buy && e.user === m.creator) m.creatorSold = true;
          const price = Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves);
          m.trades.push({
            slot: e.slot,
            buy: e.is_buy,
            sol: Number(e.sol_amount) / SOL,
            user: e.user,
            price,
          });
          m.lastPrice = price;
          m.lastRealSol = Number(e.real_quote_reserves) / SOL;
          m.lastTradeSlot = e.slot;
          if (windowStartMs === null && e.block_time !== null) windowStartMs = e.block_time * 1000;
        } else if (e.event === 'CompleteEvent') {
          const m = mintState(e.mint);
          m.complete = true;
        }
      }

      // Marks refresh price/real reserves for held and pending mints.
      for (const mk of batch.marks) {
        const m = mints.get(mk.mint);
        if (m === undefined) continue;
        const price = Number(mk.virtual_quote_reserves) / Number(mk.virtual_token_reserves);
        if (price > 0) m.lastPrice = price;
        m.lastRealSol = Number(mk.real_quote_reserves) / SOL;
      }

      // Fills land before decisions: update positions and pending sets.
      const creditedThisBatch = new Map<Pubkey, bigint>();
      for (const f of batch.fills) applyFill(f, state, creditedThisBatch);
      // Reconcile: a position the account no longer holds is closed.
      for (const mint of [...positions.keys()]) {
        if (!state.positions.has(mint) && !pendingSell.has(mint)) {
          const m = mints.get(mint);
          if (m !== undefined) m.lastRoundTripSlot = now;
          positions.delete(mint);
        }
      }

      // Tier-B check at 75% of the 24h window (block time).
      if (!tierBChecked && windowStartMs !== null) {
        const lastTime = batch.events.length > 0 ? batch.events[batch.events.length - 1].block_time : null;
        if (lastTime !== null && lastTime * 1000 >= windowStartMs + 0.75 * 86400 * 1000) {
          tierBChecked = true;
          tierBActive = tradedMints.size < 20;
        }
      }

      // Equity and drawdown halt (mark-to-market on last prices).
      let equity = Number(state.cash);
      for (const [mint, holding] of state.positions) {
        const m = mints.get(mint);
        const price = m !== undefined ? m.lastPrice : 0;
        equity += Number(holding.token_amount) * price;
      }
      if (equity > peakEquity) peakEquity = equity;
      const dd = peakEquity > 0 ? (peakEquity - equity) / peakEquity : 0;
      if (dd >= p.haltDd) halted = true;
      const entriesPaused = halted || dd >= p.pauseDd;

      // Diagnostic forward tracking (also runs in live mode; harmless).
      updateObservations(now);

      // Diagnostic mode: log the whole flow-passing population, bucketed by
      // age/rise/net, with forward prices. Trade nothing.
      if (p.diagnostic) {
        for (const mint of tradedNow) {
          const m = mints.get(mint);
          if (m === undefined) continue;
          const bucket = diagnosticBucket(m, now);
          if (bucket !== null) recordObservation(m, now, bucket);
        }
        return orders;
      }

      const txFeeNum = txFee;

      // Exits first: free slots before entries are considered.
      for (const [mint, pos] of [...positions.entries()]) {
        if (pendingSell.has(mint)) continue;
        const m = mints.get(mint);
        if (m === undefined) continue;
        const holding = state.positions.get(mint);
        if (holding === undefined || BigInt(holding.token_amount) <= 0n) continue;
        const reason = exitReason(pos, m, now);
        if (reason === null) continue;
        if (state.freeCashLamports() < txFeeNum) continue;
        const clientId = `s${++orderCounter}`;
        pendingSell.add(mint);
        orders.push({
          side: 'sell',
          client_id: clientId,
          mint,
          token_amount: holding.token_amount,
          max_slippage_bps: p.sellSlipBps,
        });
      }

      // Reserve-progression adds (variant c): +0.05 SOL when real crosses 35
      // (then 50) with the price above entry; max total 0.20 SOL per mint.
      if (p.adds) {
        for (const [mint, pos] of [...positions.entries()]) {
          if (pendingBuy.has(mint) || pendingSell.has(mint)) continue;
          const m = mints.get(mint);
          if (m === undefined) continue;
          let kind: 'add35' | 'add50' | null = null;
          if (!pos.added35 && m.lastRealSol >= 35) kind = 'add35';
          else if (!pos.added50 && pos.added35 && m.lastRealSol >= 50) kind = 'add50';
          if (kind === null) continue;
          if (m.lastPrice <= pos.entryPrice) continue;
          if (pos.investedLamports + 50_000_000n > 200_000_000n) continue;
          const cap = (BigInt(Math.floor(m.lastRealSol * SOL)) * BigInt(p.capBpsOfReserve)) / 10000n;
          const size = cap < 50_000_000n ? cap : 50_000_000n;
          if (size < 50_000_000n) continue;
          const clientId = `b${++orderCounter}`;
          pendingBuy.set(mint, { clientId, kind, tierB: pos.tierB });
          orders.push({ side: 'buy', client_id: clientId, mint, quote_lamports: size.toString(), max_slippage_bps: p.buySlipBps });
        }
      }

      // Entries.
      if (!entriesPaused) {
        const openSlots = Math.min(p.maxOpen, state.hello.caps.max_open_positions) - state.committedPositionCount();
        if (openSlots > 0 && tradedNow.size > 0) {
          const scored: { mint: Pubkey; score: number; tierB: boolean }[] = [];
          for (const mint of tradedNow) {
            const m = mints.get(mint);
            if (m === undefined) continue;
            if (tradeBlocked(m, now)) continue;
            let score: number | null = null;
            let tierB = false;
            if (p.mode === 'v1') {
              score = evaluateV1(m, now, false);
              if (score === null && tierBActive) {
                score = evaluateV1(m, now, true);
                tierB = score !== null;
              }
            } else if (p.mode === 'pullback') {
              score = evaluatePullback(m, now);
            } else {
              score = evaluateCross20(m, now, realBefore.get(mint) ?? 0);
            }
            if (score !== null) scored.push({ mint, score, tierB });
          }
          scored.sort((a, b) => (b.score - a.score) || (a.mint < b.mint ? -1 : a.mint > b.mint ? 1 : 0));
          const maxBuys = Math.min(p.maxBuysPerBatch, state.hello.caps.max_orders_per_batch, openSlots);
          let reserved = 0n;
          let sent = 0;
          for (const c of scored) {
            if (sent >= maxBuys) break;
            if (orders.length >= state.hello.caps.max_orders_per_batch) break;
            const m = mints.get(c.mint);
            if (m === undefined) continue;
            const reserveLamports = BigInt(Math.floor(m.lastRealSol * SOL));
            const cap = (reserveLamports * BigInt(p.capBpsOfReserve)) / 10000n;
            const want = BigInt(Math.floor(p.buySizeSol * SOL));
            const size = want < cap ? want : cap;
            if (size < BigInt(Math.floor(p.minBuySol * SOL))) continue;
            if (state.freeCashLamports() - reserved < size + txFeeNum) continue;
            reserved += size + txFeeNum;
            const clientId = `b${++orderCounter}`;
            pendingBuy.set(c.mint, { clientId, kind: 'entry', tierB: c.tierB });
            orders.push({ side: 'buy', client_id: clientId, mint: c.mint, quote_lamports: size.toString(), max_slippage_bps: p.buySlipBps });
            sent++;
          }
        }
      }

      return orders;
    },
  };

  return bot;
}
