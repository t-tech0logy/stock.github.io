(() => {
  "use strict";

  const polygonApiKey = String(window.PLAINSTOCK_CONFIG?.polygonApiKey || "").trim();
  const polygonApiRoot = String(window.PLAINSTOCK_CONFIG?.polygonApiRoot || "https://api.polygon.io").replace(/\/$/, "");
  const searchDelay = 450;
  const state = {
    data: null,
    chartRange: 90,
    chartData: [],
    activeSearchIndex: -1,
    searchMatches: [],
    searchTimer: null,
    searchRequestId: 0
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
    cautionList: document.querySelector("#caution-list")
  };

  const icons = {
    momentum: "↗",
    longterm: "⌁",
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

  async function polygonRequest(path, parameters = {}, optional = false) {
    const url = new URL(`${polygonApiRoot}${path}`);
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

  async function fetchPolygonStock(stock) {
    const end = new Date();
    const start = new Date(end);
    start.setUTCFullYear(start.getUTCFullYear() - 1);
    const encodedSymbol = encodeURIComponent(stock.symbol);
    const [pricePayload, detailsPayload] = await Promise.all([
      polygonRequest(`/v2/aggs/ticker/${encodedSymbol}/range/1/day/${isoDate(start)}/${isoDate(end)}`, {
        adjusted: true,
        sort: "asc",
        limit: 5000
      }),
      polygonRequest(`/v3/reference/tickers/${encodedSymbol}`, {}, true).catch(() => null)
    ]);
    const history = (pricePayload?.results || [])
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
    if (!history.length) throw new Error(`Polygon did not return price history for ${stock.symbol}.`);
    const currentPrice = history.at(-1).close;
    const details = detailsPayload?.results || {};
    const highs = history.map((point) => point.high ?? point.close).filter(Number.isFinite);
    const lows = history.map((point) => point.low ?? point.close).filter(Number.isFinite);
    const currency = String(details.currency_name || stock.currency || "USD").toUpperCase();

    return {
      symbol: stock.symbol,
      name: details.name || stock.name || stock.symbol,
      sector: details.sic_description || stock.sector || "Other",
      industry: details.sic_description || null,
      exchange: details.primary_exchange || stock.exchange || "US",
      currency,
      filingCurrency: currency,
      filingCurrencyToMarketRate: 1,
      cik: stock.cik || null,
      updatedAt: new Date().toISOString(),
      priceAsOf: history.at(-1).date,
      filingAsOf: null,
      dataMode: "polygon-free-market",
      sources: {
        prices: "Polygon adjusted daily aggregates",
        priceUrl: `${polygonApiRoot}/v2/aggs/ticker/${encodedSymbol}`
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

  function analyze(data) {
    const market = data.market || {};
    const history = (data.market?.history || []).filter((point) => Number.isFinite(safeNumber(point.close)));
    const current = safeNumber(history.at(-1)?.close);
    const volatility = calculateVolatility(history.slice(-252));
    const drawdown = calculateMaxDrawdown(history.slice(-252));
    const oneMonthReturn = periodReturn(history, 21);
    const threeMonthReturn = periodReturn(history, 63);
    const oneYearReturn = periodReturn(history, 252);
    const average50 = movingAverage(history, 50);
    const average200 = movingAverage(history, 200);
    const distanceFrom50 = current && average50 ? current / average50 - 1 : null;
    const distanceFrom200 = current && average200 ? current / average200 - 1 : null;
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
    const recentTrendScore = average([
      scorePriceReturn(oneMonthReturn, 0.08),
      scorePriceReturn(threeMonthReturn, 0.15),
      scoreAboveAverage(distanceFrom50)
    ]);
    const longTermScore = average([
      scorePriceReturn(oneYearReturn, 0.25),
      scoreAboveAverage(distanceFrom200)
    ]);
    const rangeScore = scoreRangePosition(rangePosition);
    const stabilityScore = scoreStability(volatility, drawdown);

    const weightedInputs = [
      [recentTrendScore, 0.35],
      [longTermScore, 0.3],
      [rangeScore, 0.15],
      [stabilityScore, 0.2]
    ].filter(([value]) => Number.isFinite(value));
    const usedWeight = weightedInputs.reduce((total, [, weight]) => total + weight, 0);
    const overall = usedWeight
      ? weightedInputs.reduce((total, [value, weight]) => total + value * weight, 0) / usedWeight
      : null;

    return {
      overall: Number.isFinite(overall) ? Math.round(overall) : null,
      recentTrendScore,
      longTermScore,
      rangeScore,
      stabilityScore,
      oneMonthReturn,
      threeMonthReturn,
      oneYearReturn,
      average50,
      average200,
      distanceFrom50,
      distanceFrom200,
      distanceFromHigh,
      rangePosition,
      typicalDailyMove,
      recentVolume,
      volumeTrend,
      volatility,
      drawdown,
      confidence: history.length >= 200 ? "One-year price view" : "Limited price history"
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
        summary: "Recent and longer-term movement are supportive, and the risk level clears this price-only model's bar. Company profits, debt, and valuation are not included."
      };
    }
    if (score >= 50) {
      return {
        title: "The price signals are mixed right now.",
        summary: "Some price measures look healthy while others need patience. This free-data view cannot tell whether the underlying business is cheap or profitable."
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
        note: "Price signal only"
      };
    }
    if (analysis.overall >= 50) {
      return {
        signal: "WAIT",
        status: "wait",
        note: "Price signal only"
      };
    }
    return {
      signal: "AVOID",
      status: "avoid",
      note: "Price signal only"
    };
  }

  function descriptionForCheck(type, score, data, analysis) {
    if (type === "momentum") {
      if (!Number.isFinite(score)) return "There was not enough price history to measure the recent trend.";
      return `The price changed ${formatPercent(analysis.oneMonthReturn)} in one month and ${formatPercent(analysis.threeMonthReturn)} in three months.`;
    }
    if (type === "longterm") {
      if (!Number.isFinite(score)) return "There was not enough history for a longer-term comparison.";
      const relation = analysis.distanceFrom200 >= 0 ? "above" : "below";
      return `The one-year change is ${formatPercent(analysis.oneYearReturn)}; the price is ${formatUnsignedPercent(analysis.distanceFrom200)} ${relation} its 200-day average.`;
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

    const signalItems = [
      ["Recent trend", analysis.recentTrendScore],
      ["Long-term", analysis.longTermScore],
      ["Yearly strength", analysis.rangeScore],
      ["Stability", analysis.stabilityScore]
    ];
    elements.signalSummary.innerHTML = signalItems
      .map(([label, value]) => {
        const status = scoreState(value);
        const text = Number.isFinite(value) ? scoreLabel(value) : "Not enough data";
        return `<span class="signal-pill ${status === "good" ? "" : status}">${escapeHtml(label)}: ${escapeHtml(text)}</span>`;
      })
      .join("");
  }

  function renderChecks(data, analysis) {
    const checks = [
      { type: "momentum", title: "Is the price moving up?", score: analysis.recentTrendScore },
      { type: "longterm", title: "Is the longer trend healthy?", score: analysis.longTermScore },
      { type: "range", title: "Is it near its yearly high?", score: analysis.rangeScore },
      { type: "stability", title: "How bumpy has the ride been?", score: analysis.stabilityScore }
    ];

    elements.checkGrid.innerHTML = checks
      .map((check) => {
        const status = scoreState(check.score);
        const scoreText = Number.isFinite(check.score) ? `${Math.round(check.score)}/100` : "No score";
        const statusText = !Number.isFinite(check.score)
          ? "No data"
          : status === "good"
            ? "Strong"
            : status === "watch"
              ? "Mixed"
              : "Weak";
        return `
          <article class="check-card ${status === "good" ? "" : status}">
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
    const rangeIndicator = metricStatus(analysis.rangeScore, ["Near high", "Middle", "Near low"]);
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

    const sizeOrAverage = Number.isFinite(marketCap)
      ? metric("Company value", "Market capitalization", formatCompactCurrency(marketCap, currency), "The market's total value for all of the company's shares.", { status: "info", text: "Company size" })
      : metric("Price vs usual level", "50-day average", formatPercent(analysis.distanceFrom50), `The current price compared with its ${formatCurrency(analysis.average50, currency)} 50-day average.`, averageIndicator);

    const items = [
      sizeOrAverage,
      metric("52-week price range", "Daily highs and lows", `${formatCurrency(low, currency, 0)} – ${formatCurrency(high, currency, 0)}`, "The lowest and highest traded prices in the available year.", { status: "info", text: "Year context" }),
      metric("Distance from yearly high", "Price strength", `${formatUnsignedPercent(analysis.distanceFromHigh)} below`, "A smaller gap means the price is closer to its strongest point of the year.", rangeIndicator),
      metric("One-year price change", "Longer direction", formatPercent(analysis.oneYearReturn), "How the daily closing price moved over roughly one year.", returnIndicator),
      metric("Average daily volume", "Latest 20 days", `${formatCompactNumber(analysis.recentVolume)} shares`, volumeText, { status: "info", text: "Activity" }),
      metric("Typical daily move", "Average change", formatUnsignedPercent(analysis.typicalDailyMove), "The average up-or-down movement on a normal trading day.", movementIndicator)
    ];

    elements.metricsGrid.innerHTML = items.join("");
    elements.numbersNote.textContent = "Calculated from free Polygon daily price and volume data. No paid financial figures used.";
  }

  function buildReasons(data, analysis) {
    const positives = [];
    const cautions = [];

    if (Number.isFinite(analysis.threeMonthReturn)) {
      if (analysis.threeMonthReturn >= 0.05) positives.push(`The price rose ${formatPercent(analysis.threeMonthReturn)} over three months.`);
      else if (analysis.threeMonthReturn < -0.05) cautions.push(`The price fell ${formatPercent(analysis.threeMonthReturn)} over three months.`);
      else cautions.push("The three-month price direction was mostly flat.");
    }

    if (Number.isFinite(analysis.oneYearReturn)) {
      if (analysis.oneYearReturn >= 0.1) positives.push(`The one-year price change was ${formatPercent(analysis.oneYearReturn)}.`);
      else if (analysis.oneYearReturn < -0.1) cautions.push(`The one-year price change was ${formatPercent(analysis.oneYearReturn)}.`);
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
      cautions.push(`The price experienced a ${formatPercent(analysis.drawdown, 0)} fall from a recent high.`);
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
    renderHeader(data);
    renderVerdict(data, analysis);
    renderChecks(data, analysis);
    renderChart();
    renderMetrics(data, analysis);
    renderReasons(data, analysis);
  }

  function presentStockData(data, symbol, options = {}) {
    state.data = data;
    renderDashboard(data);
    elements.message.hidden = true;
    if (window.location.protocol !== "file:") {
      const url = new URL(window.location.href);
      url.searchParams.set("symbol", symbol);
      window.history.replaceState({}, "", url);
    }
    document.title = `${data.name || symbol} (${symbol}) — PlainStock`;
    if (options.scroll) elements.dashboard.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  async function loadLiveStock(stock, options = {}) {
    closeSearchResults();
    elements.dashboard.classList.add("loading");
    elements.message.hidden = false;
    if (!polygonApiKey) {
      elements.message.textContent = "Live search is not connected yet. Add your Polygon key in config.js, then reload the page.";
      elements.dashboard.classList.remove("loading");
      return;
    }

    try {
      elements.message.textContent = `Getting the latest available Polygon data for ${stock.symbol}…`;
      const data = await fetchPolygonStock(stock);
      presentStockData(data, stock.symbol, options);
    } catch (error) {
      elements.message.textContent = error.message;
      elements.message.hidden = false;
    } finally {
      elements.dashboard.classList.remove("loading");
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
    loadLiveStock(stock, { scroll: true });
  }

  function stockFromPolygon(result) {
    const symbol = String(result?.ticker || "").toUpperCase();
    return {
      symbol,
      name: result?.name || symbol,
      exchange: result?.primary_exchange || "US",
      currency: String(result?.currency_name || "USD").toUpperCase(),
      type: result?.type || "Stock"
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
    elements.searchResults.innerHTML = `<div class="search-empty"><strong>Searching the live market…</strong><span>Looking up ${escapeHtml(normalized)} with Polygon.</span></div>`;
    elements.searchResults.classList.add("open");
    elements.search.setAttribute("aria-expanded", "true");

    try {
      const payload = await polygonRequest("/v3/reference/tickers", {
        search: normalized,
        active: true,
        market: "stocks",
        limit: 8
      });
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
    elements.search.addEventListener("input", (event) => searchStocks(event.target.value));
    elements.search.addEventListener("focus", () => {
      if (elements.search.value.trim()) searchStocks(elements.search.value);
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

    document.querySelector(".quick-picks").addEventListener("click", (event) => {
      const button = event.target.closest("[data-symbol]");
      if (button) {
        const symbol = button.dataset.symbol;
        loadLiveStock({ symbol, name: symbol, exchange: "US", currency: "USD" }, { scroll: true });
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

  }

  function initialize() {
    bindEvents();
    const requestedSymbol = requestedTicker(new URLSearchParams(window.location.search).get("symbol")) || "AAPL";
    loadLiveStock({
      symbol: requestedSymbol,
      name: requestedSymbol,
      exchange: "US",
      currency: "USD"
    });
  }

  initialize();
})();
