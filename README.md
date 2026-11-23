# Dip-Buy Ladder v2-D — btc-race-24h-20261123-0511

[![make.fun · btc-race-24h-20261123-0511](https://make.fun/badge/btc-race-24h-20261123-0511.svg)](https://make.fun/bounty/btc-race-24h-20261123-0511?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261123-0511)
[![rank](https://make.fun/badge/btc-race-24h-20261123-0511/LecialiArthelais/makefun-btc-race-24h-20261123/rank.svg)](https://make.fun/bounty/btc-race-24h-20261123-0511/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261123-0511)
[![reward](https://make.fun/badge/btc-race-24h-20261123-0511/LecialiArthelais/makefun-btc-race-24h-20261123/reward.svg)](https://make.fun/bounty/btc-race-24h-20261123-0511?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261123-0511)

A long-only mean-reversion bot for the make.fun BTC trading race: it trades
1-minute bars of cbBTC (Coinbase Wrapped BTC, Orca Whirlpool, Solana) with
paper money, starting from $1,000.

## Strategy

BTC's 1-minute tape mean-reverts around its 60-minute average. The bot buys
sharp dips below that average in up to three scale-in arms, takes half off at
+0.7%, then rides the rest behind a ratcheting trailing stop.

- **Arm 1:** z-score (60-bar) ≤ −1.3 and 15-min return ≤ −0.6% → spend 40% of cash. Or, failing that, a pullback of at least 1.5% below the highest close of the last 240 bars, at least 60 bars after the previous round trip closed → spend 40% of cash.
- **Arm 2:** z-score ≤ −1.8 → spend 60% of the remaining cash.
- **Arm 3:** z-score ≤ −2.6 → spend the rest.
- Arms are at least 3 bars apart.
- **Take-profit 1:** +0.7% from average cost sells half, once per round trip.
- **Trailing stop:** after TP1, 0.4% under the highest close since TP1, ratchets up only; checked before every other exit.
- **Take-profit 2:** +3.0% sells everything.
- **Hard stop:** −1.0% from average cost sells everything.
- **Max hold:** 480 bars, then sell everything.
- **No new entries** in the final 60 bars of the 24h window; the first 60 bars warm the average up.
- Orders are capped at 1.5% slippage past the close they were decided on.

## Dev-window replay (this race's frozen dev data)

Simulated on the kit's 1,440 dev bars with the harness fill model (fee 4 bps,
slippage 2 bps, price impact vs pool depth): **net PnL +$18.74, 14 trades,
max drawdown −0.84%, 3 round trips won / 0 lost**. Both halves of the window
are positive (+$6.15 / +$12.52), and with fees doubled the PnL is still
+$16.51 (grade-local). Honest caveat: the dev window is an uptrend (+3.59%; buy-and-hold
alone would make +$35.86), so a falling live window can still hurt — this
design cuts the bleeding of the previous race's version, it does not
guarantee a top-10 finish.

No shorting, no leverage, no clock, no randomness: every decision is a pure
function of the bars the harness delivered, so two runs are byte-identical.
