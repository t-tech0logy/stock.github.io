(() => {
  "use strict";

  const stocks = window.STOCK_LIBRARY || [];
  const savedBySymbol = new Map(stocks.map((stock) => [stock.symbol, stock]));
  const catalogBySymbol = new Map(
    (window.STOCK_CATALOG || stocks).map((stock) => [stock.symbol, stock])
  );
  stocks.forEach((stock) => catalogBySymbol.set(stock.symbol, stock));
  const marketCatalog = [...catalogBySymbol.values()].map((catalogStock) => {
    const saved = savedBySymbol.get(catalogStock.symbol);
    const stock = saved ? { ...catalogStock, ...saved } : catalogStock;
    return {
      ...stock,
      available: Boolean(saved),
      searchText: `${stock.symbol} ${stock.name}`.toLowerCase()
    };
  });
  const state = {
    data: null,
    chartRange: 90,
    chartData: [],
    activeSearchIndex: -1,
    searchMatches: [],
    sector: "All",
    stockPollTimer: null,
    stockPollTimeout: null
  };

  const elements = {
    dashboard: document.querySelector("#dashboard"),
    message: document.querySelector("#app-message"),
    search: document.querySelector("#stock-search"),
    searchResults: document.querySelector("#search-results"),
    searchShell: document.querySelector("#search-shell"),
    libraryCount: document.querySelector("#library-count"),
    marketCount: document.querySelector("#market-count"),
    librarySummaryCount: document.querySelector("#library-summary-count"),
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
    libraryGrid: document.querySelector("#library-grid"),
    sectorFilters: document.querySelector("#sector-filters")
  };

  const icons = {
    growth: "↗",
    cash: "$",
    value: "◎",
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

  function formatMoney(value, currency = "USD") {
    if (!Number.isFinite(value)) return "Not available";
    const absolute = Math.abs(value);
    const units = [
      [1e12, "T"],
      [1e9, "B"],
      [1e6, "M"]
    ];
    const unit = units.find(([threshold]) => absolute >= threshold);
    if (!unit) return formatCurrency(value, currency, 0);
    return `${value < 0 ? "−" : ""}${formatCurrency(Math.abs(value) / unit[0], currency, 1)}${unit[1]}`;
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

  function formatRatio(value, suffix = "×") {
    if (!Number.isFinite(value)) return "Not available";
    return `${value.toFixed(1)}${suffix}`;
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

  function scoreGrowth(growth) {
    if (!Number.isFinite(growth)) return null;
    if (growth >= 0.2) return 95;
    if (growth >= 0.1) return 84;
    if (growth >= 0.04) return 72;
    if (growth >= 0) return 58;
    if (growth >= -0.08) return 36;
    return 16;
  }

  function scoreMargin(margin) {
    if (!Number.isFinite(margin)) return null;
    if (margin >= 0.25) return 94;
    if (margin >= 0.15) return 82;
    if (margin >= 0.08) return 70;
    if (margin >= 0.02) return 55;
    if (margin >= 0) return 42;
    return 15;
  }

  function scorePe(peRatio) {
    if (!Number.isFinite(peRatio) || peRatio <= 0) return null;
    if (peRatio <= 12) return 91;
    if (peRatio <= 18) return 83;
    if (peRatio <= 25) return 72;
    if (peRatio <= 35) return 54;
    if (peRatio <= 50) return 34;
    return 18;
  }

  function scorePriceToSales(value) {
    if (!Number.isFinite(value) || value <= 0) return null;
    if (value <= 1.5) return 88;
    if (value <= 3) return 76;
    if (value <= 6) return 57;
    if (value <= 10) return 37;
    return 20;
  }

  function scoreFcfYield(value) {
    if (!Number.isFinite(value)) return null;
    if (value >= 0.08) return 94;
    if (value >= 0.05) return 80;
    if (value >= 0.03) return 64;
    if (value >= 0.01) return 46;
    if (value >= 0) return 30;
    return 12;
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

  function scoreDirection(history) {
    if (history.length < 10) return null;
    const recent = history.slice(-90);
    const current = safeNumber(recent.at(-1)?.close);
    const first = safeNumber(recent[0]?.close);
    const movingAverage = average(recent.slice(-50).map((point) => safeNumber(point.close)));
    if (!current || !first || !movingAverage) return null;
    const periodReturn = current / first - 1;
    const returnScore = clamp(50 + periodReturn * 150);
    const averageScore = clamp(50 + (current / movingAverage - 1) * 250);
    return average([returnScore, averageScore]);
  }

  function analyze(data) {
    const fundamentals = data.fundamentals || {};
    const history = (data.market?.history || []).filter((point) => Number.isFinite(safeNumber(point.close)));
    const volatility = calculateVolatility(history.slice(-252));
    const drawdown = calculateMaxDrawdown(history.slice(-252));

    const growthScore = average([
      scoreGrowth(fundamentals.revenueGrowth),
      scoreGrowth(fundamentals.earningsGrowth)
    ]);
    const cashScore = average([
      scoreMargin(fundamentals.profitMargin),
      scoreMargin(fundamentals.freeCashFlowMargin)
    ]);
    const debtScore = Number.isFinite(fundamentals.debtToAssets)
      ? clamp(92 - fundamentals.debtToAssets * 130)
      : null;
    const businessScore = average([growthScore, cashScore, debtScore]);

    const valuationScore = average([
      scorePe(fundamentals.peRatio),
      scorePriceToSales(fundamentals.priceToSales),
      scoreFcfYield(fundamentals.freeCashFlowYield)
    ]);
    const directionScore = scoreDirection(history);
    const stabilityScore = scoreStability(volatility, drawdown);

    const weightedInputs = [
      [businessScore, 0.3],
      [valuationScore, 0.25],
      [directionScore, 0.25],
      [stabilityScore, 0.2]
    ].filter(([value]) => Number.isFinite(value));
    const usedWeight = weightedInputs.reduce((total, [, weight]) => total + weight, 0);
    const overall = usedWeight
      ? weightedInputs.reduce((total, [value, weight]) => total + value * weight, 0) / usedWeight
      : null;

    return {
      overall: Number.isFinite(overall) ? Math.round(overall) : null,
      growthScore,
      cashScore,
      businessScore,
      valuationScore,
      directionScore,
      stabilityScore,
      volatility,
      drawdown,
      hasBusinessData: Number.isFinite(businessScore),
      hasValuationData: Number.isFinite(valuationScore),
      confidence: weightedInputs.length >= 4 ? "Full business + market view" : "Limited available-data view"
    };
  }

  function verdictFor(analysis) {
    const score = analysis.overall;
    if (!Number.isFinite(score)) {
      return {
        title: "There is not enough information yet.",
        summary: "Run the data update again or verify this company's SEC filing coverage before drawing a conclusion."
      };
    }
    if (score >= 70) {
      return {
        title: "The evidence currently leans positive.",
        summary: "Business strength, price, and risk clear the model's minimum bar. Check the caution list before treating this as a genuine investment candidate."
      };
    }
    if (score >= 50) {
      return {
        title: "The evidence is mixed right now.",
        summary: "The model does not see a strong enough risk-and-reward balance. Waiting for a better price or stronger business results may improve the setup."
      };
    }
    return {
      title: "The risks currently outweigh the positives.",
      summary: "Several important signals are weak. Avoiding the stock for now may be more sensible until the business, price, or risk picture improves."
    };
  }

  function decisionFor(analysis) {
    if (!Number.isFinite(analysis.overall) || !analysis.hasBusinessData || !analysis.hasValuationData) {
      return {
        signal: "WAIT",
        status: "wait",
        note: "Limited data"
      };
    }
    if (analysis.overall >= 70) {
      return {
        signal: "BUY",
        status: "buy",
        note: "Check the risks first"
      };
    }
    if (analysis.overall >= 50) {
      return {
        signal: "WAIT",
        status: "wait",
        note: "Patience may help"
      };
    }
    return {
      signal: "AVOID",
      status: "avoid",
      note: "Risks currently dominate"
    };
  }

  function descriptionForCheck(type, score, data, analysis) {
    const fundamentals = data.fundamentals || {};
    if (type === "growth") {
      if (!Number.isFinite(score)) return "The SEC filing did not provide enough comparable annual figures.";
      const revenue = formatPercent(fundamentals.revenueGrowth);
      const earnings = formatPercent(fundamentals.earningsGrowth);
      return `Annual revenue changed ${revenue}; profit changed ${earnings}.`;
    }
    if (type === "cash") {
      if (!Number.isFinite(score)) return "Cash-flow information was not consistent enough to score.";
      if (Number.isFinite(fundamentals.freeCashFlowMargin)) {
        return `${formatUnsignedPercent(fundamentals.freeCashFlowMargin, 1)} of sales remained as free cash after major investment spending.`;
      }
      return `The latest annual profit margin was ${formatPercent(fundamentals.profitMargin, 1)}.`;
    }
    if (type === "value") {
      if (!Number.isFinite(score)) return "A useful price-to-business comparison could not be calculated.";
      const peText = Number.isFinite(fundamentals.peRatio)
        ? `${formatRatio(fundamentals.peRatio)} annual earnings`
        : "an unavailable earnings multiple";
      return `The market price equals about ${peText}. Lower is generally cheaper, but quality matters.`;
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
      elements.priceChange.textContent = `${positive ? "+" : "−"}${formatCurrency(Math.abs(change), currency)} (${formatPercent(percent)}) today`;
    } else {
      elements.priceChange.textContent = "Current change unavailable";
    }

    const priceDate = data.priceAsOf ? `Price through ${formatDate(data.priceAsOf)}` : "Price date unavailable";
    const filingDate = data.filingAsOf ? `SEC filing through ${formatDate(data.filingAsOf)}` : "filing date unavailable";
    elements.freshness.textContent = `${priceDate} · ${filingDate}`;
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
      ["Business", analysis.businessScore],
      ["Price", analysis.valuationScore],
      ["Direction", analysis.directionScore],
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
      { type: "growth", title: "Is the business growing?", score: analysis.growthScore },
      { type: "cash", title: "Does it produce real cash?", score: analysis.cashScore },
      { type: "value", title: "Does the price look sensible?", score: analysis.valuationScore },
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
    const f = data.fundamentals || {};
    const market = data.market || {};
    const currency = market.currency || data.currency || "USD";
    const oneYearHistory = (market.history || []).slice(-252);
    const oneYearStart = safeNumber(oneYearHistory[0]?.close);
    const latest = safeNumber(oneYearHistory.at(-1)?.close);
    const oneYearReturn = oneYearStart && latest ? latest / oneYearStart - 1 : null;
    const marketCapIndicator = { status: "info", text: "Scale only" };
    const valuationIndicator = metricStatus(scorePe(f.peRatio), ["Reasonable", "Check price", "Expensive"]);
    const growthIndicator = metricStatus(scoreGrowth(f.revenueGrowth), ["Growing", "Slow", "Declining"]);
    const marginIndicator = metricStatus(scoreMargin(f.profitMargin), ["Strong", "Moderate", "Thin"]);
    const cashIndicator = metricStatus(scoreMargin(f.freeCashFlowMargin), ["Strong cash", "Some cash", "Weak cash"]);
    const returnIndicator = Number.isFinite(oneYearReturn)
      ? oneYearReturn >= 0.1
        ? { status: "good", text: "Rising" }
        : oneYearReturn >= -0.1
          ? { status: "watch", text: "Mostly flat" }
          : { status: "weak", text: "Falling" }
      : { status: "watch", text: "No data" };

    const items = [
      metric("Company value", "Price + SEC", formatMoney(f.marketCap, currency), "Company size is context, not automatically good or bad.", marketCapIndicator),
      metric("Price vs annual profit", "Price + SEC", formatRatio(f.peRatio), "How much investors pay for one dollar of annual profit.", valuationIndicator),
      metric("Annual sales growth", "SEC", formatPercent(f.revenueGrowth), "Change in reported sales versus the previous year.", growthIndicator),
      metric("Profit kept from sales", "SEC", Number.isFinite(f.profitMargin) ? formatUnsignedPercent(f.profitMargin) : "Not available", "The share of sales remaining after all reported costs.", marginIndicator),
      metric("Free cash generated", "SEC", formatMoney(f.freeCashFlow, currency), "Cash left after major property and equipment spending.", cashIndicator),
      metric("One-year price change", "Price", formatPercent(oneYearReturn), "How the saved market price moved over roughly one year.", returnIndicator)
    ];

    elements.metricsGrid.innerHTML = items.join("");
    elements.numbersNote.textContent = analysis.hasBusinessData
      ? "Official filing figures combined with the saved market price."
      : "Some SEC values were unavailable, so treat this as a limited view.";
  }

  function buildReasons(data, analysis) {
    const f = data.fundamentals || {};
    const positives = [];
    const cautions = [];

    if (Number.isFinite(f.revenueGrowth)) {
      if (f.revenueGrowth > 0.05) positives.push(`Annual sales grew ${formatPercent(f.revenueGrowth)}.`);
      else if (f.revenueGrowth < 0) cautions.push(`Annual sales declined ${formatPercent(f.revenueGrowth)}.`);
      else cautions.push("Annual sales growth was modest.");
    }

    if (Number.isFinite(f.profitMargin)) {
      if (f.profitMargin >= 0.12) positives.push(`The company kept ${formatPercent(f.profitMargin, 1).replace("+", "")} of sales as profit.`);
      else if (f.profitMargin < 0) cautions.push("The company reported an annual loss.");
      else cautions.push("The reported profit cushion was relatively thin.");
    }

    if (Number.isFinite(f.freeCashFlow)) {
      if (f.freeCashFlow > 0) positives.push(`The business generated ${formatMoney(f.freeCashFlow, data.currency)} in free cash.`);
      else cautions.push("Free cash flow was negative in the latest annual filing.");
    }

    if (Number.isFinite(f.debtToAssets)) {
      if (f.debtToAssets <= 0.25) positives.push("Reported debt was modest compared with total assets.");
      else if (f.debtToAssets >= 0.5) cautions.push("Reported debt was high compared with total assets.");
    }

    if (Number.isFinite(f.peRatio)) {
      if (f.peRatio <= 22 && f.peRatio > 0) positives.push(`The price was about ${formatRatio(f.peRatio)} annual profit, which is not extreme by a broad-market rule of thumb.`);
      else if (f.peRatio > 35) cautions.push(`The price was ${formatRatio(f.peRatio)} annual profit, leaving less room for disappointing growth.`);
    }

    if (Number.isFinite(analysis.directionScore)) {
      if (analysis.directionScore >= 67) positives.push("The recent price direction was supportive.");
      else if (analysis.directionScore < 43) cautions.push("The recent price direction was weak.");
    }

    if (Number.isFinite(analysis.drawdown) && analysis.drawdown <= -0.25) {
      cautions.push(`The price experienced a ${formatPercent(analysis.drawdown, 0)} fall from a recent high.`);
    }

    const positiveFallbacks = [
      "The company has enough public filing history for further research.",
      "The underlying figures can be verified in the linked SEC data.",
      "A full year of saved prices provides useful context."
    ];
    const cautionFallbacks = [
      "A simple score cannot capture competition, management quality, or future events.",
      "Historical results do not guarantee that the business will perform similarly next year.",
      "Broad scoring rules can miss important differences between industries."
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

  async function loadStock(symbol, options = {}) {
    const normalized = String(symbol).toUpperCase();
    elements.dashboard.classList.add("loading");
    elements.message.hidden = true;
    closeSearchResults();

    try {
      let data = window.STOCK_DATA?.[normalized] || null;
      if (!data) {
        const response = await fetch(`data/stocks/${encodeURIComponent(normalized)}.json`, { cache: "no-cache" });
        if (!response.ok) throw new Error(`Saved data for ${normalized} was not found.`);
        data = await response.json();
      }
      state.data = data;
      renderDashboard(data);
      if (window.location.protocol !== "file:") {
        const url = new URL(window.location.href);
        url.searchParams.set("symbol", normalized);
        window.history.replaceState({}, "", url);
      }
      document.title = `${data.name || normalized} (${normalized}) — PlainStock`;
      if (options.scroll) elements.dashboard.scrollIntoView({ behavior: "smooth", block: "start" });
    } catch (error) {
      elements.message.textContent = `${error.message} Run “node scripts/update-data.mjs” to rebuild the bundled SEC data.`;
      elements.message.hidden = false;
    } finally {
      elements.dashboard.classList.remove("loading");
    }
  }

  function stockOption(stock, index) {
    const details = stock.available
      ? `${stock.symbol} · ${stock.sector} · ${stock.exchange}`
      : `${stock.symbol} · ${stock.exchange || "SEC listed"}`;
    return `
      <button class="search-option ${index === state.activeSearchIndex ? "active" : ""}" type="button" role="option" data-symbol="${stock.symbol}" aria-selected="${index === state.activeSearchIndex}">
        <span class="mini-logo">${escapeHtml(stock.name.slice(0, 1))}</span>
        <span class="search-option-copy"><strong>${escapeHtml(stock.name)}</strong><small>${escapeHtml(details)}</small></span>
        <span class="search-option-status ${stock.available ? "ready" : "download"}">${stock.available ? "Ready" : "Download"}</span>
      </button>
    `;
  }

  function requestedTicker(query) {
    const symbol = String(query || "").trim().toUpperCase().replaceAll(".", "-");
    return /^[A-Z0-9-]{1,10}$/.test(symbol) ? symbol : null;
  }

  function githubRepositoryUrl() {
    const configured = document.querySelector('meta[name="plainstock-repository"]')?.content.trim();
    if (configured) return configured.replace(/\/$/, "");
    const match = window.location.hostname.match(/^([a-z0-9-]+)\.github\.io$/i);
    if (!match) return null;
    const owner = match[1];
    const repository = window.location.pathname.split("/").filter(Boolean)[0] || `${owner}.github.io`;
    return `https://github.com/${owner}/${repository}`;
  }

  function stopStockPolling() {
    if (state.stockPollTimer) window.clearInterval(state.stockPollTimer);
    if (state.stockPollTimeout) window.clearTimeout(state.stockPollTimeout);
    state.stockPollTimer = null;
    state.stockPollTimeout = null;
  }

  function reloadForStock(symbol) {
    const url = new URL(window.location.href);
    url.searchParams.set("symbol", symbol);
    window.location.assign(url.href);
  }

  function startStockPolling(symbol) {
    stopStockPolling();
    const check = async () => {
      try {
        const response = await fetch(`data/manifest.json?requested=${Date.now()}`, { cache: "no-store" });
        if (!response.ok) return;
        const manifest = await response.json();
        if ((manifest.completed || []).includes(symbol)) {
          stopStockPolling();
          elements.message.textContent = `${symbol} is ready. Reloading its dashboard…`;
          reloadForStock(symbol);
        }
      } catch {
        // GitHub Pages may briefly serve the previous deployment; the next poll retries.
      }
    };
    state.stockPollTimer = window.setInterval(check, 15_000);
    state.stockPollTimeout = window.setTimeout(stopStockPolling, 15 * 60_000);
    check();
  }

  function requestStockDownload(symbol) {
    const repositoryUrl = githubRepositoryUrl();
    closeSearchResults();
    elements.message.hidden = false;
    if (!repositoryUrl) {
      elements.message.textContent = `Publish this project on GitHub Pages first, then request ${symbol} from the Refresh stock data workflow.`;
      return;
    }
    window.open(`${repositoryUrl}/actions/workflows/update-data.yml`, "_blank", "noopener");
    elements.message.textContent = `GitHub Actions opened. Enter ${symbol} in “symbol”, run the workflow, then leave this page open—it will reload automatically when the data is ready.`;
    startStockPolling(symbol);
  }

  function selectSearchStock(stock) {
    elements.search.value = stock.name;
    if (stock.available) {
      loadStock(stock.symbol, { scroll: true });
    } else {
      requestStockDownload(stock.symbol);
    }
  }

  function searchStocks(query) {
    const normalized = query.trim().toLowerCase();
    const source = normalized ? marketCatalog : marketCatalog.filter((stock) => stock.available);
    const matches = source
      .filter((stock) => !normalized || stock.searchText.includes(normalized))
      .sort((left, right) => {
        const rank = (stock) => {
          const symbol = stock.symbol.toLowerCase();
          const name = stock.name.toLowerCase();
          if (symbol === normalized) return 0;
          if (symbol.startsWith(normalized)) return 1;
          if (name.startsWith(normalized)) return 2;
          if (name.split(/\s+/).some((word) => word.startsWith(normalized))) return 3;
          return 4;
        };
        return rank(left) - rank(right)
          || Number(right.available) - Number(left.available)
          || left.symbol.localeCompare(right.symbol);
      })
      .slice(0, 8);
    state.searchMatches = matches;
    state.activeSearchIndex = -1;
    const requested = requestedTicker(query);
    elements.searchResults.innerHTML = matches.length
      ? matches.map(stockOption).join("")
      : normalized
        ? `<div class="search-empty">
            <strong>${escapeHtml(query.toUpperCase())} is not downloaded yet</strong>
            <span>${requested ? "This code is not in the current SEC catalog. Repository owners can still try the GitHub refresh workflow." : "Enter an exact ticker code to request a download."}</span>
            ${requested ? `<button class="stock-request" type="button" data-request-symbol="${escapeHtml(requested)}">Try ${escapeHtml(requested)} via GitHub Actions</button>` : ""}
          </div>`
        : "";
    const shouldOpen = matches.length > 0 || Boolean(normalized);
    elements.searchResults.classList.toggle("open", shouldOpen);
    elements.search.setAttribute("aria-expanded", String(shouldOpen));
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

  function renderSectorFilters() {
    const sectors = ["All", ...new Set(stocks.map((stock) => stock.sector))];
    elements.sectorFilters.innerHTML = sectors
      .map((sector) => `<button type="button" data-sector="${escapeHtml(sector)}" class="${sector === state.sector ? "active" : ""}">${escapeHtml(sector)}</button>`)
      .join("");
  }

  function renderLibrary() {
    const visible = state.sector === "All" ? stocks : stocks.filter((stock) => stock.sector === state.sector);
    elements.libraryGrid.innerHTML = visible
      .map(
        (stock) => `
          <button class="stock-card" type="button" data-symbol="${stock.symbol}">
            <span class="stock-card-top">
              <span class="mini-logo">${escapeHtml(stock.name.slice(0, 1))}</span>
              <span class="ticker">${stock.symbol}</span>
            </span>
            <strong>${escapeHtml(stock.name)}</strong>
            <small>${escapeHtml(stock.sector)} · ${escapeHtml(stock.exchange)}</small>
          </button>
        `
      )
      .join("");
  }

  function bindEvents() {
    elements.search.addEventListener("input", (event) => searchStocks(event.target.value));
    elements.search.addEventListener("focus", () => searchStocks(elements.search.value));
    elements.search.addEventListener("keydown", (event) => {
      if (!state.searchMatches.length) {
        if (event.key === "Enter") {
          const requested = requestedTicker(elements.search.value);
          if (requested) {
            event.preventDefault();
            requestStockDownload(requested);
          }
        } else if (event.key === "Escape") {
          closeSearchResults();
        }
        return;
      }
      if (event.key === "ArrowDown") {
        event.preventDefault();
        state.activeSearchIndex = Math.min(state.activeSearchIndex + 1, state.searchMatches.length - 1);
        updateActiveSearch();
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        state.activeSearchIndex = Math.max(state.activeSearchIndex - 1, 0);
        updateActiveSearch();
      } else if (event.key === "Enter" && state.activeSearchIndex >= 0) {
        event.preventDefault();
        const selected = state.searchMatches[state.activeSearchIndex];
        selectSearchStock(selected);
      } else if (event.key === "Enter") {
        event.preventDefault();
        const exactSymbol = requestedTicker(elements.search.value);
        const selected = state.searchMatches.find((stock) => stock.symbol === exactSymbol) || state.searchMatches[0];
        selectSearchStock(selected);
      } else if (event.key === "Escape") {
        closeSearchResults();
      }
    });

    elements.searchResults.addEventListener("click", (event) => {
      const request = event.target.closest("[data-request-symbol]");
      if (request) {
        requestStockDownload(request.dataset.requestSymbol);
        return;
      }
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
      if (button) loadStock(button.dataset.symbol, { scroll: true });
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

    elements.sectorFilters.addEventListener("click", (event) => {
      const button = event.target.closest("[data-sector]");
      if (!button) return;
      state.sector = button.dataset.sector;
      renderSectorFilters();
      renderLibrary();
    });

    elements.libraryGrid.addEventListener("click", (event) => {
      const card = event.target.closest("[data-symbol]");
      if (card) loadStock(card.dataset.symbol, { scroll: true });
    });

  }

  function initialize() {
    elements.libraryCount.textContent = `${stocks.length} dashboards ready`;
    elements.marketCount.textContent = ` · ${marketCatalog.length.toLocaleString("en-US")} SEC-listed stocks searchable`;
    elements.librarySummaryCount.textContent = stocks.length.toLocaleString("en-US");
    renderSectorFilters();
    renderLibrary();
    bindEvents();
    const requestedSymbol = window.location.protocol === "file:"
      ? null
      : new URLSearchParams(window.location.search).get("symbol")?.toUpperCase();
    const initialSymbol = stocks.some((stock) => stock.symbol === requestedSymbol) ? requestedSymbol : "AAPL";
    loadStock(initialSymbol);
  }

  initialize();
})();
