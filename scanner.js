
const CONFIG = {
  BOX_CANDLES: 5,
  BREAKOUT_WINDOW: 5,
  RISK_PERCENT: 1,
  REWARD_RISK: 1.5,
  MIN_CANDLES: 12
};

function analyzePair(pair, candles, accountBalance = 10000) {
  if (!Array.isArray(candles) ||
      candles.length < CONFIG.MIN_CANDLES) {
    return null;
  }

  const data = candles
    .filter(c =>
      Number.isFinite(c.open) &&
      Number.isFinite(c.high) &&
      Number.isFinite(c.low) &&
      Number.isFinite(c.close) &&
      c.high >= c.low
    )
    .sort((a, b) => a.time - b.time);

  if (data.length < CONFIG.MIN_CANDLES) {
    return null;
  }

  // Last candle may still be forming.
  // Its OPEN is used for the next-candle entry.
  const lastIndex = data.length - 1;

  // Search newest eligible breakout first.
  for (
    let breakoutIndex = lastIndex - 1;
    breakoutIndex >= CONFIG.BOX_CANDLES;
    breakoutIndex--
  ) {
    const boxStart =
      breakoutIndex - CONFIG.BOX_CANDLES;

    const boxCandles = data.slice(
      boxStart,
      breakoutIndex
    );

    const boxHigh = Math.max(
      ...boxCandles.map(c => c.high)
    );

    const boxLow = Math.min(
      ...boxCandles.map(c => c.low)
    );

    if (boxHigh <= boxLow) continue;

    // Check breakout inside next 5 candles.
    const windowStart = breakoutIndex;
    const windowEnd = Math.min(
      breakoutIndex + CONFIG.BREAKOUT_WINDOW,
      lastIndex
    );

    let breakout = null;

    for (
      let i = windowStart;
      i < windowEnd;
      i++
    ) {
      const candle = data[i];

      const bullishBreak =
        candle.close > boxHigh &&
        candle.close > candle.open;

      const bearishBreak =
        candle.close < boxLow &&
        candle.close < candle.open;

      if (bullishBreak || bearishBreak) {
        breakout = {
          index: i,
          side: bullishBreak ? "BUY" : "SELL"
        };
        break;
      }
    }

    if (!breakout) continue;

    // Entry must be the next candle's OPEN.
    const entryCandle = data[breakout.index + 1];

    if (!entryCandle) continue;

    const entry = entryCandle.open;

    let stopLoss;
    let target;
    let riskDistance;

    if (breakout.side === "BUY") {
      // Reject a gap back inside the box.
      if (entry <= boxHigh) continue;

      stopLoss = boxLow;
      riskDistance = entry - stopLoss;

      if (riskDistance <= 0) continue;

      target =
        entry + riskDistance * CONFIG.REWARD_RISK;

    } else {
      // Reject a gap back inside the box.
      if (entry >= boxLow) continue;

      stopLoss = boxHigh;
      riskDistance = stopLoss - entry;

      if (riskDistance <= 0) continue;

      target =
        entry - riskDistance * CONFIG.REWARD_RISK;
    }

    // Validate price levels.
    const validLevels =
      breakout.side === "BUY"
        ? stopLoss < entry && target > entry
        : stopLoss > entry && target < entry;

    if (!validLevels) continue;

    // Position sizing: risk only 1% of account.
    const riskAmount =
      accountBalance * CONFIG.RISK_PERCENT / 100;

    const quantity = riskAmount / riskDistance;

    const notional = quantity * entry;

    return {
      pair,
      side: breakout.side,

      entry: entry,
      stopLoss: stopLoss,
      target: target,

      riskReward: CONFIG.REWARD_RISK,

      boxHigh: boxHigh,
      boxLow: boxLow,

      breakoutPrice: data[breakout.index].close,

      riskAmount: riskAmount,
      quantity: quantity,
      positionValue: notional,

      riskPercent: CONFIG.RISK_PERCENT,

      breakoutTime: data[breakout.index].time,
      entryTime: entryCandle.time,

      status: "NEW SIGNAL"
    };
  }

  return null;
}

module.exports = {
  analyzePair,
  CONFIG
};
