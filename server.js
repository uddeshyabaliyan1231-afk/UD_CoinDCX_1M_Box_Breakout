
const express = require("express");
const cors = require("cors");
const { analyzePair } = require("./scanner");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static("public"));

const BASE_URL = "https://api.coindcx.com";
const PUBLIC_URL = "https://public.coindcx.com";

let instruments = [];
let lastInstrumentFetch = 0;

let activePositions = new Map();
let signalHistory = [];
let closedPositions = [];

const seenSignals = new Set();

const SETTINGS = {
  BALANCE: 10000,
  RISK_PERCENT: 1,
  MAX_CONCURRENT: 10,
  SCAN_CONCURRENCY: 8
};

async function fetchJSON(url) {
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`API error ${response.status}`);
  }

  return response.json();
}

// Load CoinDCX active futures pairs
async function getMarkets() {
  if (
    instruments.length &&
    Date.now() - lastInstrumentFetch < 60000
  ) {
    return instruments;
  }

  const url =
    BASE_URL +
    "/exchange/v1/derivatives/futures/data/active_instruments?margin_currency_short_name[]=USDT";

  const data = await fetchJSON(url);

  instruments = data.filter(
    item =>
      typeof item === "string" &&
      item.endsWith("_USDT")
  );

  lastInstrumentFetch = Date.now();

  return instruments;
}

// Fetch 1-minute candles
async function getCandles(pair) {
  const now = Math.floor(Date.now() / 1000);

  const url = new URL(
    PUBLIC_URL + "/market_data/candlesticks"
  );

  url.searchParams.set("pair", pair);
  url.searchParams.set("from", now - 12000);
  url.searchParams.set("to", now);
  url.searchParams.set("resolution", "1");
  url.searchParams.set("pcode", "f");

  const result = await fetchJSON(url);

  if (result.s && result.s !== "ok") {
    return [];
  }

  return (result.data || [])
    .map(c => ({
      time: Number(c.time),
      open: Number(c.open),
      high: Number(c.high),
      low: Number(c.low),
      close: Number(c.close),
      volume: Number(c.volume)
    }))
    .filter(c =>
      Number.isFinite(c.time) &&
      Number.isFinite(c.open) &&
      Number.isFinite(c.high) &&
      Number.isFinite(c.low) &&
      Number.isFinite(c.close)
    )
    .sort((a, b) => a.time - b.time);
}

// Check virtual position SL / target
function updatePosition(pair, candles) {
  const position = activePositions.get(pair);

  if (!position) return;

  for (const candle of candles) {

    if (candle.time <= position.lastChecked) {
      continue;
    }

    let outcome = null;
    let exitPrice = null;

    if (position.side === "BUY") {

      const slHit = candle.low <= position.stopLoss;
      const targetHit = candle.high >= position.target;

      // Conservative assumption if both hit in same candle.
      if (slHit) {
        outcome = "STOP LOSS";
        exitPrice = position.stopLoss;
      } else if (targetHit) {
        outcome = "TARGET HIT";
        exitPrice = position.target;
      }

    } else {

      const slHit = candle.high >= position.stopLoss;
      const targetHit = candle.low <= position.target;

      if (slHit) {
        outcome = "STOP LOSS";
        exitPrice = position.stopLoss;
      } else if (targetHit) {
        outcome = "TARGET HIT";
        exitPrice = position.target;
      }
    }

    position.lastChecked = candle.time;

    if (outcome) {

      const pnl =
        position.side === "BUY"
          ? (exitPrice - position.entry) * position.quantity
          : (position.entry - exitPrice) * position.quantity;

      closedPositions.unshift({
        ...position,
        exitPrice,
        outcome,
        pnl,
        closedAt: Date.now()
      });

      if (closedPositions.length > 100) {
        closedPositions.pop();
      }

      activePositions.delete(pair);

      break;
    }
  }
}

// Scan one pair
async function scanPair(pair) {
  try {

    const candles = await getCandles(pair);

    if (candles.length < 12) {
      return null;
    }

    updatePosition(pair, candles);

    if (activePositions.has(pair)) {
      return null;
    }

    const balance = SETTINGS.BALANCE;

    const signal = analyzePair(
      pair,
      candles,
      balance
    );

    if (!signal) return null;

    const signalKey =
      pair + "_" + signal.side + "_" + signal.breakoutTime;

    if (seenSignals.has(signalKey)) {
      return null;
    }

    if (
      activePositions.size >=
      SETTINGS.MAX_CONCURRENT
    ) {
      return null;
    }

    seenSignals.add(signalKey);

    const position = {
      ...signal,
      openedAt: Date.now(),
      lastChecked: signal.entryTime,
      livePrice: signal.entry,
      pnl: 0,
      status: "OPEN"
    };

    activePositions.set(pair, position);

    signalHistory.unshift(position);

    if (signalHistory.length > 100) {
      signalHistory.pop();
    }

    return position;

  } catch (error) {
    return null;
  }
}

// Parallel scanner
async function scanAll() {

  const markets = await getMarkets();

  let index = 0;
  let scanned = 0;
  const signals = [];

  async function worker() {

    while (index < markets.length) {

      const current = index++;
      const pair = markets[current];

      const result = await scanPair(pair);

      scanned++;

      if (result) {
        signals.push(result);
      }
    }
  }

  const workers = Array.from(
    {
      length: SETTINGS.SCAN_CONCURRENCY
    },
    () => worker()
  );

  await Promise.all(workers);

  return {
    success: true,
    exchange: "CoinDCX Futures",
    timeframe: "1m",
    totalPairs: markets.length,
    scanned,
    signals,
    openPositions: activePositions.size
  };
}

// API: scanner status
app.get("/api/status", (req, res) => {

  res.json({
    success: true,
    exchange: "CoinDCX",
    timeframe: "1m",
    strategy: "5 Candle Box Breakout"
  });

});

// API: markets
app.get("/api/markets", async (req, res) => {

  try {

    const markets = await getMarkets();

    res.json({
      success: true,
      total: markets.length,
      pairs: markets
    });

  } catch (error) {

    res.status(500).json({
      success: false,
      error: error.message
    });

  }

});

// API: scan all markets
app.get("/api/scan", async (req, res) => {

  try {

    const result = await scanAll();

    res.json(result);

  } catch (error) {

    res.status(500).json({
      success: false,
      error: error.message
    });

  }

});

// API: open virtual positions
app.get("/api/positions", (req, res) => {

  res.json({
    success: true,
    positions: [...activePositions.values()]
  });

});

// API: closed positions
app.get("/api/closed", (req, res) => {

  res.json({
    success: true,
    positions: closedPositions
  });

});

// API: update account risk settings
app.post("/api/settings", (req, res) => {

  const balance = Number(req.body.balance);
  const risk = Number(req.body.risk);

  if (
    !Number.isFinite(balance) ||
    balance <= 0 ||
    !Number.isFinite(risk) ||
    risk < 0.1 ||
    risk > 1
  ) {
    return res.status(400).json({
      success: false,
      error: "Invalid balance or risk"
    });
  }

  SETTINGS.BALANCE = balance;
  SETTINGS.RISK_PERCENT = risk;

  res.json({
    success: true,
    settings: SETTINGS
  });

});

// Server
app.listen(PORT, () => {

  console.log("--------------------------------");
  console.log("UD COINDCX BOX BREAKOUT SCANNER");
  console.log("Exchange: CoinDCX Futures");
  console.log("Timeframe: 1 Minute");
  console.log("Server Port:", PORT);
  console.log("--------------------------------");

});
