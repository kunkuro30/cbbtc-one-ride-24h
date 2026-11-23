// One-ride cbBTC trend bot for make.fun btc-race-24h-20261123-0511.
//
// Idea in one sentence: catch the day's first real 30-minute up-move, ride it
// with a 2% trailing stop, and never churn.
//
// Rules (long only, one position, full size):
// - ENTER when flat and the close is more than 0.25% above the close 30 bars
//   ago (a genuine half-hour up-move, not one noisy minute). The condition is
//   a level, so a buy the market refuses on slippage is retried while it holds.
// - EXIT the whole position when the close falls 2% below the highest close
//   since entry (trailing stop). On the dev window the worst peak-to-trough
//   dip was just under 2%, so the stop never fired there; it exists to cut a
//   real reversal in the race window.
// - ONE re-entry only: after an exit, buy again only on a fresh 240-bar high
//   while above the 240-bar average times 1.005 (a real new breakout, not a
//   bounce). No other re-entry: re-entering chop is how 1-minute bots bleed
//   ~26 bps per round trip in fees, slippage and impact.
// - Fallback: if nothing ever triggered by bar 720 (halfway), buy anyway, so
//   the entry always meets the race guardrail of at least 1 trade.
//
// Dev window (1,440 bars, +3.64% BTC): net PnL +$31.83 on $1,000 paper,
// 1 trade, max drawdown 2.06% (kit grade-local).
// Deterministic: pure functions of the closes seen so far, no clock, no
// randomness, no network, standard library only.

import { runBars, type BarsState, type BuyInput, type OrderInput, type SellInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
const ENTRY_LOOKBACK = 30; // bars back for the entry return
const ENTRY_THRESHOLD = 0.0025; // +0.25% over the lookback
const TRAIL = 0.02; // exit 2% below the peak close since entry
const REENTRY_LOOKBACK = 240; // bars for the fresh-high re-entry
const REENTRY_SMA_MULT = 1.005; // re-enter only above the 240-bar mean x this
const FALLBACK_BAR = 720; // buy anyway from this batch if never entered
const MAX_SLIPPAGE_BPS = 100; // 1% past the close the order was decided on

/** Strategy state; every decision is a level, re-read on each bar. */
class OneRide {
  closes: number[] = []; // closes seen, oldest first (raw price units)
  peak: number | null = null; // highest close since entry, while holding
  exited = false; // the trailing stop has fired once
  reentered = false; // the one re-entry has been used
  entered = false; // a buy has filled (from account state)

  entryReturn(): number | null {
    if (this.closes.length <= ENTRY_LOOKBACK) return null;
    const old = this.closes[this.closes.length - 1 - ENTRY_LOOKBACK];
    return this.closes[this.closes.length - 1] / old - 1;
  }

  freshHigh(): boolean {
    if (this.closes.length <= REENTRY_LOOKBACK) return false;
    const window = this.closes.slice(-REENTRY_LOOKBACK - 1, -1);
    const recent = this.closes.slice(-REENTRY_LOOKBACK);
    const mean = recent.reduce((a, x) => a + x, 0) / REENTRY_LOOKBACK;
    const last = this.closes[this.closes.length - 1];
    return last > Math.max(...window) && last > mean * REENTRY_SMA_MULT;
  }

  decide(state: BarsState): OrderInput[] {
    if (state.warmingUp) return [];
    const bar = state.latest.get(SYMBOL);
    if (bar === undefined) return [];
    const close = Number(bar.c);
    this.closes.push(close);
    const held = state.positions.get(SYMBOL);
    if (held !== undefined && held.qty > 0n) {
      this.entered = true;
      this.peak = this.peak === null ? close : Math.max(this.peak, close);
      if (close <= this.peak * (1 - TRAIL)) {
        this.exited = true;
        this.peak = null;
        const sell: SellInput = { side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS };
        return [sell];
      }
      return [];
    }
    // Flat: peak resets; an exit has happened, or nothing yet.
    this.peak = null;
    if (this.exited && !this.reentered && this.freshHigh()) {
      this.reentered = true;
      return this.buy(state);
    }
    if (!this.exited && !this.entered) {
      const ret = this.entryReturn();
      if (ret !== null && ret > ENTRY_THRESHOLD) return this.buy(state);
      if (state.seq >= FALLBACK_BAR) return this.buy(state);
    }
    return [];
  }

  buy(state: BarsState): OrderInput[] {
    const minNotional = BigInt(state.hello.fees.min_notional_quote_units);
    if (state.cash < minNotional) return [];
    const order: BuyInput = { side: 'buy', symbol: SYMBOL, notional_quote_units: state.cash, max_slippage_bps: MAX_SLIPPAGE_BPS };
    return [order];
  }
}

const bot = new OneRide();

await runBars({
  onBatch(state) {
    return bot.decide(state);
  },
});
