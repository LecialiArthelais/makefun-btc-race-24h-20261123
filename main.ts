// Dip-Buy Ladder v2-D — btc-race-24h-20261123-0511
//
// Long-only mean reversion on 1-minute cbBTC (Orca Whirlpool, Solana).
// The bot buys sharp dips below the 60-minute average in up to three
// scale-in arms, banks half at +0.7%, then rides the rest behind a
// ratcheting trailing stop. It never shorts, never uses leverage, never
// reads the clock, the network, or any file: every decision is a pure
// function of the bars the harness delivered, so two runs on the same
// bars produce byte-identical orders.
//
// v2-D rules (validated on this race's frozen dev window):
//   - Arm 1, 40% of cash, when the dip is deep (z-score of the last 60
//     closes <= -1.3 together with a 15-minute return <= -0.6%), or,
//     failing that, when the close sits at least 1.5% below the highest
//     close of the last 240 bars and at least 60 bars have passed since
//     the previous round trip closed.
//   - Arm 2, 60% of the remaining cash, at z <= -1.8; arm 3, the rest,
//     at z <= -2.6. Arms are at least 3 bars apart.
//   - Take-profit 1: +0.7% over average cost sells half, once per trip.
//   - Trailing stop: after TP1, a level that only ever rises to
//     close x (1 - 0.4%); the rest is sold the moment a close prints at
//     or below it. It is checked before every other exit.
//   - Take-profit 2: +3.0% sells everything; hard stop: -1.0% sells
//     everything; max hold: 480 bars, then sell everything.
//   - No new entries in the last 60 bars of the window; the first 60
//     bars warm the 60-bar average up.
//   - Every order caps slippage at 150 bps past the close it was
//     decided on.
//
// Returns are measured against the position's cost basis, which the
// harness scales down pro-rata when part of a position is sold, so a
// half sale at TP1 leaves the remaining half's return intact.

import { runBars, type BarsState, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
const WARMUP_BARS = 60;
const SMA_BARS = 60;
const PULLBACK_BARS = 240;
const RETURN_BARS = 15;
const LAST_ENTRY_BAR = 1380;
const MAX_HOLD_BARS = 480;
const MIN_BARS_BETWEEN_ARMS = 3;
const MIN_BARS_AFTER_EXIT_FOR_PULLBACK = 60;
const MAX_SLIPPAGE_BPS = 150;

const Z_ARM1 = -1.3;
const R15_ARM1 = -0.006;
const DD240_ARM1 = -0.015;
const Z_ARM2 = -1.8;
const Z_ARM3 = -2.6;
const TP1_RETURN = 0.007;
const TP2_RETURN = 0.03;
const STOP_RETURN = -0.01;
const TRAIL_GIVEBACK = 0.004;

const closes: number[] = [];
let armsTaken = 0;
let lastArmBar = -1_000_000;
let lastExitBar = -1_000_000;
let entryBar = -1;
let tookHalfOff = false;
/** Ratchet level in USD; 0 while the trailing stop is not armed. */
let trailLevel = 0;
/** A full exit was ordered on the previous bar and lands this bar. */
let exitLanding = false;

function average(xs: readonly number[]): number {
  let sum = 0;
  for (const x of xs) sum += x;
  return sum / xs.length;
}

function populationSd(xs: readonly number[], mean: number): number {
  let sumSq = 0;
  for (const x of xs) {
    const d = x - mean;
    sumSq += d * d;
  }
  return Math.sqrt(sumSq / xs.length);
}

await runBars({
  onBatch(state: BarsState) {
    const bar = state.latest.get(SYMBOL);
    if (bar === undefined) return [];
    const index = closes.length;
    const sym = state.symbols.get(SYMBOL);
    if (sym === undefined) return [];
    const close = Number(bar.c) / 10 ** sym.price_scale;
    closes.push(close);

    const held = state.positions.get(SYMBOL);
    const qty = held === undefined ? 0n : held.qty;
    const cost = held === undefined ? 0n : held.cost;

    // The exit ordered last bar has landed: the round trip is closed
    // on this bar, so a pullback entry may be considered from here.
    if (exitLanding && qty === 0n) {
      exitLanding = false;
      lastExitBar = index;
      armsTaken = 0;
      entryBar = -1;
      tookHalfOff = false;
      trailLevel = 0;
    }
    if (state.warmingUp || index < WARMUP_BARS) return [];

    const { caps, fees } = state.hello;
    const orders: Array<BuyInput | SellInput> = [];
    const minNotional = BigInt(fees.min_notional_quote_units);

    const window60 = closes.slice(-SMA_BARS);
    const mean60 = average(window60);
    const sd60 = populationSd(window60, mean60);
    const z = sd60 > 0 ? (close - mean60) / sd60 : 0;
    const r15 = close / closes[closes.length - 1 - RETURN_BARS] - 1;
    const dd240 =
      closes.length >= PULLBACK_BARS
        ? close / Math.max(...closes.slice(-PULLBACK_BARS)) - 1
        : null;

    const buy = (fractionNumerator: bigint, fractionDenominator: bigint): void => {
      if (orders.length >= caps.max_orders_per_bar) return;
      let spend = (state.cash * fractionNumerator) / fractionDenominator;
      if (spend < minNotional) return;
      orders.push({ side: 'buy', symbol: SYMBOL, notional_quote_units: spend, max_slippage_bps: MAX_SLIPPAGE_BPS });
    };
    const sellAll = (): void => {
      if (qty === 0n || orders.length >= caps.max_orders_per_bar) return;
      orders.push({ side: 'sell', symbol: SYMBOL, qty, max_slippage_bps: MAX_SLIPPAGE_BPS });
      exitLanding = true;
    };
    const sellHalf = (): void => {
      const half = qty / 2n;
      if (half === 0n || orders.length >= caps.max_orders_per_bar) return;
      orders.push({ side: 'sell', symbol: SYMBOL, qty: half, max_slippage_bps: MAX_SLIPPAGE_BPS });
      tookHalfOff = true;
      trailLevel = close * (1 - TRAIL_GIVEBACK);
    };

    if (qty > 0n) {
      const value = Number(state.value(SYMBOL, qty));
      const ret = (value - Number(cost)) / Number(cost);
      // Trailing stop first: it only arms after TP1, and its level
      // ratchets up to 0.4% under each new high close.
      if (tookHalfOff) {
        const candidate = close * (1 - TRAIL_GIVEBACK);
        if (candidate > trailLevel) trailLevel = candidate;
        if (close <= trailLevel) {
          sellAll();
          return orders;
        }
      }
      if (ret >= TP2_RETURN) {
        sellAll();
      } else if (ret <= STOP_RETURN) {
        sellAll();
      } else if (index - entryBar >= MAX_HOLD_BARS) {
        sellAll();
      } else if (!tookHalfOff && ret >= TP1_RETURN) {
        sellHalf();
      } else if (!tookHalfOff && armsTaken === 1 && z <= Z_ARM2 && index - lastArmBar >= MIN_BARS_BETWEEN_ARMS) {
        buy(60n, 100n);
        armsTaken = 2;
        lastArmBar = index;
      } else if (!tookHalfOff && armsTaken === 2 && z <= Z_ARM3 && index - lastArmBar >= MIN_BARS_BETWEEN_ARMS) {
        buy(100n, 100n);
        armsTaken = 3;
        lastArmBar = index;
      }
      return orders;
    }

    if (index >= LAST_ENTRY_BAR) return [];
    if (z <= Z_ARM1 && r15 <= R15_ARM1) {
      buy(40n, 100n);
      armsTaken = 1;
      lastArmBar = index;
      entryBar = index;
    } else if (
      dd240 !== null &&
      dd240 <= DD240_ARM1 &&
      index - lastExitBar >= MIN_BARS_AFTER_EXIT_FOR_PULLBACK
    ) {
      buy(40n, 100n);
      armsTaken = 1;
      lastArmBar = index;
      entryBar = index;
    }
    return orders;
  },
});
