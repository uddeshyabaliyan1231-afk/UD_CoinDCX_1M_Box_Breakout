
const express = require("express");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static("public"));

const BASE_URL = "https://api.coindcx.com";
const FUTURES_URL = "https://public.coindcx.com";

let instrumentsCache = [];
let instrumentsCacheTime = 0;

async function getInstruments() {
  if (
    instrumentsCache.length &&
    Date.now() - instrumentsCacheTime < 60000
  ) {
    return instrumentsCache;
  }

  const url =
    BASE_URL +
    "/exchange/v1/derivatives/futures/data/active_instruments?margin_currency_short_name[]=USDT";

  const response = await fetch(url);

  if (!response.ok) {
    throw new Error("CoinDCX instruments API error");
  }

  const data = await response.json();

  instrumentsCache = data.filter(
    pair => typeof pair === "string" &&
    pair.endsWith("_USDT")
  );

  instrumentsCacheTime = Date.now();

  return instrumentsCache;
}

// Server health
app.get("/api/status", (req, res) => {
  res.json({
    status: "online",
    exchange: "CoinDCX Futures",
    timeframe: "1m",
    strategy: "5 Candle Box Breakout"
  });
});

// Get all active USDT futures pairs
app.get("/api/markets", async (req, res) => {
  try {
    const pairs = await getInstruments();

    res.json({
      success: true,
      exchange: "CoinDCX",
      total: pairs.length,
      pairs
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Get 1-minute futures candles
app.get("/api/candles", async (req, res) => {
  try {
    const pair = req.query.pair;
    const limit = Math.min(
      Math.max(parseInt(req.query.limit) || 100, 10),
      500
    );

    if (!pair) {
      return res.status(400).json({
        success: false,
        error: "Pair is required"
      });
    }

    const pairs = await getInstruments();

    if (!pairs.includes(pair)) {
      return res.status(400).json({
        success: false,
        error: "Invalid or inactive CoinDCX futures pair"
      });
    }

    const to = Math.floor(Date.now() / 1000);
    const from = to - (limit * 60);

    const url = new URL(
      FUTURES_URL + "/market_data/candlesticks"
    );

    url.searchParams.set("pair", pair);
    url.searchParams.set("from", from);
    url.searchParams.set("to", to);
    url.searchParams.set("resolution", "1");
    url.searchParams.set("pcode", "f");

    const response = await fetch(url);

    if (!response.ok) {
      throw new Error("CoinDCX candle API error");
    }

    const result = await response.json();

    if (result.s && result.s !== "ok") {
      throw new Error("Candle data unavailable");
    }

    const candles = (result.data || [])
      .map(c => ({
        time: Number(c.time),
        open: Number(c.open),
        high: Number(c.high),
        low: Number(c.low),
        close: Number(c.close),
        volume: Number(c.volume)
      }))
      .sort((a, b) => a.time - b.time);

    res.json({
      success: true,
      pair,
      timeframe: "1m",
      total: candles.length,
      candles
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Start server
app.listen(PORT, () => {
  console.log(
    `UD CoinDCX 1M Box Breakout running on port ${PORT}`
  );
});
