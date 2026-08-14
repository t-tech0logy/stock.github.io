(() => {
  "use strict";

  const polygonApiKey = String(window.PLAINSTOCK_CONFIG?.polygonApiKey || "").trim();
  const polygonApiRoot = String(window.PLAINSTOCK_CONFIG?.polygonApiRoot || "https://api.polygon.io").replace(/\/$/, "");
  const polygonExtraApiRoot = String(window.PLAINSTOCK_CONFIG?.polygonExtraApiRoot || polygonApiRoot).replace(/\/$/, "");
  const searchDelay = 650;
  const freeRequestLimit = 5;
  const requestWindowMs = 60_500;
  const memoryCacheTtlMs = 5 * 60 * 1000;
  const defaultStockDelayMs = 3_000;
  const state = {
    data: null,
    analysis: null,
    chartRange: 90,
    chartData: [],
    benchmarkHistory: null,
    benchmarkCachedAt: 0,
    benchmarkPromise: null,
    stockCache: new Map(),
    searchCache: new Map(),
    activeSearchIndex: -1,
    searchMatches: [],
    searchTimer: null,
    searchRequestId: 0,
    selectedSearchValue: "",
    defaultLoadTimer: null,
    defaultLoadInProgress: false,
    loadId: 0,
    requestTimes: [],
    requestGate: Promise.resolve()
  };

  const elements = {
    dashboard: document.querySelector("#dashboard"),
    message: document.querySelector("#app-message"),
    search: document.querySelector("#stock-search"),
    searchResults: document.querySelector("#search-results"),
    searchShell: document.querySelector("#search-shell"),
    companyLogo: document.querySelector("#company-logo"),
    companyName: document.querySelector("#company-name"),
    companySymbol: document.querySelector("#company-symbol"),
    companyMeta: document.querySelector("#company-meta"),
    currentPrice: document.querySelector("#current-price"),
    priceChange: document.querySelector("#price-change"),
    freshness: document.querySelector("#freshness"),
    scoreRing: document.querySelector("#score-ring"),
    overallScore: document.querySelector("#overall-score"),
    confidenceBadge: document.querySelector("#confidence-badge"),
    verdictTitle: document.querySelector("#verdict-title"),
    verdictSummary: document.querySelector("#verdict-summary"),
    decisionBadge: document.querySelector("#decision-badge"),
    decisionSignal: document.querySelector("#decision-signal"),
    decisionNote: document.querySelector("#decision-note"),
    signalSummary: document.querySelector("#signal-summary"),
    checkGrid: document.querySelector("#check-grid"),
    periodReturn: document.querySelector("#period-return"),
    periodLabel: document.querySelector("#period-label"),
    priceChart: document.querySelector("#price-chart"),
    chartWrap: document.querySelector("#chart-wrap"),
    chartTooltip: document.querySelector("#chart-tooltip"),
    chartAxis: document.querySelector("#chart-axis"),
    metricsGrid: document.querySelector("#metrics-grid"),
    numbersNote: document.querySelector("#numbers-note"),
    positiveList: document.querySelector("#positive-list"),
    cautionList: document.querySelector("#caution-list"),
    contextGrid: document.querySelector("#context-grid"),
    dividendResult: document.querySelector("#dividend-result"),
    newsResult: document.querySelector("#news-result"),
    riskResult: document.querySelector("#risk-result")
  };

  const icons = {
    momentum: "↗",
    longterm: "⌁",
    market: "⇄",
    volume: "▥",
    range: "↥",
    stability: "≈"
  };

  function clamp(value, minimum = 0, maximum = 100) {
    return Math.min(maximum, Math.max(minimum, value));
  }

  function average(values) {
    const valid = values.filter(Number.isFinite);
    if (!valid.length) return null;
    return valid.reduce((total, value) => total + value, 0) / valid.length;
  }

  function safeNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function isoDate(date) {
    return date.toISOString().slice(0, 10);
  }

  function friendlySecurityType(type) {
    const code = String(type || "").toUpperCase();
    if (["ETF", "ETV", "ETN", "FUND"].includes(code)) return "Exchange-traded fund";
    if (["ADRC", "ADRP", "ADR"].includes(code)) return "International listing";
    if (code === "PFD") return "Preferred shares";
    if (code === "CS") return "Public company";
    return "Listed investment";
  }

  function delay(milliseconds) {
    return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
  }

  function readMemoryCache(cache, key) {
    const entry = cache.get(key);
    if (!entry) return null;
    if (Date.now() - entry.savedAt >= memoryCacheTtlMs) {
      cache.delete(key);
      return null;
    }
    return entry.value;
  }

  function writeMemoryCache(cache, key, value) {
    if (!cache.has(key) && cache.size >= 50) {
      cache.delete(cache.keys().next().value);
    }
    cache.set(key, { savedAt: Date.now(), value });
    return value;
  }

  async function reservePolygonRequest(onWait) {
    const previous = state.requestGate;
    let release;
    state.requestGate = new Promise((resolve) => {
      release = resolve;
    });
    await previous;

    try {
      while (true) {
        const now = Date.now();
        state.requestTimes = state.requestTimes.filter((time) => now - time < requestWindowMs);
        if (state.requestTimes.length < freeRequestLimit) {
          state.requestTimes.push(now);
          return;
        }
        const waitMs = Math.max(500, requestWindowMs - (now - state.requestTimes[0]));
        if (typeof onWait === "function") onWait(Math.ceil(waitMs / 1000));
        await delay(waitMs);
      }
    } finally {
      release();
    }
  }

  async function polygonRequest(path, parameters = {}, optional = false, options = {}) {
    await reservePolygonRequest(options.onWait);
    const url = new URL(`${options.root || polygonApiRoot}${path}`);
    Object.entries(parameters).forEach(([name, value]) => {
      if (value !== null && value !== undefined) url.searchParams.set(name, String(value));
    });
    url.searchParams.set("apiKey", polygonApiKey);
    const response = await fetch(url.toString(), { cache: "no-store" });
    let payload = null;
    try {
      payload = await response.json();
    } catch {
      // A useful HTTP error is shown below when Polygon does not return JSON.
    }
    if (!response.ok || payload?.status === "ERROR") {
      if (optional && [403, 404].includes(response.status)) return null;
      if (response.status === 429 && !options.retried) {
        const retrySeconds = Math.max(5, safeNumber(response.headers.get("retry-after")) || 60);
        if (typeof options.onWait === "function") options.onWait(retrySeconds);
        await delay(retrySeconds * 1000);
        return polygonRequest(path, parameters, optional, { ...options, retried: true });
      }
      if (response.status === 401 || response.status === 403) {
        throw new Error("The Polygon API key is missing, invalid, or does not have access to this data.");
      }
      if (response.status === 429) {
        throw new Error("Polygon's free request limit was reached. Please wait one minute and try again.");
      }
      throw new Error(payload?.error || payload?.message || `Polygon returned HTTP ${response.status}.`);
    }
    return payload;
  }

  function barsFromPayload(payload) {
    return (payload?.results || [])
      .map((bar) => ({
        date: new Date(bar.t).toISOString().slice(0, 10),
        open: safeNumber(bar.o),
        high: safeNumber(bar.h),
        low: safeNumber(bar.l),
        close: safeNumber(bar.c),
        volume: safeNumber(bar.v),
        vwap: safeNumber(bar.vw)
      }))
      .filter((point) => point.date && Number.isFinite(point.close));
  }

  async function fetchDailyHistory(symbol, start, end, onWait) {
    const encodedSymbol = encodeURIComponent(symbol);
    const payload = await polygonRequest(
      `/v2/aggs/ticker/${encodedSymbol}/range/1/day/${isoDate(start)}/${isoDate(end)}`,
      { adjusted: true, sort: "asc", limit: 5000 },
      false,
      { onWait }
    );
    return barsFromPayload(payload);
  }

  async function getBenchmarkHistory(start, end, onWait) {
    if (state.benchmarkHistory?.length && Date.now() - state.benchmarkCachedAt < memoryCacheTtlMs) {
      return state.benchmarkHistory;
    }
    if (!state.benchmarkPromise) {
      state.benchmarkPromise = fetchDailyHistory("SPY", start, end, onWait)
        .then((history) => {
          state.benchmarkHistory = history;
          state.benchmarkCachedAt = Date.now();
          return history;
        })
        .catch(() => null)
        .finally(() => {
          state.benchmarkPromise = null;
        });
    }
    return state.benchmarkPromise;
  }

  function buildStockData(stock, history, detailsPayload, benchmarkHistory) {
    const details = detailsPayload?.results || {};
    const encodedSymbol = encodeURIComponent(stock.symbol);
    const currentPrice = history.at(-1).close;
    const highs = history.map((point) => point.high ?? point.close).filter(Number.isFinite);
    const lows = history.map((point) => point.low ?? point.close).filter(Number.isFinite);
    const currency = String(details.currency_name || stock.currency || "USD").toUpperCase();

    return {
      symbol: stock.symbol,
      name: details.name || stock.name || stock.symbol,
      sector: details.sic_description || stock.sector || friendlySecurityType(details.type || stock.type),
      industry: details.sic_description || null,
      exchange: details.primary_exchange || stock.exchange || "US",
      type: details.type || stock.type || "Stock",
      description: details.description || null,
      homepageUrl: details.homepage_url || null,
      currency,
      filingCurrency: currency,
      filingCurrencyToMarketRate: 1,
      cik: details.cik || stock.cik || null,
      updatedAt: new Date().toISOString(),
      priceAsOf: history.at(-1).date,
      filingAsOf: null,
      dataMode: "polygon-free-market",
      sources: {
        prices: "Polygon adjusted daily aggregates",
        priceUrl: `${polygonApiRoot}/v2/aggs/ticker/${encodedSymbol}`
      },
      benchmark: {
        symbol: "SPY",
        name: "S&P 500 fund",
        history: benchmarkHistory || []
      },
      market: {
        currentPrice,
        previousClose: history.at(-2)?.close ?? null,
        currency,
        marketCap: safeNumber(details.market_cap),
        fiftyTwoWeekHigh: Math.max(...highs),
        fiftyTwoWeekLow: Math.min(...lows),
        history
      }
    };
  }

  async function fetchPolygonStock(stock, onWait, onPriceReady, shouldContinue) {
    const end = new Date();
    const start = new Date(end);
    start.setUTCFullYear(start.getUTCFullYear() - 1);
    const encodedSymbol = encodeURIComponent(stock.symbol);
    const history = await fetchDailyHistory(stock.symbol, start, end, onWait);
    if (!history.length) throw new Error(`Polygon did not return price history for ${stock.symbol}.`);
    if (typeof shouldContinue === "function" && !shouldContinue()) {
      const cancelled = new Error("Stock load cancelled.");
      cancelled.name = "AbortError";
      throw cancelled;
    }

    if (typeof onPriceReady === "function") {
      const previewBenchmark = stock.symbol === "SPY" ? history : [];
      onPriceReady(buildStockData(stock, history, null, previewBenchmark));
    }

    const detailsPromise = stock.referenceComplete
      ? Promise.resolve(null)
      : polygonRequest(`/v3/reference/tickers/${encodedSymbol}`, {}, true, { onWait }).catch(() => null);
    const benchmarkPromise = stock.symbol === "SPY"
      ? Promise.resolve(null)
      : getBenchmarkHistory(start, end, onWait);
    const [detailsPayload, downloadedBenchmark] = await Promise.all([detailsPromise, benchmarkPromise]);
    const benchmarkHistory = stock.symbol === "SPY" ? history : downloadedBenchmark;
    if (stock.symbol === "SPY") {
      state.benchmarkHistory = history;
      state.benchmarkCachedAt = Date.now();
    }
    return buildStockData(stock, history, detailsPayload, benchmarkHistory);
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function formatCurrency(value, currency = "USD", digits = 2) {
    if (!Number.isFinite(value)) return "Not available";
    try {
      return new Intl.NumberFormat("en-US", {
        style: "currency",
        currency,
        minimumFractionDigits: digits,
        maximumFractionDigits: digits
      }).format(value);
    } catch {
      return `${currency} ${value.toFixed(digits)}`;
    }
  }

  function formatCompactNumber(value) {
    if (!Number.isFinite(value)) return "Not available";
    return new Intl.NumberFormat("en-US", {
      notation: "compact",
      maximumFractionDigits: 1
    }).format(value);
  }

  function formatCompactCurrency(value, currency = "USD") {
    if (!Number.isFinite(value)) return "Not available";
    try {
      return new Intl.NumberFormat("en-US", {
        style: "currency",
        currency,
        notation: "compact",
        maximumFractionDigits: 1
      }).format(value);
    } catch {
      return `${currency} ${formatCompactNumber(value)}`;
    }
  }

  function formatPercent(value, digits = 1) {
    if (!Number.isFinite(value)) return "Not available";
    const sign = value > 0 ? "+" : value < 0 ? "−" : "";
    return `${sign}${Math.abs(value * 100).toFixed(digits)}%`;
  }

  function formatUnsignedPercent(value, digits = 1) {
    if (!Number.isFinite(value)) return "Not available";
    return `${Math.abs(value * 100).toFixed(digits)}%`;
  }

  function formatDate(value) {
    if (!value) return "Unknown date";
    const date = new Date(`${String(value).slice(0, 10)}T00:00:00`);
    if (Number.isNaN(date.getTime())) return value;
    return new Intl.DateTimeFormat("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric"
    }).format(date);
  }

  function formatShortDate(value) {
    const date = new Date(`${String(value).slice(0, 10)}T00:00:00`);
    if (Number.isNaN(date.getTime())) return value;
    return new Intl.DateTimeFormat("en-US", {
      month: "short",
      day: "numeric"
    }).format(date);
  }

  function scoreState(score) {
    if (!Number.isFinite(score)) return "watch";
    if (score >= 67) return "good";
    if (score >= 43) return "watch";
    return "weak";
  }

  function scoreLabel(score) {
    const status = scoreState(score);
    if (status === "good") return "Looks healthy";
    if (status === "watch") return "Worth checking";
    return "Needs caution";
  }

  function calculateReturns(history) {
    const returns = [];
    for (let index = 1; index < history.length; index += 1) {
      const previous = safeNumber(history[index - 1].close);
      const current = safeNumber(history[index].close);
      if (previous && current) returns.push(current / previous - 1);
    }
    return returns;
  }

  function calculateVolatility(history) {
    const returns = calculateReturns(history);
    if (returns.length < 10) return null;
    const mean = average(returns);
    const variance = average(returns.map((value) => (value - mean) ** 2));
    return Math.sqrt(variance) * Math.sqrt(252);
  }

  function calculateMaxDrawdown(history) {
    if (!history.length) return null;
    let peak = -Infinity;
    let drawdown = 0;
    history.forEach((point) => {
      const price = safeNumber(point.close);
      if (!Number.isFinite(price)) return;
      peak = Math.max(peak, price);
      drawdown = Math.min(drawdown, price / peak - 1);
    });
    return drawdown;
  }

  function scoreStability(volatility, drawdown) {
    const volatilityScore = Number.isFinite(volatility)
      ? clamp(100 - Math.max(0, volatility - 0.12) * 190)
      : null;
    const drawdownScore = Number.isFinite(drawdown)
      ? clamp(100 - Math.max(0, Math.abs(drawdown) - 0.08) * 180)
      : null;
    return average([volatilityScore, drawdownScore]);
  }

  function periodReturn(history, tradingDays) {
    const period = history.slice(-(tradingDays + 1));
    const first = safeNumber(period[0]?.close);
    const latest = safeNumber(period.at(-1)?.close);
    return first && latest ? latest / first - 1 : null;
  }

  function movingAverage(history, tradingDays) {
    if (history.length < tradingDays) return null;
    return average(history.slice(-tradingDays).map((point) => safeNumber(point.close)));
  }

  function scorePriceReturn(value, strongMove) {
    if (!Number.isFinite(value)) return null;
    if (value >= strongMove) return 92;
    if (value >= strongMove * 0.4) return 78;
    if (value >= 0) return 62;
    if (value >= -strongMove * 0.4) return 42;
    if (value >= -strongMove) return 27;
    return 12;
  }

  function scoreAboveAverage(value) {
    if (!Number.isFinite(value)) return null;
    if (value >= 0.1) return 90;
    if (value >= 0.02) return 76;
    if (value >= -0.02) return 56;
    if (value >= -0.08) return 36;
    return 18;
  }

  function scoreRangePosition(value) {
    if (!Number.isFinite(value)) return null;
    if (value >= 0.8) return 86;
    if (value >= 0.6) return 72;
    if (value >= 0.4) return 56;
    if (value >= 0.2) return 37;
    return 18;
  }

  function scoreRelativePerformance(value, strongLead) {
    if (!Number.isFinite(value)) return null;
    if (value >= strongLead) return 90;
    if (value >= strongLead * 0.3) return 75;
    if (value >= -strongLead * 0.3) return 55;
    if (value >= -strongLead) return 34;
    return 16;
  }

  function volumeSignalFor(priceReturn, volumeChange) {
    if (!Number.isFinite(priceReturn) || !Number.isFinite(volumeChange)) {
      return { score: null, label: "No data", description: "There was not enough recent trading activity to compare." };
    }
    const activity = volumeChange >= 0.15 ? "busier" : volumeChange <= -0.15 ? "quieter" : "near normal";
    const activityText = `${formatUnsignedPercent(volumeChange)} ${activity} than the previous few weeks`;

    if (priceReturn >= 0.02) {
      if (volumeChange >= 0.15) return { score: 86, label: "Rise supported", description: `The price rose ${formatUnsignedPercent(priceReturn)} in five days while trading was ${activityText}.` };
      if (volumeChange >= -0.15) return { score: 70, label: "Some support", description: `The price rose ${formatUnsignedPercent(priceReturn)} in five days with trading activity ${activity}.` };
      return { score: 52, label: "Weak support", description: `The price rose ${formatUnsignedPercent(priceReturn)} in five days, but trading was ${activityText}.` };
    }
    if (priceReturn <= -0.02) {
      if (volumeChange >= 0.15) return { score: 18, label: "Heavy selling", description: `The price fell ${formatUnsignedPercent(priceReturn)} in five days while trading was ${activityText}.` };
      if (volumeChange >= -0.15) return { score: 36, label: "Selling pressure", description: `The price fell ${formatUnsignedPercent(priceReturn)} in five days with trading activity ${activity}.` };
      return { score: 48, label: "Quiet pullback", description: `The price fell ${formatUnsignedPercent(priceReturn)} in five days, but trading was ${activityText}.` };
    }
    return { score: 56, label: "No clear push", description: `The price was almost unchanged over five days and trading activity was ${activity}.` };
  }

  function analyze(data) {
    const market = data.market || {};
    const history = (data.market?.history || []).filter((point) => Number.isFinite(safeNumber(point.close)));
    const current = safeNumber(history.at(-1)?.close);
    const volatility = calculateVolatility(history.slice(-252));
    const drawdown = calculateMaxDrawdown(history.slice(-252));
    const oneMonthReturn = periodReturn(history, 21);
    const threeMonthReturn = periodReturn(history, 63);
    const oneYearReturn = periodReturn(history, 252);
    const fiveDayReturn = periodReturn(history, 5);
    const average50 = movingAverage(history, 50);
    const average200 = movingAverage(history, 200);
    const distanceFrom50 = current && average50 ? current / average50 - 1 : null;
    const distanceFrom200 = current && average200 ? current / average200 - 1 : null;
    const averageCross = average50 && average200 ? average50 / average200 - 1 : null;
    const high = safeNumber(market.fiftyTwoWeekHigh);
    const low = safeNumber(market.fiftyTwoWeekLow);
    const distanceFromHigh = current && high ? current / high - 1 : null;
    const rangePosition = current && high && Number.isFinite(low) && high !== low
      ? (current - low) / (high - low)
      : null;
    const dailyReturns = calculateReturns(history.slice(-252));
    const typicalDailyMove = average(dailyReturns.map((value) => Math.abs(value)));
    const recentVolume = average(history.slice(-20).map((point) => safeNumber(point.volume)));
    const previousVolume = average(history.slice(-40, -20).map((point) => safeNumber(point.volume)));
    const volumeTrend = recentVolume && previousVolume ? recentVolume / previousVolume - 1 : null;
    const fiveDayVolume = average(history.slice(-5).map((point) => safeNumber(point.volume)));
    const normalVolume = average(history.slice(-25, -5).map((point) => safeNumber(point.volume)));
    const shortVolumeTrend = fiveDayVolume && normalVolume ? fiveDayVolume / normalVolume - 1 : null;
    const volumeSignal = volumeSignalFor(fiveDayReturn, shortVolumeTrend);
    const benchmarkHistory = (data.benchmark?.history || []).filter((point) => Number.isFinite(safeNumber(point.close)));
    const benchmarkThreeMonthReturn = periodReturn(benchmarkHistory, 63);
    const benchmarkOneYearReturn = periodReturn(benchmarkHistory, 252);
    const relativeThreeMonth = Number.isFinite(threeMonthReturn) && Number.isFinite(benchmarkThreeMonthReturn)
      ? threeMonthReturn - benchmarkThreeMonthReturn
      : null;
    const relativeOneYear = Number.isFinite(oneYearReturn) && Number.isFinite(benchmarkOneYearReturn)
      ? oneYearReturn - benchmarkOneYearReturn
      : null;
    const recentTrendScore = average([
      scorePriceReturn(oneMonthReturn, 0.08),
      scorePriceReturn(threeMonthReturn, 0.15),
      scoreAboveAverage(distanceFrom50)
    ]);
    const longTermScore = average([
      scorePriceReturn(oneYearReturn, 0.25),
      scoreAboveAverage(distanceFrom200),
      scoreAboveAverage(averageCross)
    ]);
    const marketComparisonScore = average([
      scoreRelativePerformance(relativeThreeMonth, 0.05),
      scoreRelativePerformance(relativeOneYear, 0.1)
    ]);
    const volumeSupportScore = volumeSignal.score;
    const rangeScore = scoreRangePosition(rangePosition);
    const stabilityScore = scoreStability(volatility, drawdown);

    const weightedInputs = [
      [recentTrendScore, 0.25],
      [longTermScore, 0.25],
      [marketComparisonScore, 0.2],
      [volumeSupportScore, 0.1],
      [rangeScore, 0.1],
      [stabilityScore, 0.1]
    ].filter(([value]) => Number.isFinite(value));
    const usedWeight = weightedInputs.reduce((total, [, weight]) => total + weight, 0);
    const overall = usedWeight
      ? weightedInputs.reduce((total, [value, weight]) => total + value * weight, 0) / usedWeight
      : null;

    return {
      overall: Number.isFinite(overall) ? Math.round(overall) : null,
      recentTrendScore,
      longTermScore,
      marketComparisonScore,
      volumeSupportScore,
      rangeScore,
      stabilityScore,
      fiveDayReturn,
      oneMonthReturn,
      threeMonthReturn,
      oneYearReturn,
      benchmarkThreeMonthReturn,
      benchmarkOneYearReturn,
      relativeThreeMonth,
      relativeOneYear,
      average50,
      average200,
      averageCross,
      distanceFrom50,
      distanceFrom200,
      distanceFromHigh,
      rangePosition,
      typicalDailyMove,
      recentVolume,
      volumeTrend,
      shortVolumeTrend,
      volumeSignal,
      volatility,
      drawdown,
      confidence: history.length >= 200 && benchmarkHistory.length >= 200
        ? "Full market comparison"
        : history.length >= 200
          ? "One-year price view"
          : "Limited price history"
    };
  }

  function verdictFor(analysis) {
    const score = analysis.overall;
    if (!Number.isFinite(score)) {
      return {
        title: "There is not enough information yet.",
        summary: "The API did not return enough usable price and company information to draw a conclusion. Try again later or verify the ticker with another trusted source."
      };
    }
    if (score >= 70) {
      return {
        title: "The price trend currently looks strong.",
        summary: "The trend, wider-market comparison, trading activity, and price risk combine into a strong price signal. Company profits, debt, and valuation are not included."
      };
    }
    if (score >= 50) {
      return {
        title: "The price signals are mixed right now.",
        summary: "Some measures look healthy while others need patience. Check the six questions below to see exactly where the mixed result comes from."
      };
    }
    return {
      title: "The price trend currently looks weak.",
      summary: "Momentum, range position, or price stability are giving caution signals. This describes the market price only, not the quality of the company."
    };
  }

  function decisionFor(analysis) {
    if (!Number.isFinite(analysis.overall)) {
      return {
        signal: "WAIT",
        status: "wait",
        note: "Not enough price data"
      };
    }
    if (analysis.overall >= 70) {
      return {
        signal: "BUY",
        status: "buy",
        note: "Company finances not included"
      };
    }
    if (analysis.overall >= 50) {
      return {
        signal: "WAIT",
        status: "wait",
        note: "Company finances not included"
      };
    }
    return {
      signal: "AVOID",
      status: "avoid",
      note: "Company finances not included"
    };
  }

  function descriptionForCheck(type, score, data, analysis) {
    if (type === "momentum") {
      if (!Number.isFinite(score)) return "There was not enough price history to measure the recent trend.";
      return `The price changed ${formatPercent(analysis.oneMonthReturn)} in one month and ${formatPercent(analysis.threeMonthReturn)} in three months.`;
    }
    if (type === "longterm") {
      if (!Number.isFinite(score)) return "There was not enough history for a longer-term comparison.";
      const relation50 = analysis.distanceFrom50 >= 0 ? "above" : "below";
      const relation200 = analysis.distanceFrom200 >= 0 ? "above" : "below";
      return `The price is ${formatUnsignedPercent(analysis.distanceFrom50)} ${relation50} its 50-day average and ${formatUnsignedPercent(analysis.distanceFrom200)} ${relation200} its 200-day average.`;
    }
    if (type === "market") {
      if (data.symbol === "SPY") return "SPY is the S&P 500 comparison fund, so it is treated as the neutral market starting point.";
      if (!Number.isFinite(score)) return "The S&P 500 comparison could not be loaded.";
      const useYear = Number.isFinite(analysis.relativeOneYear);
      const stockReturn = useYear ? analysis.oneYearReturn : analysis.threeMonthReturn;
      const benchmarkReturn = useYear ? analysis.benchmarkOneYearReturn : analysis.benchmarkThreeMonthReturn;
      const difference = useYear ? analysis.relativeOneYear : analysis.relativeThreeMonth;
      const result = difference >= 0 ? "ahead of" : "behind";
      return `Over ${useYear ? "one year" : "three months"}, this investment moved ${formatPercent(stockReturn)} versus ${formatPercent(benchmarkReturn)} for the S&P 500 — ${formatUnsignedPercent(difference)} ${result} the market.`;
    }
    if (type === "volume") {
      return analysis.volumeSignal.description;
    }
    if (type === "range") {
      if (!Number.isFinite(score)) return "The yearly price range could not be calculated.";
      return `The current price is ${formatUnsignedPercent(analysis.distanceFromHigh)} below its highest point of the past year.`;
    }
    if (!Number.isFinite(score)) return "There was not enough price history to judge the ride.";
    return `The annualized price variability was ${formatUnsignedPercent(analysis.volatility, 0)}, with a worst one-year slide of ${formatPercent(analysis.drawdown, 0)}.`;
  }

  function renderHeader(data) {
    const market = data.market || {};
    const current = safeNumber(market.currentPrice);
    const previous = safeNumber(market.previousClose);
    const change = Number.isFinite(current) && Number.isFinite(previous) ? current - previous : null;
    const percent = Number.isFinite(change) && previous ? change / previous : null;
    const currency = market.currency || data.currency || "USD";

    elements.companyLogo.textContent = (data.name || data.symbol || "?").slice(0, 1).toUpperCase();
    elements.companyName.textContent = data.name || data.symbol;
    elements.companySymbol.textContent = data.symbol;
    elements.companyMeta.textContent = [data.exchange, data.sector, currency].filter(Boolean).join(" · ");
    elements.currentPrice.textContent = formatCurrency(current, currency);
    elements.priceChange.className = "price-change neutral";
    if (Number.isFinite(change)) {
      const positive = change >= 0;
      elements.priceChange.className = `price-change ${positive ? "positive" : "negative"}`;
      elements.priceChange.textContent = `${positive ? "+" : "−"}${formatCurrency(Math.abs(change), currency)} (${formatPercent(percent)}) in the latest session`;
    } else {
      elements.priceChange.textContent = "Current change unavailable";
    }

    const priceDate = data.priceAsOf ? `Price through ${formatDate(data.priceAsOf)}` : "Price date unavailable";
    elements.freshness.textContent = `${priceDate} · Free Polygon end-of-day market data`;
  }

  function renderVerdict(data, analysis) {
    const verdict = verdictFor(analysis);
    const decision = decisionFor(analysis);
    const score = analysis.overall;
    const angle = Number.isFinite(score) ? `${score * 3.6}deg` : "0deg";
    elements.scoreRing.style.setProperty("--score-angle", angle);
    elements.overallScore.textContent = Number.isFinite(score) ? score : "—";
    elements.confidenceBadge.textContent = analysis.confidence;
    elements.decisionBadge.className = `decision-badge ${decision.status}`;
    elements.decisionSignal.textContent = decision.signal;
    elements.decisionNote.textContent = decision.note;
    elements.verdictTitle.textContent = verdict.title;
    elements.verdictSummary.textContent = verdict.summary;

    const marketText = data.symbol === "SPY"
      ? "Benchmark"
      : scoreState(analysis.marketComparisonScore) === "good"
        ? "Ahead"
        : scoreState(analysis.marketComparisonScore) === "weak"
          ? "Behind"
          : "Similar";
    const signalItems = [
      ["Recent trend", analysis.recentTrendScore, null],
      ["Long-term", analysis.longTermScore, null],
      ["Vs S&P 500", analysis.marketComparisonScore, marketText],
      ["Trading activity", analysis.volumeSupportScore, analysis.volumeSignal.label]
    ];
    elements.signalSummary.innerHTML = signalItems
      .map(([label, value, customText]) => {
        const status = scoreState(value);
        const text = Number.isFinite(value) ? customText || scoreLabel(value) : "Not enough data";
        return `<span class="signal-pill ${status === "good" ? "" : status}">${escapeHtml(label)}: ${escapeHtml(text)}</span>`;
      })
      .join("");
  }

  function renderChecks(data, analysis) {
    const checks = [
      { type: "momentum", title: "Is the price moving up?", score: analysis.recentTrendScore },
      { type: "longterm", title: "Is it above its usual prices?", score: analysis.longTermScore },
      { type: "market", title: "Is it beating the wider market?", score: analysis.marketComparisonScore },
      { type: "volume", title: "Does trading support the move?", score: analysis.volumeSupportScore },
      { type: "range", title: "Is it near its yearly high?", score: analysis.rangeScore },
      { type: "stability", title: "How bumpy has the ride been?", score: analysis.stabilityScore }
    ];

    elements.checkGrid.innerHTML = checks
      .map((check) => {
        const status = scoreState(check.score);
        const isBenchmark = check.type === "market" && data.symbol === "SPY";
        const scoreText = isBenchmark
          ? "Starting point"
          : Number.isFinite(check.score)
            ? `${Math.round(check.score)}/100`
            : "No score";
        const statusText = isBenchmark
          ? "Reference"
          : !Number.isFinite(check.score)
          ? "No data"
          : status === "good"
            ? "Strong"
            : status === "watch"
              ? "Mixed"
              : "Weak";
        return `
          <article class="check-card ${isBenchmark ? "info" : status === "good" ? "" : status}">
            <div class="check-card-top">
              <span class="check-icon" aria-hidden="true">${icons[check.type]}</span>
              <span class="check-result">
                <strong class="check-status">${statusText}</strong>
                <span class="check-score">${scoreText}</span>
              </span>
            </div>
            <h4>${escapeHtml(check.title)}</h4>
            <p>${escapeHtml(descriptionForCheck(check.type, check.score, data, analysis))}</p>
          </article>
        `;
      })
      .join("");
  }

  function metricStatus(score, labels = ["Strong", "Mixed", "Weak"]) {
    if (!Number.isFinite(score)) return { status: "watch", text: "No data" };
    const status = scoreState(score);
    const labelIndex = status === "good" ? 0 : status === "watch" ? 1 : 2;
    return { status, text: labels[labelIndex] };
  }

  function metric(label, source, value, explanation, indicator) {
    return `
      <article class="metric-item ${escapeHtml(indicator.status)}">
        <div class="metric-top">
          <div class="metric-label"><span>${escapeHtml(label)}</span><span>${escapeHtml(source)}</span></div>
          <span class="metric-status"><i aria-hidden="true"></i>${escapeHtml(indicator.text)}</span>
        </div>
        <strong>${escapeHtml(value)}</strong>
        <p>${escapeHtml(explanation)}</p>
      </article>
    `;
  }

  function renderMetrics(data, analysis) {
    const market = data.market || {};
    const currency = market.currency || data.currency || "USD";
    const high = safeNumber(market.fiftyTwoWeekHigh);
    const low = safeNumber(market.fiftyTwoWeekLow);
    const marketCap = safeNumber(market.marketCap);
    const averageIndicator = metricStatus(scoreAboveAverage(analysis.distanceFrom50), ["Above average", "Near average", "Below average"]);
    const comparisonIndicator = data.symbol === "SPY"
      ? { status: "info", text: "Benchmark" }
      : metricStatus(analysis.marketComparisonScore, ["Ahead", "Similar", "Behind"]);
    const returnIndicator = Number.isFinite(analysis.oneYearReturn)
      ? analysis.oneYearReturn >= 0.1
        ? { status: "good", text: "Rising" }
        : analysis.oneYearReturn >= -0.1
          ? { status: "watch", text: "Mostly flat" }
          : { status: "weak", text: "Falling" }
      : { status: "watch", text: "No data" };
    const movementIndicator = !Number.isFinite(analysis.typicalDailyMove)
      ? { status: "watch", text: "No data" }
      : analysis.typicalDailyMove <= 0.015
        ? { status: "good", text: "Calmer" }
        : analysis.typicalDailyMove <= 0.03
          ? { status: "watch", text: "Moderate" }
          : { status: "weak", text: "Bumpy" };
    const volumeText = Number.isFinite(analysis.volumeTrend)
      ? `${formatPercent(analysis.volumeTrend)} versus the previous 20 trading days.`
      : "Average number of shares traded over the latest 20 trading days.";
    const comparisonValue = data.symbol === "SPY"
      ? "Market benchmark"
      : Number.isFinite(analysis.relativeOneYear)
        ? formatPercent(analysis.relativeOneYear)
        : formatPercent(analysis.relativeThreeMonth);
    const comparisonPeriod = Number.isFinite(analysis.relativeOneYear) ? "one year" : "three months";
    const comparisonText = data.symbol === "SPY"
      ? "SPY is used as the wider-market starting point for every comparison."
      : `How much this investment led or lagged the S&P 500 over ${comparisonPeriod}.`;

    const sizeOrAverage = Number.isFinite(marketCap)
      ? metric("Company value", "Market capitalization", formatCompactCurrency(marketCap, currency), "The market's total value for all of the company's shares.", { status: "info", text: "Company size" })
      : metric("Price vs usual level", "50-day average", formatPercent(analysis.distanceFrom50), `The current price compared with its ${formatCurrency(analysis.average50, currency)} 50-day average.`, averageIndicator);

    const items = [
      sizeOrAverage,
      metric("52-week price range", "Daily highs and lows", `${formatCurrency(low, currency, 0)} – ${formatCurrency(high, currency, 0)}`, "The lowest and highest traded prices in the available year.", { status: "info", text: "Year context" }),
      metric("One-year price change", "Longer direction", formatPercent(analysis.oneYearReturn), "How the daily closing price moved over roughly one year.", returnIndicator),
      metric("Compared with S&P 500", "Wider market", comparisonValue, comparisonText, comparisonIndicator),
      metric("Average daily volume", "Latest 20 days", `${formatCompactNumber(analysis.recentVolume)} shares`, volumeText, metricStatus(analysis.volumeSupportScore, ["Supports move", "Mixed", "Warning"])),
      metric("Typical daily move", "Average change", formatUnsignedPercent(analysis.typicalDailyMove), "The average up-or-down movement on a normal trading day.", movementIndicator)
    ];

    elements.metricsGrid.innerHTML = items.join("");
    elements.numbersNote.textContent = "Calculated from free Polygon daily price and volume data. No paid financial figures used.";
  }

  function buildReasons(data, analysis) {
    const positives = [];
    const cautions = [];

    if (Number.isFinite(analysis.threeMonthReturn)) {
      if (analysis.threeMonthReturn >= 0.05) positives.push(`The price rose ${formatUnsignedPercent(analysis.threeMonthReturn)} over three months.`);
      else if (analysis.threeMonthReturn < -0.05) cautions.push(`The price fell ${formatUnsignedPercent(analysis.threeMonthReturn)} over three months.`);
      else cautions.push("The three-month price direction was mostly flat.");
    }

    if (Number.isFinite(analysis.oneYearReturn)) {
      if (analysis.oneYearReturn >= 0.1) positives.push(`The one-year price change was ${formatPercent(analysis.oneYearReturn)}.`);
      else if (analysis.oneYearReturn < -0.1) cautions.push(`The price fell ${formatUnsignedPercent(analysis.oneYearReturn)} over one year.`);
    }

    if (data.symbol !== "SPY" && Number.isFinite(analysis.relativeOneYear)) {
      if (analysis.relativeOneYear >= 0.03) positives.push(`It beat the S&P 500 by ${formatUnsignedPercent(analysis.relativeOneYear)} over one year.`);
      else if (analysis.relativeOneYear <= -0.03) cautions.push(`It trailed the S&P 500 by ${formatUnsignedPercent(analysis.relativeOneYear)} over one year.`);
    }

    if (Number.isFinite(analysis.volumeSupportScore)) {
      if (analysis.volumeSupportScore >= 67) positives.push(`Recent trading activity gave the price move support: ${analysis.volumeSignal.label.toLowerCase()}.`);
      else if (analysis.volumeSupportScore < 43) cautions.push(`Recent trading activity showed caution: ${analysis.volumeSignal.label.toLowerCase()}.`);
    }

    if (Number.isFinite(analysis.distanceFrom50)) {
      if (analysis.distanceFrom50 >= 0.02) positives.push(`The price was ${formatUnsignedPercent(analysis.distanceFrom50)} above its 50-day average.`);
      else if (analysis.distanceFrom50 < -0.02) cautions.push(`The price was ${formatUnsignedPercent(analysis.distanceFrom50)} below its 50-day average.`);
    }

    if (Number.isFinite(analysis.rangePosition)) {
      if (analysis.rangePosition >= 0.75) positives.push("The price was trading in the upper part of its yearly range.");
      else if (analysis.rangePosition <= 0.3) cautions.push("The price was trading near the lower part of its yearly range.");
    }

    if (Number.isFinite(analysis.typicalDailyMove)) {
      if (analysis.typicalDailyMove <= 0.015) positives.push("Typical daily price movement was relatively calm.");
      else if (analysis.typicalDailyMove >= 0.03) cautions.push("Typical daily price movement was relatively bumpy.");
    }

    if (Number.isFinite(analysis.drawdown) && analysis.drawdown <= -0.25) {
      cautions.push(`The price experienced a ${formatUnsignedPercent(analysis.drawdown, 0)} fall from a recent high.`);
    }

    const positiveFallbacks = [
      "The latest end-of-day market price was available.",
      "A full year of daily prices provides useful context.",
      "The signal uses transparent price rules that can be checked."
    ];
    const cautionFallbacks = [
      "Free price data cannot show revenue, profit, debt, or cash flow.",
      "A rising price does not prove that the company is fairly valued.",
      "Historical price movement does not predict what happens next."
    ];
    positiveFallbacks.forEach((reason) => {
      if (positives.length < 3 && !positives.includes(reason)) positives.push(reason);
    });
    cautionFallbacks.forEach((reason) => {
      if (cautions.length < 3 && !cautions.includes(reason)) cautions.push(reason);
    });

    return { positives: positives.slice(0, 4), cautions: cautions.slice(0, 4) };
  }

  function renderReasons(data, analysis) {
    const reasons = buildReasons(data, analysis);
    elements.positiveList.innerHTML = reasons.positives.map((reason) => `<li>${escapeHtml(reason)}</li>`).join("");
    elements.cautionList.innerHTML = reasons.cautions.map((reason) => `<li>${escapeHtml(reason)}</li>`).join("");
  }

  const contextLabels = {
    dividends: "Show dividends",
    news: "Show recent news",
    risks: "Show company risks"
  };

  function contextElement(type) {
    if (type === "dividends") return elements.dividendResult;
    if (type === "news") return elements.newsResult;
    return elements.riskResult;
  }

  function safeExternalUrl(value) {
    try {
      const url = new URL(value);
      return ["http:", "https:"].includes(url.protocol) ? url.toString() : null;
    } catch {
      return null;
    }
  }

  function humanizeKey(value) {
    const text = String(value || "").replaceAll("_", " ").replace(/\s+/g, " ").trim();
    if (!text) return "Reported risk";
    return text.replace(/\b\w/g, (letter) => letter.toUpperCase());
  }

  function resetContextPanels() {
    Object.entries(contextLabels).forEach(([type, label]) => {
      const result = contextElement(type);
      result.removeAttribute("aria-busy");
      result.innerHTML = `<button class="context-load" type="button" data-context="${type}">${label}</button>`;
    });
  }

  async function dividendContext(data, onWait) {
    const end = new Date();
    const start = new Date(end);
    start.setUTCFullYear(start.getUTCFullYear() - 1);
    const payload = await polygonRequest(
      "/stocks/v1/dividends",
      {
        ticker: data.symbol,
        "ex_dividend_date.gte": isoDate(start),
        "ex_dividend_date.lte": isoDate(end),
        limit: 100,
        sort: "ex_dividend_date.desc"
      },
      true,
      { root: polygonExtraApiRoot, onWait }
    );
    const payments = (payload?.results || [])
      .filter((item) => item.ex_dividend_date)
      .sort((left, right) => String(right.ex_dividend_date).localeCompare(String(left.ex_dividend_date)));
    if (!payments.length) {
      return `<div class="context-empty"><strong>No cash dividend found</strong><span>No payment was listed during the past year. Some companies and growth funds do not pay dividends.</span></div>`;
    }

    const annualAmount = payments.reduce((total, item) => {
      const amount = safeNumber(item.split_adjusted_cash_amount ?? item.cash_amount);
      return total + (amount || 0);
    }, 0);
    const currentPrice = safeNumber(data.market?.currentPrice);
    const dividendYield = currentPrice ? annualAmount / currentPrice : null;
    const currency = String(payments[0].currency || data.currency || "USD").toUpperCase();
    const recentPayments = payments.slice(0, 3).map((item) => {
      const amount = safeNumber(item.split_adjusted_cash_amount ?? item.cash_amount);
      return `<li><span>${escapeHtml(formatDate(item.ex_dividend_date))}</span><strong>${escapeHtml(formatCurrency(amount, currency))} per share</strong></li>`;
    }).join("");

    return `
      <div class="context-highlight">
        <span>Past 12 months</span>
        <strong>${escapeHtml(formatCurrency(annualAmount, currency))} per share</strong>
        <small>${Number.isFinite(dividendYield) ? `${escapeHtml(formatUnsignedPercent(dividendYield))} of the current price` : "Yield could not be calculated"}</small>
      </div>
      <ul class="context-mini-list">${recentPayments}</ul>
      <p class="context-disclaimer">Past payments can change and are not guaranteed.</p>
    `;
  }

  function articleSentiment(article, symbol) {
    const insight = (article.insights || []).find((item) => String(item.ticker || "").toUpperCase() === symbol)
      || (article.insights || [])[0];
    const sentiment = String(insight?.sentiment || "neutral").toLowerCase();
    if (sentiment === "positive") return { className: "positive", label: "Positive" };
    if (sentiment === "negative") return { className: "negative", label: "Negative" };
    return { className: "neutral", label: "Neutral" };
  }

  async function newsContext(data, onWait) {
    const payload = await polygonRequest(
      "/v2/reference/news",
      { ticker: data.symbol, limit: 3, sort: "published_utc", order: "desc" },
      true,
      { root: polygonExtraApiRoot, onWait }
    );
    const articles = payload?.results || [];
    if (!articles.length) {
      return `<div class="context-empty"><strong>No recent headlines found</strong><span>The news feed did not return coverage for this ticker.</span></div>`;
    }

    const items = articles.map((article) => {
      const url = safeExternalUrl(article.article_url);
      const sentiment = articleSentiment(article, data.symbol);
      const source = article.publisher?.name || "News source";
      const content = `
        <span class="news-copy"><strong>${escapeHtml(article.title || "Untitled article")}</strong><small>${escapeHtml(source)} · ${escapeHtml(formatDate(article.published_utc))}</small></span>
        <em class="news-sentiment ${sentiment.className}">${sentiment.label}</em>
      `;
      return url
        ? `<a class="context-news-item" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${content}</a>`
        : `<div class="context-news-item">${content}</div>`;
    }).join("");

    return `<div class="context-news-list">${items}</div><p class="context-disclaimer">Sentiment is a news label, not a recommendation, and does not affect the price signal.</p>`;
  }

  async function riskContext(data, onWait) {
    const payload = await polygonRequest(
      "/stocks/filings/vX/risk-factors",
      { ticker: data.symbol, limit: 40, sort: "filing_date.desc" },
      true,
      { root: polygonExtraApiRoot, onWait }
    );
    const results = payload?.results || [];
    const cik = results[0]?.cik || data.cik;
    const secUrl = cik
      ? safeExternalUrl(`https://www.sec.gov/edgar/browse/?CIK=${encodeURIComponent(cik)}&owner=exclude&action=getcompany&type=10-K`)
      : null;
    if (!results.length) {
      const link = secUrl ? `<a class="context-source-link" href="${escapeHtml(secUrl)}" target="_blank" rel="noopener noreferrer">Open official SEC filings</a>` : "";
      return `<div class="context-empty"><strong>No company risk categories found</strong><span>ETFs and some non-US companies may not file a US 10-K.</span>${link}</div>`;
    }

    const latestFiling = results.map((item) => item.filing_date).filter(Boolean).sort().at(-1) || null;
    const seen = new Set();
    const risks = results
      .filter((item) => !latestFiling || item.filing_date === latestFiling)
      .filter((item) => {
        const key = item.tertiary_category || item.secondary_category || item.primary_category;
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(0, 4);
    const riskItems = risks.map((item) => {
      const main = humanizeKey(item.tertiary_category || item.secondary_category || item.primary_category);
      const group = humanizeKey(item.primary_category);
      return `<li><strong>${escapeHtml(main)}</strong><span>${escapeHtml(group)}</span></li>`;
    }).join("");
    const sourceLink = secUrl ? `<a class="context-source-link" href="${escapeHtml(secUrl)}" target="_blank" rel="noopener noreferrer">Read the official filing</a>` : "";

    return `
      <div class="risk-summary"><span>Latest available filing${latestFiling ? ` · ${escapeHtml(formatDate(latestFiling))}` : ""}</span><ul>${riskItems}</ul></div>
      ${sourceLink}
      <p class="context-disclaimer">These are risks reported by the company, not an independent risk rating.</p>
    `;
  }

  async function loadContext(type) {
    const result = contextElement(type);
    const data = state.data;
    const loadId = state.loadId;
    if (!result || !data) return;
    result.setAttribute("aria-busy", "true");
    result.innerHTML = `<div class="context-loading"><i aria-hidden="true"></i><span>Loading this extra information…</span></div>`;
    const onWait = (seconds) => {
      if (state.loadId !== loadId) return;
      result.innerHTML = `<div class="context-loading waiting"><i aria-hidden="true"></i><span>The free data service is taking a short pause. This will continue automatically in about ${seconds} seconds.</span></div>`;
    };

    try {
      const html = type === "dividends"
        ? await dividendContext(data, onWait)
        : type === "news"
          ? await newsContext(data, onWait)
          : await riskContext(data, onWait);
      if (state.loadId !== loadId) return;
      result.innerHTML = html;
    } catch (error) {
      if (state.loadId !== loadId) return;
      const message = error.message?.includes("free request limit")
        ? "The free data service is busy. Wait about one minute and try again."
        : "This extra information is unavailable right now. The main price analysis still works.";
      result.innerHTML = `<div class="context-empty"><strong>Could not load this section</strong><span>${escapeHtml(message)}</span><button class="context-load retry" type="button" data-context="${escapeHtml(type)}">Try again</button></div>`;
    } finally {
      if (state.loadId === loadId) result.removeAttribute("aria-busy");
    }
  }

  function renderChart() {
    const fullHistory = state.data?.market?.history || [];
    const data = fullHistory.slice(-state.chartRange).filter((point) => Number.isFinite(safeNumber(point.close)));
    state.chartData = data;
    elements.chartTooltip.hidden = true;

    if (data.length < 2) {
      elements.priceChart.innerHTML = "";
      elements.chartAxis.innerHTML = "";
      elements.periodReturn.textContent = "Not available";
      elements.periodReturn.className = "";
      return;
    }

    const width = 900;
    const height = 300;
    const paddingX = 8;
    const paddingY = 18;
    const values = data.map((point) => safeNumber(point.close));
    const minimum = Math.min(...values);
    const maximum = Math.max(...values);
    const range = maximum - minimum || Math.max(maximum * 0.02, 1);

    const points = data.map((point, index) => {
      const x = paddingX + (index / (data.length - 1)) * (width - paddingX * 2);
      const y = paddingY + ((maximum - point.close) / range) * (height - paddingY * 2);
      return { x, y, ...point };
    });

    const line = points.map((point, index) => `${index === 0 ? "M" : "L"} ${point.x.toFixed(2)} ${point.y.toFixed(2)}`).join(" ");
    const area = `${line} L ${points.at(-1).x.toFixed(2)} ${height} L ${points[0].x.toFixed(2)} ${height} Z`;
    const firstPrice = values[0];
    const lastPrice = values.at(-1);
    const positive = lastPrice >= firstPrice;
    const stroke = positive ? "#287653" : "#b14b43";
    const fill = positive ? "#4fa26f" : "#cf7067";

    elements.priceChart.innerHTML = `
      <defs>
        <linearGradient id="chart-fill" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stop-color="${fill}" stop-opacity="0.24" />
          <stop offset="100%" stop-color="${fill}" stop-opacity="0" />
        </linearGradient>
      </defs>
      <path d="${area}" fill="url(#chart-fill)" />
      <path d="${line}" fill="none" stroke="${stroke}" stroke-width="3" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke" />
      <line id="chart-guide" x1="0" x2="0" y1="0" y2="300" stroke="rgba(23,33,27,.18)" stroke-width="1" stroke-dasharray="4 5" hidden />
      <circle id="chart-point" cx="0" cy="0" r="5" fill="${stroke}" stroke="#fffefa" stroke-width="3" vector-effect="non-scaling-stroke" hidden />
    `;

    const periodReturn = lastPrice / firstPrice - 1;
    elements.periodReturn.textContent = formatPercent(periodReturn);
    elements.periodReturn.className = positive ? "positive" : "negative";
    elements.periodLabel.textContent = state.chartRange === 30 ? "over the last month" : "over the last 3 months";

    const midpoint = data[Math.floor((data.length - 1) / 2)];
    elements.chartAxis.innerHTML = `<span>${formatShortDate(data[0].date)}</span><span>${formatShortDate(midpoint.date)}</span><span>${formatShortDate(data.at(-1).date)}</span>`;
    elements.priceChart.setAttribute(
      "aria-label",
      `${data[0].date} to ${data.at(-1).date}. Price changed ${formatPercent(periodReturn)}.`
    );
  }

  function handleChartPointer(event) {
    if (!state.chartData.length) return;
    const bounds = elements.chartWrap.getBoundingClientRect();
    const x = clamp(event.clientX - bounds.left, 0, bounds.width);
    const index = Math.round((x / bounds.width) * (state.chartData.length - 1));
    const point = state.chartData[index];
    const values = state.chartData.map((item) => safeNumber(item.close));
    const minimum = Math.min(...values);
    const maximum = Math.max(...values);
    const range = maximum - minimum || Math.max(maximum * 0.02, 1);
    const y = 18 + ((maximum - point.close) / range) * (300 - 36);
    const svgX = 8 + (index / (state.chartData.length - 1)) * (900 - 16);

    const guide = document.querySelector("#chart-guide");
    const dot = document.querySelector("#chart-point");
    if (!guide || !dot) return;
    guide.hidden = false;
    guide.setAttribute("x1", svgX);
    guide.setAttribute("x2", svgX);
    dot.hidden = false;
    dot.setAttribute("cx", svgX);
    dot.setAttribute("cy", y);

    elements.chartTooltip.hidden = false;
    elements.chartTooltip.style.left = `${(svgX / 900) * 100}%`;
    elements.chartTooltip.style.top = `${(y / 300) * 100}%`;
    elements.chartTooltip.innerHTML = `<strong>${formatCurrency(point.close, state.data.market?.currency || "USD")}</strong><span>${formatDate(point.date)}</span>`;
  }

  function hideChartPointer() {
    elements.chartTooltip.hidden = true;
    const guide = document.querySelector("#chart-guide");
    const dot = document.querySelector("#chart-point");
    if (guide) guide.hidden = true;
    if (dot) dot.hidden = true;
  }

  function renderDashboard(data) {
    const analysis = analyze(data);
    state.analysis = analysis;
    renderHeader(data);
    renderVerdict(data, analysis);
    renderChecks(data, analysis);
    renderChart();
    renderMetrics(data, analysis);
    renderReasons(data, analysis);
  }

  function syncPageIdentity(data, symbol) {
    if (window.location.protocol !== "file:") {
      const url = new URL(window.location.href);
      url.searchParams.set("symbol", symbol);
      window.history.replaceState({}, "", url);
    }
    document.title = `${data.name || symbol} (${symbol}) — PlainStock`;
  }

  function renderPricePreview(data, symbol, options = {}) {
    const analysis = analyze(data);
    const pendingChecks = [
      ["momentum", "Is the price moving up?"],
      ["longterm", "Is it above its usual prices?"],
      ["market", "Is it beating the wider market?"],
      ["volume", "Does trading support the move?"],
      ["range", "Is it near its yearly high?"],
      ["stability", "How bumpy has the ride been?"]
    ];

    state.data = data;
    state.analysis = analysis;
    elements.dashboard.hidden = false;
    resetContextPanels();
    renderHeader(data);
    renderChart();
    renderMetrics(data, analysis);

    elements.scoreRing.style.setProperty("--score-angle", "0deg");
    elements.overallScore.textContent = "—";
    elements.confidenceBadge.textContent = "Comparing market";
    elements.verdictTitle.textContent = "Latest price ready. Finishing the full signal…";
    elements.verdictSummary.textContent = "The price chart is ready. We are now comparing this investment with the S&P 500 before showing BUY, WAIT, or AVOID.";
    elements.decisionBadge.className = "decision-badge wait";
    elements.decisionSignal.textContent = "CHECKING";
    elements.decisionNote.textContent = "Waiting for the complete comparison";
    elements.signalSummary.innerHTML = `<span class="signal-pill">Price loaded</span><span class="signal-pill watch">Market comparison loading</span>`;
    elements.checkGrid.innerHTML = pendingChecks.map(([type, title]) => `
      <article class="check-card info">
        <div class="check-card-top">
          <span class="check-icon" aria-hidden="true">${icons[type]}</span>
          <span class="check-result"><strong class="check-status">Checking</strong><span class="check-score">—</span></span>
        </div>
        <h4>${escapeHtml(title)}</h4>
        <p>Finishing the wider-market comparison.</p>
      </article>
    `).join("");
    elements.numbersNote.textContent = "Price facts are ready. The wider-market comparison is still loading.";
    elements.positiveList.innerHTML = "<li>Latest price and chart are ready to review.</li>";
    elements.cautionList.innerHTML = "<li>Wait for the complete comparison before using the price signal.</li>";
    elements.contextGrid.querySelectorAll("button").forEach((button) => {
      button.disabled = true;
      button.textContent = "Available in a moment";
    });
    syncPageIdentity(data, symbol);
    if (options.scroll) elements.dashboard.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function presentStockData(data, symbol, options = {}) {
    state.data = data;
    elements.dashboard.hidden = false;
    resetContextPanels();
    renderDashboard(data);
    elements.message.hidden = true;
    syncPageIdentity(data, symbol);
    if (options.scroll) elements.dashboard.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function cancelDefaultLoad() {
    const hadScheduledLoad = Boolean(state.defaultLoadTimer);
    if (state.defaultLoadTimer) {
      window.clearTimeout(state.defaultLoadTimer);
      state.defaultLoadTimer = null;
    }
    if (state.defaultLoadInProgress) {
      state.defaultLoadInProgress = false;
      if (!state.data) {
        state.loadId += 1;
        elements.dashboard.classList.remove("loading");
        elements.dashboard.hidden = true;
        elements.message.hidden = true;
      }
    }
    if (hadScheduledLoad && !state.data) elements.message.hidden = true;
  }

  async function loadLiveStock(stock, options = {}) {
    cancelDefaultLoad();
    const symbol = String(stock.symbol || "").trim().toUpperCase();
    if (!symbol) return;
    const normalizedStock = { ...stock, symbol };
    const loadId = ++state.loadId;
    state.defaultLoadInProgress = Boolean(options.isDefault);
    closeSearchResults();
    state.selectedSearchValue = elements.search.value.trim();
    const cachedData = readMemoryCache(state.stockCache, symbol);
    if (cachedData) {
      state.defaultLoadInProgress = false;
      elements.dashboard.classList.remove("loading");
      presentStockData(cachedData, symbol, options);
      return;
    }

    elements.dashboard.hidden = false;
    elements.dashboard.classList.add("loading");
    elements.message.hidden = false;
    if (!polygonApiKey) {
      elements.message.textContent = "Live search is not connected yet. Add your Polygon key in config.js, then reload the page.";
      elements.dashboard.classList.remove("loading");
      state.defaultLoadInProgress = false;
      return;
    }

    let previewShown = false;
    try {
      elements.message.textContent = `Getting the latest available Polygon data for ${symbol}…`;
      const data = await fetchPolygonStock(normalizedStock, (seconds) => {
        if (state.loadId !== loadId) return;
        elements.message.textContent = `The free data service is taking a short pause. ${symbol} will continue loading automatically in about ${seconds} seconds.`;
      }, (previewData) => {
        if (state.loadId !== loadId) return;
        previewShown = true;
        renderPricePreview(previewData, symbol, options);
        elements.dashboard.classList.remove("loading");
        elements.message.textContent = `${symbol} price loaded. Finishing the wider-market comparison…`;
      }, () => state.loadId === loadId);
      if (state.loadId !== loadId) return;
      writeMemoryCache(state.stockCache, symbol, data);
      presentStockData(data, symbol, { ...options, scroll: options.scroll && !previewShown });
    } catch (error) {
      if (error.name === "AbortError" || state.loadId !== loadId) return;
      elements.message.textContent = error.message;
      elements.message.hidden = false;
      if (!state.data) elements.dashboard.hidden = true;
    } finally {
      if (state.loadId === loadId) {
        state.defaultLoadInProgress = false;
        elements.dashboard.classList.remove("loading");
      }
    }
  }

  function stockOption(stock, index) {
    const details = [stock.symbol, stock.exchange, stock.type].filter(Boolean).join(" · ");
    return `
      <button class="search-option ${index === state.activeSearchIndex ? "active" : ""}" type="button" role="option" data-symbol="${stock.symbol}" aria-selected="${index === state.activeSearchIndex}">
        <span class="mini-logo">${escapeHtml(stock.name.slice(0, 1))}</span>
        <span class="search-option-copy"><strong>${escapeHtml(stock.name)}</strong><small>${escapeHtml(details)}</small></span>
        <span class="search-option-status live">API</span>
      </button>
    `;
  }

  function requestedTicker(query) {
    const symbol = String(query || "").trim().toUpperCase().replaceAll(".", "-");
    return /^[A-Z0-9-]{1,10}$/.test(symbol) ? symbol : null;
  }

  function selectSearchStock(stock) {
    elements.search.value = stock.name;
    state.selectedSearchValue = stock.name;
    loadLiveStock(stock, { scroll: true });
  }

  function stockFromPolygon(result) {
    const symbol = String(result?.ticker || "").toUpperCase();
    return {
      symbol,
      name: result?.name || symbol,
      exchange: result?.primary_exchange || "US",
      currency: String(result?.currency_name || "USD").toUpperCase(),
      type: result?.type || "Stock",
      sector: friendlySecurityType(result?.type),
      cik: result?.cik || null,
      referenceComplete: true
    };
  }

  function renderSearchMatches(query, matches) {
    const requested = requestedTicker(query);
    elements.searchResults.innerHTML = matches.length
      ? matches.map(stockOption).join("")
      : `<div class="search-empty">
          <strong>No matching stock was returned by Polygon</strong>
          <span>${requested ? `Check that ${escapeHtml(requested)} is the correct ticker code.` : "Try a company name or exact ticker code."}</span>
        </div>`;
    elements.searchResults.classList.add("open");
    elements.search.setAttribute("aria-expanded", "true");
  }

  async function runStockSearch(query, options = {}) {
    const normalized = String(query || "").trim();
    if (!normalized) {
      closeSearchResults();
      return [];
    }
    if (!polygonApiKey) {
      state.searchMatches = [];
      elements.searchResults.innerHTML = `<div class="search-empty"><strong>Live search is not connected</strong><span>Add the Polygon API key in config.js and reload.</span></div>`;
      elements.searchResults.classList.add("open");
      elements.search.setAttribute("aria-expanded", "true");
      return [];
    }

    const requestId = ++state.searchRequestId;
    const cacheKey = normalized.toLowerCase();
    const cachedMatches = readMemoryCache(state.searchCache, cacheKey);
    if (cachedMatches) {
      state.searchMatches = cachedMatches;
      state.activeSearchIndex = -1;
      renderSearchMatches(normalized, cachedMatches);
      if (options.selectFirst && cachedMatches[0]) selectSearchStock(cachedMatches[0]);
      return cachedMatches;
    }
    elements.searchResults.innerHTML = `<div class="search-empty"><strong>Searching the live market…</strong><span>Looking up ${escapeHtml(normalized)} with Polygon.</span></div>`;
    elements.searchResults.classList.add("open");
    elements.search.setAttribute("aria-expanded", "true");

    try {
      const payload = await polygonRequest(
        "/v3/reference/tickers",
        { search: normalized, active: true, market: "stocks", limit: 8 },
        false,
        {
          onWait: (seconds) => {
            if (requestId !== state.searchRequestId) return;
            elements.searchResults.innerHTML = `<div class="search-empty"><strong>The free search is taking a short pause</strong><span>Results will appear automatically in about ${seconds} seconds.</span></div>`;
          }
        }
      );
      if (requestId !== state.searchRequestId) return [];
      const lowered = normalized.toLowerCase();
      const matches = (payload?.results || [])
        .map(stockFromPolygon)
        .filter((stock) => stock.symbol)
        .sort((left, right) => {
          const rank = (stock) => {
            const symbol = stock.symbol.toLowerCase();
            const name = stock.name.toLowerCase();
            if (symbol === lowered) return 0;
            if (symbol.startsWith(lowered)) return 1;
            if (name.startsWith(lowered)) return 2;
            return 3;
          };
          return rank(left) - rank(right) || left.symbol.localeCompare(right.symbol);
        });
      state.searchMatches = matches;
      state.activeSearchIndex = -1;
      writeMemoryCache(state.searchCache, cacheKey, matches);
      renderSearchMatches(normalized, matches);
      if (options.selectFirst && matches[0]) selectSearchStock(matches[0]);
      return matches;
    } catch (error) {
      if (requestId !== state.searchRequestId) return [];
      state.searchMatches = [];
      elements.searchResults.innerHTML = `<div class="search-empty"><strong>Search could not load</strong><span>${escapeHtml(error.message)}</span></div>`;
      elements.searchResults.classList.add("open");
      elements.search.setAttribute("aria-expanded", "true");
      return [];
    }
  }

  function searchStocks(query) {
    window.clearTimeout(state.searchTimer);
    state.searchRequestId += 1;
    state.searchMatches = [];
    state.activeSearchIndex = -1;
    const normalized = String(query || "").trim();
    if (!normalized) {
      closeSearchResults();
      return;
    }
    if (normalized.length < 2) {
      elements.searchResults.innerHTML = `<div class="search-empty"><strong>Type one more character</strong><span>Or press Enter if ${escapeHtml(normalized.toUpperCase())} is the exact ticker.</span></div>`;
      elements.searchResults.classList.add("open");
      elements.search.setAttribute("aria-expanded", "true");
      return;
    }
    const cachedMatches = readMemoryCache(state.searchCache, normalized.toLowerCase());
    if (cachedMatches) {
      state.searchMatches = cachedMatches;
      renderSearchMatches(normalized, cachedMatches);
      return;
    }
    state.searchTimer = window.setTimeout(() => runStockSearch(normalized), searchDelay);
  }

  function closeSearchResults() {
    elements.searchResults.classList.remove("open");
    elements.search.setAttribute("aria-expanded", "false");
    state.activeSearchIndex = -1;
  }

  function updateActiveSearch() {
    elements.searchResults.innerHTML = state.searchMatches.map(stockOption).join("");
    const active = elements.searchResults.querySelector(".active");
    active?.scrollIntoView({ block: "nearest" });
  }

  function bindEvents() {
    elements.search.addEventListener("input", (event) => {
      cancelDefaultLoad();
      state.selectedSearchValue = "";
      searchStocks(event.target.value);
    });
    elements.search.addEventListener("focus", () => {
      cancelDefaultLoad();
      const value = elements.search.value.trim();
      if (value && value !== state.selectedSearchValue) searchStocks(value);
    });
    elements.search.addEventListener("keydown", (event) => {
      if (event.key === "ArrowDown") {
        if (!state.searchMatches.length) return;
        event.preventDefault();
        state.activeSearchIndex = Math.min(state.activeSearchIndex + 1, state.searchMatches.length - 1);
        updateActiveSearch();
      } else if (event.key === "ArrowUp") {
        if (!state.searchMatches.length) return;
        event.preventDefault();
        state.activeSearchIndex = Math.max(state.activeSearchIndex - 1, 0);
        updateActiveSearch();
      } else if (event.key === "Enter" && state.activeSearchIndex >= 0) {
        event.preventDefault();
        const selected = state.searchMatches[state.activeSearchIndex];
        selectSearchStock(selected);
      } else if (event.key === "Enter") {
        event.preventDefault();
        window.clearTimeout(state.searchTimer);
        const exactSymbol = requestedTicker(elements.search.value);
        const selected = state.searchMatches.find((stock) => stock.symbol === exactSymbol)
          || state.searchMatches[0];
        if (selected) {
          selectSearchStock(selected);
        } else if (exactSymbol) {
          loadLiveStock({ symbol: exactSymbol, name: exactSymbol, exchange: "US", currency: "USD" }, { scroll: true });
        } else {
          runStockSearch(elements.search.value, { selectFirst: true });
        }
      } else if (event.key === "Escape") {
        closeSearchResults();
      }
    });

    elements.searchResults.addEventListener("click", (event) => {
      const option = event.target.closest("[data-symbol]");
      if (!option) return;
      const stock = state.searchMatches.find((item) => item.symbol === option.dataset.symbol);
      if (stock) selectSearchStock(stock);
    });

    document.addEventListener("click", (event) => {
      if (!elements.searchShell.contains(event.target)) closeSearchResults();
    });

    document.addEventListener("keydown", (event) => {
      if (event.key === "/" && document.activeElement !== elements.search) {
        event.preventDefault();
        elements.search.focus();
      }
    });

    document.querySelector(".stock-starters").addEventListener("click", (event) => {
      const button = event.target.closest("[data-symbol]");
      if (button) {
        const symbol = button.dataset.symbol;
        const name = button.dataset.name || symbol;
        elements.search.value = symbol;
        state.selectedSearchValue = symbol;
        loadLiveStock({ symbol, name, exchange: "US", currency: "USD" }, { scroll: true });
      }
    });

    document.querySelector(".range-switcher").addEventListener("click", (event) => {
      const button = event.target.closest("[data-range]");
      if (!button) return;
      state.chartRange = Number(button.dataset.range);
      document.querySelectorAll(".range-switcher button").forEach((item) => item.classList.toggle("active", item === button));
      renderChart();
    });

    elements.chartWrap.addEventListener("pointermove", handleChartPointer);
    elements.chartWrap.addEventListener("pointerleave", hideChartPointer);

    elements.contextGrid.addEventListener("click", (event) => {
      const button = event.target.closest("[data-context]");
      if (button) loadContext(button.dataset.context);
    });

  }

  function initialize() {
    bindEvents();
    const requestedSymbol = requestedTicker(new URLSearchParams(window.location.search).get("symbol"));
    if (requestedSymbol) {
      loadLiveStock({
        symbol: requestedSymbol,
        name: requestedSymbol,
        exchange: "US",
        currency: "USD"
      });
      return;
    }

    elements.dashboard.hidden = true;
    elements.message.hidden = false;
    elements.message.textContent = "Choose a stock above. An Apple example will load shortly if you pause.";
    state.defaultLoadTimer = window.setTimeout(() => {
      state.defaultLoadTimer = null;
      loadLiveStock({
        symbol: "AAPL",
        name: "Apple",
        exchange: "US",
        currency: "USD"
      }, { isDefault: true });
    }, defaultStockDelayMs);
  }

  initialize();
})();
