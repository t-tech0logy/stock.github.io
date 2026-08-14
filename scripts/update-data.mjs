import { mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import vm from "node:vm";

const projectRoot = resolve(import.meta.dirname, "..");
const outputDirectory = resolve(projectRoot, "data", "stocks");
const secUserAgent =
  process.env.SEC_USER_AGENT || "PlainStock educational project (github.com/gngo)";

const wait = (milliseconds) => new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));

async function readStockLibrary() {
  const source = await readFile(resolve(projectRoot, "stocks.js"), "utf8");
  const sandbox = { window: {} };
  vm.runInNewContext(source, sandbox);
  return sandbox.window.STOCK_LIBRARY;
}

function normalizeSymbol(value) {
  return String(value || "").trim().toUpperCase().replaceAll(".", "-");
}

function displayCompanyName(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/(^|[\s/&-])([a-z])/g, (_, prefix, letter) => `${prefix}${letter.toUpperCase()}`)
    .replace(/\bNvidia\b/g, "NVIDIA")
    .replace(/\bUsa\b/g, "USA");
}

function normalizeExchange(value) {
  const exchange = String(value || "US").trim();
  if (/nasdaq/i.test(exchange)) return "NASDAQ";
  if (/new york|nyse/i.test(exchange)) return "NYSE";
  if (/otc/i.test(exchange)) return "OTC";
  return exchange || "US";
}

function sectorFromSic(sic, description = "") {
  const code = Number(sic);
  const text = String(description).toLowerCase();
  if (/bank|credit|insurance|broker|investment|finance|financial/.test(text) || (code >= 6000 && code < 6800)) {
    return "Financials";
  }
  if (/hospital|health|medical|pharma|biological|diagnostic/.test(text) || (code >= 8000 && code < 8100)) {
    return "Healthcare";
  }
  if (/oil|gas|petroleum|energy/.test(text) || (code >= 1200 && code < 1400) || (code >= 2900 && code < 3000)) {
    return "Energy";
  }
  if (/software|computer|semiconductor|electronic|internet|data processing/.test(text) || (code >= 3570 && code < 3580) || (code >= 7370 && code < 7380)) {
    return "Technology";
  }
  if (/broadcast|motion picture|entertainment|publishing|communications/.test(text) || (code >= 4800 && code < 4900)) {
    return "Media";
  }
  if (/retail|restaurant|food|apparel|consumer/.test(text) || (code >= 5000 && code < 6000)) {
    return "Consumer";
  }
  return "Other";
}

async function writeStockLibrary(stocks) {
  const entries = stocks.map((stock) => {
    const fields = [
      `symbol: ${JSON.stringify(stock.symbol)}`,
      `name: ${JSON.stringify(stock.name)}`,
      `sector: ${JSON.stringify(stock.sector)}`,
      `exchange: ${JSON.stringify(stock.exchange)}`
    ];
    if (stock.cik) fields.push(`cik: ${JSON.stringify(stock.cik)}`);
    return `  { ${fields.join(", ")} }`;
  });
  await writeFile(
    resolve(projectRoot, "stocks.js"),
    `window.STOCK_LIBRARY = [\n${entries.join(",\n")}\n];\n`,
    "utf8"
  );
}

async function writeStockCatalog(companyByTicker) {
  const catalog = [...companyByTicker]
    .map(([symbol, company]) => ({
      symbol,
      name: displayCompanyName(company.name),
      exchange: normalizeExchange(company.exchange)
    }))
    .filter((company) => company.symbol && company.name)
    .sort((left, right) => left.symbol.localeCompare(right.symbol));
  await writeFile(
    resolve(projectRoot, "data", "stock-catalog.js"),
    `window.STOCK_CATALOG=${JSON.stringify(catalog)};\n`,
    "utf8"
  );
  return catalog.length;
}

async function fetchJson(url, options = {}, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, options);
      if (response.status === 429 && attempt < attempts) {
        await wait(attempt * 1800);
        continue;
      }
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      return await response.json();
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await wait(attempt * 900);
    }
  }
  throw lastError;
}

async function fetchCompanyDirectory() {
  const headers = { "User-Agent": secUserAgent, "Accept-Encoding": "gzip, deflate" };
  try {
    const payload = await fetchJson("https://www.sec.gov/files/company_tickers_exchange.json", { headers });
    return new Map(
      (payload.data || []).map(([cik, name, ticker, exchange]) => [
        normalizeSymbol(ticker),
        { cik, name, exchange }
      ])
    );
  } catch {
    const payload = await fetchJson("https://www.sec.gov/files/company_tickers.json", { headers });
    return new Map(
      Object.values(payload).map((company) => [
        normalizeSymbol(company.ticker),
        { cik: company.cik_str, name: company.title, exchange: "US" }
      ])
    );
  }
}

function getConcept(companyFacts, taxonomy, names) {
  const facts = companyFacts.facts?.[taxonomy] || {};
  return names.map((name) => facts[name]).find(Boolean) || null;
}

function detectFilingCurrency(companyFacts) {
  const revenueConcept = getConcept(companyFacts, "us-gaap", [
    "RevenueFromContractWithCustomerExcludingAssessedTax",
    "Revenues",
    "SalesRevenueNet"
  ]);
  const currency = Object.keys(revenueConcept?.units || {}).find((unit) => /^[A-Z]{3}$/.test(unit));
  return currency || "USD";
}

function entriesFor(companyFacts, taxonomy, conceptNames, units) {
  const concept = getConcept(companyFacts, taxonomy, conceptNames);
  if (!concept?.units) return [];
  const unit = units.find((candidate) => concept.units[candidate]);
  return unit ? concept.units[unit] : [];
}

function deduplicateByEnd(entries) {
  const map = new Map();
  [...entries]
    .sort((left, right) => String(left.filed || "").localeCompare(String(right.filed || "")))
    .forEach((entry) => map.set(entry.end, entry));
  return [...map.values()].sort((left, right) => String(left.end).localeCompare(String(right.end)));
}

function annualSeries(companyFacts, taxonomy, conceptNames, units = ["USD"]) {
  const entries = entriesFor(companyFacts, taxonomy, conceptNames, units).filter((entry) => {
    if (!["10-K", "20-F", "40-F"].includes(entry.form) || !entry.start || !entry.end) return false;
    const days = (new Date(entry.end) - new Date(entry.start)) / 86_400_000;
    return days >= 250 && days <= 450 && Number.isFinite(entry.val);
  });
  return deduplicateByEnd(entries).slice(-5);
}

function latestInstant(companyFacts, taxonomy, conceptNames, units = ["USD"]) {
  const entries = entriesFor(companyFacts, taxonomy, conceptNames, units)
    .filter((entry) => entry.end && Number.isFinite(entry.val))
    .sort((left, right) => {
      const endDifference = String(left.end).localeCompare(String(right.end));
      return endDifference || String(left.filed || "").localeCompare(String(right.filed || ""));
    });
  return entries.at(-1) || null;
}

function latestTwo(series) {
  return [series.at(-1) || null, series.at(-2) || null];
}

function growthRate(current, previous) {
  if (!Number.isFinite(current) || !Number.isFinite(previous) || previous === 0) return null;
  return current / Math.abs(previous) - 1;
}

function safeDivide(numerator, denominator) {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) return null;
  return numerator / denominator;
}

function newestFilingDate(...facts) {
  const dates = facts.flat().map((fact) => fact?.filed).filter(Boolean).sort();
  return dates.at(-1) || null;
}

function extractFundamentals(companyFacts, currentPrice, filingCurrency = "USD", conversionRate = 1) {
  const moneyUnits = [filingCurrency, "USD"];
  const perShareUnits = [`${filingCurrency}/shares`, "USD/shares"];
  const convertMoney = (value) =>
    Number.isFinite(value) ? value * conversionRate : null;
  const revenueSeries = annualSeries(companyFacts, "us-gaap", [
    "RevenueFromContractWithCustomerExcludingAssessedTax",
    "Revenues",
    "SalesRevenueNet",
    "SalesRevenueGoodsNet"
  ], moneyUnits);
  const incomeSeries = annualSeries(companyFacts, "us-gaap", ["NetIncomeLoss", "ProfitLoss"], moneyUnits);
  const operatingCashSeries = annualSeries(companyFacts, "us-gaap", [
    "NetCashProvidedByUsedInOperatingActivities",
    "NetCashProvidedByUsedInOperatingActivitiesContinuingOperations"
  ], moneyUnits);
  const capexSeries = annualSeries(companyFacts, "us-gaap", [
    "PaymentsToAcquirePropertyPlantAndEquipment",
    "PaymentsToAcquireProductiveAssets"
  ], moneyUnits);
  const epsSeries = annualSeries(
    companyFacts,
    "us-gaap",
    ["EarningsPerShareDiluted", "EarningsPerShareBasicAndDiluted"],
    perShareUnits
  );
  const dividendSeries = annualSeries(
    companyFacts,
    "us-gaap",
    ["CommonStockDividendsPerShareDeclared", "CommonStockDividendsPerShareCashPaid"],
    perShareUnits
  );

  const [revenue, previousRevenue] = latestTwo(revenueSeries);
  const [netIncome, previousNetIncome] = latestTwo(incomeSeries);
  const operatingCashFlow = operatingCashSeries.at(-1) || null;
  const capitalSpending = capexSeries.at(-1) || null;
  const eps = epsSeries.at(-1) || null;
  const dividend = dividendSeries.at(-1) || null;

  const assets = latestInstant(companyFacts, "us-gaap", ["Assets"], moneyUnits);
  const liabilities = latestInstant(companyFacts, "us-gaap", ["Liabilities"], moneyUnits);
  const equity = latestInstant(companyFacts, "us-gaap", [
    "StockholdersEquity",
    "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest"
  ], moneyUnits);
  const cash = latestInstant(companyFacts, "us-gaap", [
    "CashAndCashEquivalentsAtCarryingValue",
    "CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents"
  ], moneyUnits);
  const shares = latestInstant(companyFacts, "dei", ["EntityCommonStockSharesOutstanding"], ["shares"]);

  const debtCurrent = latestInstant(companyFacts, "us-gaap", [
    "LongTermDebtAndFinanceLeaseObligationsCurrent",
    "LongTermDebtCurrent"
  ], moneyUnits);
  const debtNoncurrent = latestInstant(companyFacts, "us-gaap", [
    "LongTermDebtAndFinanceLeaseObligationsNoncurrent",
    "LongTermDebtNoncurrent"
  ], moneyUnits);
  const debtCombined = latestInstant(companyFacts, "us-gaap", [
    "LongTermDebtAndFinanceLeaseObligations",
    "LongTermDebt"
  ], moneyUnits);
  const debt = Number.isFinite(debtCurrent?.val) || Number.isFinite(debtNoncurrent?.val)
    ? (debtCurrent?.val || 0) + (debtNoncurrent?.val || 0)
    : debtCombined?.val ?? null;

  const freeCashFlow =
    Number.isFinite(operatingCashFlow?.val) && Number.isFinite(capitalSpending?.val)
      ? convertMoney(operatingCashFlow.val - Math.abs(capitalSpending.val))
      : null;
  const revenueValue = convertMoney(revenue?.val);
  const previousRevenueValue = convertMoney(previousRevenue?.val);
  const netIncomeValue = convertMoney(netIncome?.val);
  const previousNetIncomeValue = convertMoney(previousNetIncome?.val);
  const assetsValue = convertMoney(assets?.val);
  const liabilitiesValue = convertMoney(liabilities?.val);
  const equityValue = convertMoney(equity?.val);
  const cashValue = convertMoney(cash?.val);
  const debtValue = convertMoney(debt);
  const epsValue = convertMoney(eps?.val);
  const marketCap =
    Number.isFinite(currentPrice) && Number.isFinite(shares?.val) ? currentPrice * shares.val : null;
  const peRatio =
    Number.isFinite(currentPrice) && Number.isFinite(epsValue) && epsValue > 0
      ? currentPrice / epsValue
      : null;

  return {
    values: {
      revenue: revenueValue,
      previousRevenue: previousRevenueValue,
      revenueGrowth: growthRate(revenue?.val, previousRevenue?.val),
      netIncome: netIncomeValue,
      previousNetIncome: previousNetIncomeValue,
      earningsGrowth: growthRate(netIncome?.val, previousNetIncome?.val),
      profitMargin: safeDivide(netIncome?.val, revenue?.val),
      operatingCashFlow: convertMoney(operatingCashFlow?.val),
      capitalSpending: convertMoney(capitalSpending?.val),
      freeCashFlow,
      freeCashFlowMargin: safeDivide(freeCashFlow, revenueValue),
      assets: assetsValue,
      liabilities: liabilitiesValue,
      equity: equityValue,
      cash: cashValue,
      debt: debtValue,
      debtToAssets: safeDivide(debtValue, assetsValue),
      debtToEquity: safeDivide(debtValue, equityValue),
      sharesOutstanding: shares?.val ?? null,
      eps: epsValue,
      dividendPerShare: convertMoney(dividend?.val),
      fiscalYearEnd: revenue?.end ?? null,
      marketCap,
      peRatio,
      priceToSales: safeDivide(marketCap, revenueValue),
      freeCashFlowYield: safeDivide(freeCashFlow, marketCap)
    },
    filingAsOf: newestFilingDate(
      revenue,
      previousRevenue,
      netIncome,
      previousNetIncome,
      operatingCashFlow,
      capitalSpending,
      assets,
      liabilities,
      equity,
      shares
    )
  };
}

async function fetchPriceData(symbol) {
  const path = `/v8/finance/chart/${encodeURIComponent(symbol)}?range=1y&interval=1d&events=div%2Csplits`;
  let payload = null;
  let usedHost = null;
  let yahooError = null;
  for (const host of ["query2.finance.yahoo.com", "query1.finance.yahoo.com"]) {
    try {
      payload = await fetchJson(`https://${host}${path}`, {
        headers: { "User-Agent": "Mozilla/5.0 PlainStock/1.0" }
      });
      usedHost = host;
      break;
    } catch (error) {
      yahooError = error;
    }
  }

  const result = payload?.chart?.result?.[0];
  if (!result) return fetchNasdaqPriceData(symbol, yahooError);
  const timestamps = result.timestamp || [];
  const closes = result.indicators?.quote?.[0]?.close || [];
  const history = timestamps
    .map((timestamp, index) => ({
      date: new Date(timestamp * 1000).toISOString().slice(0, 10),
      close: closes[index]
    }))
    .filter((point) => Number.isFinite(point.close));
  const latestHistoryPrice = history.at(-1)?.close ?? null;
  const currentPrice = Number.isFinite(result.meta?.regularMarketPrice)
    ? result.meta.regularMarketPrice
    : latestHistoryPrice;
  const previousClose = history.length >= 2 ? history.at(-2).close : result.meta?.chartPreviousClose ?? null;
  const prices = history.map((point) => point.close);

  return {
    values: {
      currentPrice,
      previousClose,
      currency: result.meta?.currency || "USD",
      fiftyTwoWeekHigh: prices.length ? Math.max(...prices) : null,
      fiftyTwoWeekLow: prices.length ? Math.min(...prices) : null,
      history
    },
    priceAsOf: history.at(-1)?.date ?? null,
    sourceUrl: `https://${usedHost}${path}`
  };
}

function parseNasdaqPrice(value) {
  if (typeof value !== "string") return null;
  const number = Number(value.replace(/[^0-9.-]/g, ""));
  return Number.isFinite(number) ? number : null;
}

function nasdaqDate(value) {
  const [month, day, year] = String(value).split("/");
  return year && month && day ? `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}` : null;
}

async function fetchNasdaqPriceData(symbol, yahooError) {
  if (symbol.includes("=")) throw yahooError || new Error("No currency price data returned");
  const start = new Date();
  start.setUTCFullYear(start.getUTCFullYear() - 1);
  const fromDate = start.toISOString().slice(0, 10);
  const sourceUrl = `https://api.nasdaq.com/api/quote/${encodeURIComponent(symbol)}/historical?assetclass=stocks&fromdate=${fromDate}&limit=500`;
  const payload = await fetchJson(sourceUrl, {
    headers: {
      "User-Agent": "Mozilla/5.0 PlainStock/1.0",
      Accept: "application/json, text/plain, */*"
    }
  });
  const history = (payload?.data?.tradesTable?.rows || [])
    .map((row) => ({ date: nasdaqDate(row.date), close: parseNasdaqPrice(row.close) }))
    .filter((point) => point.date && Number.isFinite(point.close))
    .sort((left, right) => left.date.localeCompare(right.date));
  if (!history.length) throw yahooError || new Error("No market price data returned");
  const prices = history.map((point) => point.close);
  return {
    values: {
      currentPrice: history.at(-1).close,
      previousClose: history.at(-2)?.close ?? null,
      currency: "USD",
      fiftyTwoWeekHigh: Math.max(...prices),
      fiftyTwoWeekLow: Math.min(...prices),
      history
    },
    priceAsOf: history.at(-1).date,
    sourceUrl,
    sourceName: "Nasdaq public historical endpoint (Yahoo fallback)"
  };
}

async function updateStock(stock, cikByTicker) {
  const cik = stock.cik || cikByTicker.get(stock.symbol);
  if (!cik) throw new Error("Ticker was not found in the SEC company list");
  const paddedCik = String(cik).padStart(10, "0");
  const secUrl = `https://data.sec.gov/api/xbrl/companyfacts/CIK${paddedCik}.json`;
  const submissionsUrl = `https://data.sec.gov/submissions/CIK${paddedCik}.json`;

  const [companyFacts, prices, submissions] = await Promise.all([
    fetchJson(secUrl, {
      headers: {
        "User-Agent": secUserAgent,
        "Accept-Encoding": "gzip, deflate",
        Host: "data.sec.gov"
      }
    }),
    fetchPriceData(stock.symbol),
    stock.sector === "Other"
      ? fetchJson(submissionsUrl, {
          headers: {
            "User-Agent": secUserAgent,
            "Accept-Encoding": "gzip, deflate",
            Host: "data.sec.gov"
          }
        })
      : Promise.resolve(null)
  ]);

  const filingCurrency = detectFilingCurrency(companyFacts);
  let conversionRate = 1;
  if (filingCurrency !== prices.values.currency) {
    const foreignExchange = await fetchPriceData(`${filingCurrency}${prices.values.currency}=X`);
    conversionRate = foreignExchange.values.currentPrice;
  }
  const extracted = extractFundamentals(
    companyFacts,
    prices.values.currentPrice,
    filingCurrency,
    conversionRate
  );
  const sector = stock.sector === "Other"
    ? sectorFromSic(submissions?.sic, submissions?.sicDescription)
    : stock.sector;
  return {
    symbol: stock.symbol,
    name: companyFacts.entityName || stock.name,
    sector,
    industry: submissions?.sicDescription || null,
    exchange: stock.exchange,
    currency: prices.values.currency,
    filingCurrency,
    filingCurrencyToMarketRate: conversionRate,
    cik: paddedCik,
    updatedAt: new Date().toISOString(),
    priceAsOf: prices.priceAsOf,
    filingAsOf: extracted.filingAsOf,
    sources: {
      fundamentals: "SEC EDGAR company facts",
      prices: prices.sourceName || "Yahoo Finance public chart endpoint (unofficial)",
      secUrl,
      submissionsUrl: submissions ? submissionsUrl : null,
      priceUrl: prices.sourceUrl
    },
    market: prices.values,
    fundamentals: extracted.values
  };
}

async function writeBrowserBundle(stocks) {
  const bundle = {};
  for (const stock of stocks) {
    try {
      const contents = await readFile(resolve(outputDirectory, `${stock.symbol}.json`), "utf8");
      bundle[stock.symbol] = JSON.parse(contents);
    } catch {
      // A failed refresh should not prevent the remaining saved companies from loading.
    }
  }
  const source = `window.STOCK_DATA=${JSON.stringify(bundle)};\n`;
  await writeFile(resolve(projectRoot, "data", "stock-data.js"), source, "utf8");
  return Object.keys(bundle);
}

async function main() {
  let stocks = await readStockLibrary();
  const rawSymbols = process.argv.slice(2);
  const invalidSymbols = rawSymbols.filter((symbol) => !/^[A-Z0-9.-]{1,10}$/i.test(String(symbol).trim()));
  if (invalidSymbols.length) throw new Error(`Invalid stock symbol(s): ${invalidSymbols.join(", ")}`);
  const requestedSymbols = new Set(rawSymbols.map(normalizeSymbol));
  const companyByTicker = await fetchCompanyDirectory();
  const catalogSize = await writeStockCatalog(companyByTicker);
  process.stdout.write(`SEC catalog: ${catalogSize} searchable tickers.\n`);
  const addedSymbols = new Set();

  for (const symbol of requestedSymbols) {
    if (stocks.some((stock) => stock.symbol === symbol)) continue;
    const company = companyByTicker.get(symbol);
    if (!company) throw new Error(`${symbol} was not found in the SEC company directory`);
    stocks.push({
      symbol,
      name: displayCompanyName(company.name),
      sector: "Other",
      exchange: normalizeExchange(company.exchange),
      cik: String(company.cik).padStart(10, "0")
    });
    addedSymbols.add(symbol);
  }

  const selectedStocks = requestedSymbols.size
    ? stocks.filter((stock) => requestedSymbols.has(stock.symbol))
    : stocks;
  await mkdir(outputDirectory, { recursive: true });

  if (!requestedSymbols.size) {
    const activeFiles = new Set(stocks.map((stock) => `${stock.symbol}.json`));
    const existingFiles = await readdir(outputDirectory);
    await Promise.all(
      existingFiles
        .filter((file) => file.endsWith(".json") && !activeFiles.has(file))
        .map((file) => unlink(resolve(outputDirectory, file)))
    );
  }

  const cikByTicker = new Map(
    [...companyByTicker].map(([symbol, company]) => [symbol, company.cik])
  );

  const completed = [];
  const failed = [];
  let libraryChanged = false;

  for (const [index, stock] of selectedStocks.entries()) {
    process.stdout.write(`[${index + 1}/${selectedStocks.length}] ${stock.symbol} `);
    try {
      const data = await updateStock(stock, cikByTicker);
      await writeFile(
        resolve(outputDirectory, `${stock.symbol}.json`),
        `${JSON.stringify(data, null, 2)}\n`,
        "utf8"
      );
      if (addedSymbols.has(stock.symbol)) {
        stock.name = displayCompanyName(data.name || stock.name);
        libraryChanged = true;
      }
      if (stock.sector === "Other" && data.sector && data.sector !== "Other") {
        stock.sector = data.sector;
        libraryChanged = true;
      }
      completed.push(stock.symbol);
      process.stdout.write("updated\n");
    } catch (error) {
      failed.push({ symbol: stock.symbol, error: error.message });
      process.stdout.write(`failed: ${error.message}\n`);
    }
    await wait(180);
  }

  stocks = stocks.filter(
    (stock) => !addedSymbols.has(stock.symbol) || completed.includes(stock.symbol)
  );
  if (libraryChanged) {
    await writeStockLibrary(stocks);
  }
  const available = await writeBrowserBundle(stocks);
  const manifest = {
    updatedAt: new Date().toISOString(),
    completed: available,
    refreshed: completed,
    failed,
    sources: [
      "SEC EDGAR",
      "Yahoo Finance public chart endpoint (unofficial)",
      "Nasdaq public historical endpoint (Yahoo fallback)"
    ]
  };
  await writeFile(resolve(projectRoot, "data", "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

  if (failed.length) {
    process.stderr.write(`Finished with ${failed.length} failure(s). Existing JSON files were preserved when possible.\n`);
    if (requestedSymbols.size) process.exitCode = 1;
  } else {
    process.stdout.write(`Finished. Updated ${completed.length} stocks.\n`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
