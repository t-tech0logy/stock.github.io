(() => {
  "use strict";

  const config = window.PLAINSTOCK_ASSISTANT_CONFIG || {};
  const decodeConfiguredSecret = (value) => {
    const secret = String(value || "").trim();
    if (!secret || String(config.apiKeyEncoding || "").toLowerCase() !== "base64") return secret;
    try {
      return atob(secret).trim();
    } catch {
      return "";
    }
  };
  const dashboard = window.PLAINSTOCK_DASHBOARD || null;
  const assistantProxyRoot = String(config.assistantProxyRoot || "").replace(/\/$/, "");
  const marketProxyRoot = String(config.marketProxyRoot || dashboard?.getMarketProxyRoot?.() || "").replace(/\/$/, "");
  const geminiApiKeys = Array.from(new Set([
    config.geminiApiKey,
    ...(Array.isArray(config.geminiApiKeys) ? config.geminiApiKeys : [])
  ].map(decodeConfiguredSecret).filter(Boolean)));
  if (assistantProxyRoot && !geminiApiKeys.length) geminiApiKeys.push("__SERVER_PROXY__");
  const hasGeminiKey = geminiApiKeys.length > 0;
  const geminiApiRoot = String(config.geminiApiRoot || "https://generativelanguage.googleapis.com/v1beta").replace(/\/$/, "");
  const defaultRoutes = {
    normal: ["gemini-2.5-flash-lite", "gemini-2.5-flash", "gemini-3.5-flash-lite", "gemini-3.6-flash"],
    stock: ["gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-3.6-flash", "gemini-3.5-flash-lite"]
  };
  const defaultAgentRoutes = {
    specialist: ["gemini-2.5-flash-lite", "gemini-2.5-flash", "gemini-3.5-flash-lite", "gemini-3.6-flash"],
    synthesis: ["gemini-2.5-flash-lite", "gemini-2.5-flash", "gemini-3.5-flash-lite", "gemini-3.6-flash"],
    validator: ["gemini-2.5-flash-lite", "gemini-2.5-flash", "gemini-3.5-flash-lite", "gemini-3.6-flash"]
  };
  const agentWorkflows = {
    stock: config.agentWorkflows?.stock !== false
  };
  const agentValidation = {
    normal: config.agentValidation?.normal !== false,
    stock: config.agentValidation?.stock !== false
  };
  const keyCooldownMs = Math.max(10_000, Number(config.keyCooldownMs) || 60_000);
  const responseCacheTtlMs = Math.max(60_000, Number(config.responseCacheTtlMs) || 15 * 60_000);
  const responseCachePrefix = "plainstock-assistant-v8:";
  const keyCooldowns = new Map();
  const modelKeyCooldowns = new Map();
  const keyInFlight = new Map();
  let apiKeyCursor = 0;

  const state = {
    mode: "normal",
    busy: false,
    messages: { normal: [], stock: [] },
    transcript: { normal: [], stock: [] },
    suggestionsVisible: { normal: true, stock: true },
    nextMessageId: 1,
    typingQueue: [],
    typingMessage: null,
    reduceMotion: window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches || false,
    lastPresentedStock: null,
    lastModel: null,
    agentActivity: ""
  };

  const elements = {
    launcher: document.querySelector("#assistant-launcher"),
    panel: document.querySelector("#assistant-panel"),
    close: document.querySelector("#assistant-close"),
    reset: document.querySelector("#assistant-reset"),
    fullscreen: document.querySelector("#assistant-fullscreen-toggle"),
    status: document.querySelector("#assistant-status"),
    modeNote: document.querySelector("#assistant-mode-note"),
    modes: Array.from(document.querySelectorAll("[data-assistant-mode]")),
    modePicker: document.querySelector("#assistant-mode-picker"),
    modeTrigger: document.querySelector("#assistant-mode-trigger"),
    modeMenu: document.querySelector("#assistant-mode-menu"),
    modeTriggerIcon: document.querySelector("#assistant-mode-trigger-icon"),
    modeTriggerLabel: document.querySelector("#assistant-mode-trigger-label"),
    modeTriggerDetail: document.querySelector("#assistant-mode-trigger-detail"),
    messages: document.querySelector("#assistant-messages"),
    suggestions: document.querySelector(".assistant-suggestions"),
    quickActions: document.querySelector("#assistant-quick-actions"),
    form: document.querySelector("#assistant-form"),
    input: document.querySelector("#assistant-input"),
    send: document.querySelector("#assistant-send")
  };

  if (!elements.panel || !elements.launcher) return;

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function finite(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function average(values) {
    const usable = values.filter(Number.isFinite);
    return usable.length ? usable.reduce((sum, value) => sum + value, 0) / usable.length : null;
  }

  function formatNumber(value, digits = 2) {
    const number = finite(value);
    if (!Number.isFinite(number)) return "—";
    return new Intl.NumberFormat("en-US", { maximumFractionDigits: digits }).format(number);
  }

  function formatCurrency(value, currency = "USD", digits = 2) {
    const number = finite(value);
    if (!Number.isFinite(number)) return "—";
    try {
      return new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: String(currency || "USD").toUpperCase(),
        maximumFractionDigits: digits
      }).format(number);
    } catch {
      return `${formatNumber(number, digits)} ${currency || ""}`.trim();
    }
  }

  function formatPercent(value, digits = 1) {
    const number = finite(value);
    if (!Number.isFinite(number)) return "—";
    return `${number >= 0 ? "+" : ""}${(number * 100).toFixed(digits)}%`;
  }

  function inlineMarkdown(value) {
    let output = escapeHtml(value);
    output = output.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
    output = output.replace(/`([^`]+)`/g, "<code>$1</code>");
    return output;
  }

  function tableCells(line) {
    return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
  }

  function headingTone(text) {
    const value = String(text || "").toLowerCase();
    if (/strength|positive|what supports|healthy|improving/.test(value)) return "good";
    if (/risk|warning|what weakens|red flag|avoid/.test(value)) return "bad";
    if (/watch|uncertain|missing|disagree|what could change/.test(value)) return "warn";
    return "neutral";
  }

  function tableValueTone(text) {
    const value = String(text || "").replace(/[*_`]/g, "").trim().toLowerCase();
    const score = value.match(/(-?\d+(?:\.\d+)?)\s*\/\s*100/);
    if (score) {
      const number = Number(score[1]);
      if (number >= 70) return "good";
      if (number >= 50) return "warn";
      return "bad";
    }
    if (/positive trend|excellent|strong|healthy|improving|upward|ahead|beating|positive|rising/.test(value)) return "good";
    if (/weak trend|cautious|warning|declin|downward|lagging|negative|red flag|high risk/.test(value)) return "bad";
    if (/mixed trend|mixed|uncertain|watch|moderate|neutral|unavailable/.test(value)) return "warn";
    if (/^\+\d+(?:\.\d+)?%$/.test(value)) return "good";
    if (/^−\d+(?:\.\d+)?%$|^-\d+(?:\.\d+)?%$/.test(value)) return "bad";
    return "neutral";
  }

  function renderMarkdown(text, options = {}) {
    const lines = String(text || "").replace(/\r/g, "").split("\n");
    const output = [];
    const dashboard = options.dashboard === true;
    let index = 0;
    let listType = null;
    let sectionOpen = false;
    let introOpen = dashboard;

    if (introOpen) output.push('<section class="assistant-report-intro"><small>Research summary</small>');

    const closeList = () => {
      if (listType) output.push(`</${listType}>`);
      listType = null;
    };

    const closeSection = () => {
      if (sectionOpen) output.push("</div></details>");
      sectionOpen = false;
    };

    const closeIntro = () => {
      if (introOpen) output.push("</section>");
      introOpen = false;
    };

    while (index < lines.length) {
      const line = lines[index].trim();
      const next = String(lines[index + 1] || "").trim();
      if (!line) {
        closeList();
        index += 1;
        continue;
      }
      if (line.includes("|") && /^\|?\s*:?-{3,}/.test(next)) {
        closeList();
        const headings = tableCells(line);
        index += 2;
        const rows = [];
        while (index < lines.length && lines[index].includes("|")) {
          rows.push(tableCells(lines[index]));
          index += 1;
        }
        output.push(`<div class="assistant-table-wrap"><table><thead><tr>${headings.map((cell) => `<th>${inlineMarkdown(cell)}</th>`).join("")}</tr></thead><tbody>${rows.map((row) => `<tr>${row.map((cell, cellIndex) => {
          const tone = cellIndex === 1 ? tableValueTone(cell) : "neutral";
          return `<td${tone === "neutral" ? "" : ` class="assistant-signal-cell ${tone}"`}>${inlineMarkdown(cell)}</td>`;
        }).join("")}</tr>`).join("")}</tbody></table></div>`);
        continue;
      }
      const heading = line.match(/^(#{2,4})\s+(.+)/);
      if (heading) {
        closeList();
        const tone = headingTone(heading[2]);
        if (dashboard) {
          closeIntro();
          closeSection();
          let nextContentIndex = index + 1;
          while (nextContentIndex < lines.length && (!lines[nextContentIndex].trim() || /^---+$/.test(lines[nextContentIndex].trim()))) {
            nextContentIndex += 1;
          }
          const nextIsHeading = /^(#{2,4})\s+/.test(String(lines[nextContentIndex] || "").trim());
          if (nextIsHeading) {
            if (heading[1].length === 2) output.push(`<div class="assistant-report-group-label"><span></span><strong>${inlineMarkdown(heading[2])}</strong></div>`);
            index += 1;
            continue;
          }
          const icon = tone === "good" ? "✓" : tone === "bad" ? "!" : tone === "warn" ? "~" : "•";
          const expanded = /current dashboard facts|direct conclusion|plain-english conclusion|price summary/i.test(heading[2]);
          output.push(`<details class="assistant-report-section ${tone}"${expanded ? " open" : ""}><summary><span aria-hidden="true">${icon}</span><strong>${inlineMarkdown(heading[2])}</strong><small>View</small></summary><div class="assistant-report-section-body">`);
          sectionOpen = true;
        } else {
          output.push(`<h4 class="${tone}">${inlineMarkdown(heading[2])}</h4>`);
        }
        index += 1;
        continue;
      }
      if (/^---+$/.test(line)) {
        index += 1;
        continue;
      }
      const bullet = line.match(/^[-*]\s+(.+)/);
      const numbered = line.match(/^\d+[.)]\s+(.+)/);
      if (bullet || numbered) {
        const wanted = bullet ? "ul" : "ol";
        if (listType !== wanted) {
          closeList();
          listType = wanted;
          output.push(`<${wanted}>`);
        }
        output.push(`<li>${inlineMarkdown((bullet || numbered)[1])}</li>`);
        index += 1;
        continue;
      }
      closeList();
      output.push(`<p>${inlineMarkdown(line)}</p>`);
      index += 1;
    }
    closeList();
    closeIntro();
    closeSection();
    const content = output.join("");
    return dashboard ? `<div class="assistant-report-toolbar"><div><small>Detailed research</small><strong>Explore the evidence</strong></div><span>Open a section ↓</span></div><div class="assistant-report-dashboard">${content}</div>` : content;
  }

  function decisionMeta(text, mode) {
    const lead = String(text || "")
      .replace(/\[\[PLAINSTOCK_VISUAL\]\][\s\S]*$/i, "")
      .split("\n")
      .map((line) => line.replace(/[*_`#]/g, "").trim())
      .filter(Boolean)
      .slice(0, 3)
      .join(" ")
      .toUpperCase()
      .slice(0, 320);
    if (!lead) return null;

    if (mode === "stock") {
      if (/(?:RESEARCH VIEW|SIMPLE CONCLUSION[^:]*|PRICE SIGNAL)\s*:\s*(?:WEAK TREND|AVOID)/.test(lead)) {
        return { tone: "bad", label: "WEAK TREND", meaning: "Important price warnings outweigh the positive evidence right now." };
      }
      if (/(?:RESEARCH VIEW|SIMPLE CONCLUSION[^:]*|PRICE SIGNAL)\s*:\s*(?:POSITIVE TREND|BUY)/.test(lead)) {
        return { tone: "good", label: "POSITIVE TREND", meaning: "The available price evidence is currently positive." };
      }
      if (/(?:RESEARCH VIEW|SIMPLE CONCLUSION[^:]*|PRICE SIGNAL)\s*:\s*(?:MIXED TREND|WAIT)/.test(lead)) {
        return { tone: "warn", label: "MIXED TREND", meaning: "The evidence is mixed or incomplete, so more confirmation is needed." };
      }
    }
    return null;
  }

  function renderDecisionBanner(decision) {
    if (!decision) return "";
    return `<section class="assistant-decision-banner ${decision.tone}" role="status" aria-label="Research signal: ${escapeHtml(decision.label)}"><i aria-hidden="true"></i><div><small>Research signal</small><strong>${escapeHtml(decision.label)}</strong><p>${escapeHtml(decision.meaning)}</p></div></section>`;
  }

  function extractPresentation(text) {
    const visuals = [];
    const cleanText = String(text || "").replace(/\[\[PLAINSTOCK_VISUAL\]\]([\s\S]*?)\[\[\/PLAINSTOCK_VISUAL\]\]/gi, (match, json) => {
      try {
        const visual = JSON.parse(json.trim());
        if (visual && typeof visual === "object") visuals.push(visual);
      } catch {
        // Ignore malformed optional visual data and keep the readable answer.
      }
      return "";
    }).replace(/\n{3,}/g, "\n\n").trim();
    return { text: cleanText, visuals };
  }

  function visualNumber(value) {
    if (value === null || value === undefined || value === "" || typeof value === "boolean") return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function visualTone(value) {
    const tone = String(value || "neutral").toLowerCase();
    if (["good", "positive", "buy", "long", "support"].includes(tone)) return "good";
    if (["warn", "warning", "mixed", "wait", "no_trade", "no trade"].includes(tone)) return "warn";
    if (["bad", "negative", "avoid", "short", "cautious"].includes(tone)) return "bad";
    return "neutral";
  }

  function formatVisualValue(value) {
    const number = visualNumber(value);
    if (!Number.isFinite(number)) return "—";
    const digits = Math.abs(number) < 1 && number !== 0 ? 3 : 2;
    return new Intl.NumberFormat("en-US", { maximumFractionDigits: digits }).format(number);
  }

  function renderConsensusVisual(visual) {
    const items = (Array.isArray(visual.items) ? visual.items : [])
      .slice(0, 6)
      .filter((item) => {
        const vote = String(item?.vote || "UNCLEAR").toUpperCase().replaceAll("_", " ");
        const confidence = Math.max(0, Math.min(100, visualNumber(item?.confidence) ?? 0));
        return confidence > 0 && !["UNAVAILABLE", "UNCLEAR", "NOT RETURNED"].includes(vote);
      });
    if (!items.length) return "";
    const voteCounts = new Map();
    items.forEach((item) => {
      const vote = String(item?.vote || "UNCLEAR").toUpperCase().replaceAll("_", " ");
      if (["UNAVAILABLE", "UNCLEAR", "NOT RETURNED"].includes(vote)) return;
      voteCounts.set(vote, (voteCounts.get(vote) || 0) + 1);
    });
    const [majorityVote, majorityCount] = [...voteCounts.entries()].sort((left, right) => right[1] - left[1])[0] || ["CHECKS INCOMPLETE", 0];
    return `
      <section class="assistant-data-visual assistant-consensus-visual">
        <header><div><small>Independent checks</small><strong>${escapeHtml(visual.title || "Agent consensus")}</strong></div><b>${majorityCount ? `${escapeHtml(majorityVote)} · ${majorityCount}/${items.length}` : "Retry needed"}</b></header>
        <div class="assistant-consensus-grid">
          ${items.map((item) => {
            const confidence = Math.max(0, Math.min(100, visualNumber(item?.confidence) ?? 0));
            const vote = String(item?.vote || "Unclear").toUpperCase().replaceAll("_", " ");
            return `<article class="${visualTone(item?.tone || vote)}"><span>${escapeHtml(item?.label || "Specialist")}</span><strong>${escapeHtml(vote)}</strong><div><i style="width:${confidence}%"></i></div><small>${Math.round(confidence)}% confidence</small></article>`;
          }).join("")}
        </div>
      </section>`;
  }

  function renderFinancialVisual(visual) {
    const periods = (Array.isArray(visual.periods) ? visual.periods : []).slice(0, 5).map((period) => String(period));
    const series = (Array.isArray(visual.series) ? visual.series : []).slice(0, 4)
      .filter((item) => periods.some((period, index) => Number.isFinite(visualNumber(item?.values?.[index]))));
    if (!periods.length || !series.length) return "";
    return `
      <section class="assistant-data-visual assistant-financial-visual">
        <header><div><small>Verified company figures</small><strong>${escapeHtml(visual.title || "Financial trend")}</strong></div><b>${escapeHtml(visual.unit || "Reported units")}</b></header>
        <div class="assistant-financial-grid">
          ${series.map((item) => {
            const values = periods.map((period, index) => visualNumber(item?.values?.[index]));
            const usable = values.filter(Number.isFinite);
            const scale = Math.max(...usable.map((value) => Math.abs(value)), 1);
            const first = usable[0];
            const last = usable.at(-1);
            const direction = Number.isFinite(first) && Number.isFinite(last)
              ? last > first ? "↑" : last < first ? "↓" : "→"
              : "";
            return `<article class="${visualTone(item?.tone)}"><div class="assistant-financial-series-heading"><span>${escapeHtml(item?.name || "Metric")}</span><strong>${direction} ${formatVisualValue(last)}</strong></div><div class="assistant-financial-bars">${periods.map((period, index) => {
              const value = values[index];
              const height = Number.isFinite(value) ? Math.max(8, Math.round(Math.abs(value) / scale * 50) + 8) : 4;
              return `<div class="assistant-financial-bar-column ${Number.isFinite(value) && value < 0 ? "negative" : ""}"><b>${formatVisualValue(value)}</b><span><i style="height:${height}px"></i></span><small>${escapeHtml(period)}</small></div>`;
            }).join("")}</div></article>`;
          }).join("")}
        </div>
        ${visual.note ? `<p>${escapeHtml(visual.note)}</p>` : ""}
      </section>`;
  }

  function renderComparisonVisual(visual) {
    const items = Array.isArray(visual.items) ? visual.items.slice(0, 6) : [];
    if (!items.length) return "";
    if (visual.layout === "donut") {
      return `
        <section class="assistant-data-visual assistant-comparison-visual assistant-donut-visual">
          <header><div><small>At a glance</small><strong>${escapeHtml(visual.title || "Simple comparison")}</strong></div></header>
          <div class="assistant-donut-grid">${items.map((item) => {
            const score = Math.max(0, Math.min(100, visualNumber(item?.score) ?? 50));
            const tone = visualTone(item?.tone);
            return `<article class="${tone}"><div class="assistant-donut" style="--donut-score:${score * 3.6}deg"><span><strong>${Math.round(score)}</strong><small>/100</small></span></div><div class="assistant-donut-copy"><span>${escapeHtml(item?.label || "Metric")}</span><strong>${escapeHtml(item?.display || `${Math.round(score)}/100`)}</strong>${item?.note ? `<small>${escapeHtml(item.note)}</small>` : ""}</div></article>`;
          }).join("")}</div>
        </section>`;
    }
    return `
      <section class="assistant-data-visual assistant-comparison-visual">
        <header><div><small>At a glance</small><strong>${escapeHtml(visual.title || "Simple comparison")}</strong></div></header>
        <div class="assistant-comparison-list">${items.map((item) => {
          const score = Math.max(0, Math.min(100, visualNumber(item?.score) ?? 50));
          const tone = visualTone(item?.tone);
          return `<article class="${tone}"><div><span>${escapeHtml(item?.label || "Metric")}</span><strong>${escapeHtml(item?.display || formatVisualValue(item?.value))}</strong></div><div class="assistant-comparison-track"><i style="width:${score}%"></i></div>${item?.note ? `<small>${escapeHtml(item.note)}</small>` : ""}</article>`;
        }).join("")}</div>
      </section>`;
  }

  function renderLevelsVisual(visual) {
    const items = (Array.isArray(visual.items) ? visual.items : []).slice(0, 7)
      .map((item) => ({ ...item, value: visualNumber(item?.value) }))
      .filter((item) => Number.isFinite(item.value));
    if (items.length < 2) return "";
    const minimum = Math.min(...items.map((item) => item.value));
    const maximum = Math.max(...items.map((item) => item.value));
    const span = maximum - minimum || 1;
    return `
      <section class="assistant-data-visual assistant-levels-visual">
        <header><div><small>Calculated planning levels</small><strong>${escapeHtml(visual.title || "Price map")}</strong></div><b>${escapeHtml(visual.unit || "Price")}</b></header>
        <div class="assistant-level-list">${items.map((item) => {
          const position = Math.max(2, Math.min(98, (item.value - minimum) / span * 100));
          return `<article class="${visualTone(item?.tone)}"><div><span>${escapeHtml(item?.label || "Level")}</span><strong>${formatVisualValue(item.value)}</strong></div><div class="assistant-level-track"><i style="left:${position}%"></i></div></article>`;
        }).join("")}</div>
      </section>`;
  }

  function renderFlowVisual(visual) {
    const items = (Array.isArray(visual.items) ? visual.items : []).slice(0, 6);
    if (items.length < 2) return "";
    return `
      <section class="assistant-data-visual assistant-flow-visual">
        <header><div><small>How it connects</small><strong>${escapeHtml(visual.title || "Simple flow")}</strong></div></header>
        <ol class="assistant-flow-list">
          ${items.map((item, index) => `<li class="${visualTone(item?.tone)}"><span>${index + 1}</span><div><strong>${escapeHtml(item?.label || `Step ${index + 1}`)}</strong>${item?.note ? `<small>${escapeHtml(item.note)}</small>` : ""}</div></li>`).join("")}
        </ol>
      </section>`;
  }

  function renderRiskMapVisual(visual) {
    const items = (Array.isArray(visual.items) ? visual.items : []).slice(0, 6)
      .map((item) => ({
        ...item,
        likelihood: Math.max(5, Math.min(95, visualNumber(item?.likelihood) ?? 50)),
        impact: Math.max(5, Math.min(95, visualNumber(item?.impact) ?? 50))
      }));
    if (!items.length) return "";
    return `
      <section class="assistant-data-visual assistant-risk-map-visual">
        <header><div><small>Likelihood × impact</small><strong>${escapeHtml(visual.title || "Risk map")}</strong></div></header>
        <div class="assistant-risk-map" role="img" aria-label="${escapeHtml(visual.title || "Risk map")}">
          <span class="risk-axis risk-axis-impact">Higher impact</span>
          <span class="risk-axis risk-axis-likelihood">More likely</span>
          ${items.map((item, index) => `<article class="${visualTone(item?.tone)}" style="left:${item.likelihood}%;top:${100 - item.impact}%" title="${escapeHtml(item?.note || item?.label || `Risk ${index + 1}`)}"><b>${index + 1}</b><span>${escapeHtml(item?.label || `Risk ${index + 1}`)}</span></article>`).join("")}
        </div>
        <div class="assistant-risk-legend">${items.map((item, index) => `<span class="${visualTone(item?.tone)}"><b>${index + 1}</b>${escapeHtml(item?.label || `Risk ${index + 1}`)}</span>`).join("")}</div>
      </section>`;
  }

  function renderTimelineVisual(visual) {
    const items = (Array.isArray(visual.items) ? visual.items : []).slice(0, 7);
    if (items.length < 2) return "";
    return `
      <section class="assistant-data-visual assistant-timeline-visual">
        <header><div><small>What happens when</small><strong>${escapeHtml(visual.title || "Timeline")}</strong></div></header>
        <ol class="assistant-timeline-list">
          ${items.map((item) => `<li class="${visualTone(item?.tone)}"><i></i><div><span>${escapeHtml(item?.date || item?.period || "Next")}</span><strong>${escapeHtml(item?.label || "Event")}</strong>${item?.note ? `<small>${escapeHtml(item.note)}</small>` : ""}</div></li>`).join("")}
        </ol>
      </section>`;
  }

  function renderBalanceVisual(visual) {
    const positive = (Array.isArray(visual.positive) ? visual.positive : []).slice(0, 5).map(String).filter(Boolean);
    const caution = (Array.isArray(visual.caution) ? visual.caution : []).slice(0, 5).map(String).filter(Boolean);
    if (!positive.length && !caution.length) return "";
    return `
      <section class="assistant-data-visual assistant-balance-visual">
        <header><div><small>Evidence on both sides</small><strong>${escapeHtml(visual.title || "What helps and what weakens")}</strong></div></header>
        <div class="assistant-balance-grid">
          ${positive.length ? `<article class="good"><span>+</span><div><strong>Supportive evidence</strong><ul>${positive.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul></div></article>` : ""}
          ${caution.length ? `<article class="bad"><span>!</span><div><strong>Caution evidence</strong><ul>${caution.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul></div></article>` : ""}
        </div>
      </section>`;
  }

  function renderVisuals(visuals = []) {
    return visuals.slice(0, 4).map((visual) => {
      if (visual?.kind === "consensus") return renderConsensusVisual(visual);
      if (visual?.kind === "financial-series") return renderFinancialVisual(visual);
      if (visual?.kind === "comparison") return renderComparisonVisual(visual);
      if (visual?.kind === "levels") return renderLevelsVisual(visual);
      if (visual?.kind === "flow") return renderFlowVisual(visual);
      if (visual?.kind === "risk-map") return renderRiskMapVisual(visual);
      if (visual?.kind === "timeline") return renderTimelineVisual(visual);
      if (visual?.kind === "balance") return renderBalanceVisual(visual);
      return "";
    }).join("");
  }

  function stockResponseVisuals(modelVisuals = []) {
    const visuals = Array.isArray(modelVisuals) ? [...modelVisuals] : [];
    const context = compactStockContext(stockSnapshot());
    if (!context) return visuals;

    const scoreItems = [
      ["Overall price signal", context.priceSignal, context.score, "The combined dashboard reading."],
      ["Recent trend", null, context.recentTrendScore, "How recent price movement is behaving."],
      ["Long-term trend", null, context.longTermScore, "How the longer price direction is behaving."],
      ["Versus the market", null, context.marketComparisonScore, "Whether price performance is keeping up with the benchmark."],
      ["Volume support", null, context.volumeSupportScore, "Whether trading activity supports the price move."],
      ["Price stability", null, context.stabilityScore, "How steady the price movement has been."]
    ].filter((item) => Number.isFinite(visualNumber(item[2])));

    if (scoreItems.length && !visuals.some((visual) => visual?.kind === "comparison")) {
      visuals.unshift({
        kind: "comparison",
        layout: "donut",
        title: `${context.symbol || "Stock"} dashboard evidence`,
        items: scoreItems.map(([label, display, score, note]) => ({
          label,
          display: display || `${Math.round(score)}/100`,
          score,
          tone: scoreTone(score).className,
          note
        }))
      });
    }

    const hasExplanationDiagram = visuals.some((visual) => ["flow", "risk-map", "timeline", "balance"].includes(visual?.kind));
    if (!hasExplanationDiagram) {
      visuals.push({
        kind: "flow",
        title: "How Stock Analytics builds this view",
        items: [
          { label: "Price evidence", note: "Checks trend, market comparison, volume and stability.", tone: scoreTone(context.score).className },
          { label: "Financial health", note: "Checks reported growth, profit, cash flow and debt.", tone: "neutral" },
          { label: "Valuation and risk", note: "Checks expectations, valuation evidence and major risks.", tone: "neutral" },
          { label: "Research view", note: "Combines the supported evidence and explains uncertainty.", tone: "neutral" }
        ]
      });
    }
    return visuals.slice(0, 4);
  }

  function safeSourceLink(source) {
    try {
      const url = new URL(source.url);
      if (url.protocol !== "https:") return "";
      return `<a href="${escapeHtml(url.href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(source.title || url.hostname)}</a>`;
    } catch {
      return "";
    }
  }

  function addMessage(role, content, options = {}) {
    const mode = options.mode || state.mode;
    const typingSource = String(options.rawText || (!options.trusted ? content : ""));
    const decision = role === "assistant" ? decisionMeta(typingSource, mode) : null;
    const renderedContent = options.trusted ? String(content) : renderMarkdown(content);
    const html = `${renderDecisionBanner(decision)}${renderedContent}`;
    const shouldType = role === "assistant"
      && options.animate !== false
      && Boolean(typingSource)
      && !state.reduceMotion
      && !elements.panel.hidden;
    const message = {
      id: state.nextMessageId++,
      mode,
      role,
      html,
      displayHtml: shouldType ? "" : html,
      label: options.label || "",
      tone: options.tone || decision?.tone || "",
      typing: shouldType,
      typingSource,
      cancelled: false
    };
    state.messages[mode].push(message);
    state.messages[mode] = state.messages[mode].slice(-60);
    if (options.rawText) {
      state.transcript[mode].push({ role: role === "assistant" ? "assistant" : "user", text: options.rawText });
      state.transcript[mode] = state.transcript[mode].slice(-8);
    }
    if (mode === state.mode) renderMessages();
    if (shouldType) {
      state.typingQueue.push(message);
      runTypingQueue();
    }
    return message;
  }

  function renderMessages() {
    const messages = state.messages[state.mode]
      .map((message) => `
        <article class="assistant-message ${message.role}${message.tone ? ` tone-${message.tone}` : ""}" data-message-id="${message.id}">
          ${message.role === "assistant" ? '<span class="assistant-message-avatar" aria-hidden="true">P</span>' : ""}
          <div class="assistant-bubble">
            ${message.label ? `<span class="assistant-message-label">${escapeHtml(message.label)}</span>` : ""}
            <div class="assistant-bubble-content">${message.displayHtml}${message.typing ? '<span class="assistant-typing-cursor" aria-hidden="true"></span>' : ""}</div>
          </div>
        </article>
      `)
      .join("");
    const thinking = state.busy
      ? `<article class="assistant-message assistant assistant-thinking" aria-label="Assistant is thinking">
          <span class="assistant-message-avatar" aria-hidden="true">P</span>
          <div class="assistant-bubble"><span class="assistant-thinking-copy">${escapeHtml(state.agentActivity || "Working on it")}</span><span class="assistant-thinking-dots" aria-hidden="true"><i></i><i></i><i></i></span></div>
        </article>`
      : "";
    elements.messages.innerHTML = messages + thinking;
    elements.messages.scrollTop = elements.messages.scrollHeight;
  }

  function messageStillExists(message) {
    return state.messages[message.mode]?.some((item) => item.id === message.id);
  }

  function updateTypingMessage(message) {
    if (message.mode !== state.mode) return;
    const content = elements.messages.querySelector(`[data-message-id="${message.id}"] .assistant-bubble-content`);
    if (!content) return;
    content.innerHTML = `${message.displayHtml}${message.typing ? '<span class="assistant-typing-cursor" aria-hidden="true"></span>' : ""}`;
    elements.messages.scrollTop = elements.messages.scrollHeight;
  }

  function runTypingQueue() {
    if (state.typingMessage || !state.typingQueue.length) return;
    const message = state.typingQueue.shift();
    if (message.cancelled || !messageStillExists(message)) {
      runTypingQueue();
      return;
    }

    state.typingMessage = message;
    let visibleLength = 0;
    const totalLength = message.typingSource.length;
    const charactersPerTick = totalLength > 1500 ? 5 : totalLength > 700 ? 3 : 1;

    const finish = () => {
      message.typing = false;
      message.displayHtml = message.html;
      updateTypingMessage(message);
      state.typingMessage = null;
      runTypingQueue();
    };

    const typeNext = () => {
      if (message.cancelled || !messageStillExists(message)) {
        state.typingMessage = null;
        runTypingQueue();
        return;
      }
      visibleLength = Math.min(totalLength, visibleLength + charactersPerTick);
      message.displayHtml = renderMarkdown(message.typingSource.slice(0, visibleLength));
      updateTypingMessage(message);
      if (visibleLength >= totalLength) {
        finish();
        return;
      }
      const lastCharacter = message.typingSource.charAt(visibleLength - 1);
      const delayMs = /[.!?]/.test(lastCharacter) ? 42 : /[,;:]/.test(lastCharacter) ? 24 : 12;
      window.setTimeout(typeNext, delayMs);
    };

    typeNext();
  }

  function cancelTypingForMode(mode) {
    state.typingQueue = state.typingQueue.filter((message) => {
      if (message.mode !== mode) return true;
      message.cancelled = true;
      return false;
    });
    if (state.typingMessage?.mode === mode) state.typingMessage.cancelled = true;
  }

  function setStatus(text) {
    elements.status.textContent = text;
    elements.status.hidden = !text;
  }

  function renderQuickActions(mode = state.mode) {
    elements.quickActions.innerHTML = quickActionItems(mode)
      .map(([label, prompt, icon]) => `<button type="button" data-assistant-prompt="${escapeHtml(prompt)}"><span aria-hidden="true">${escapeHtml(icon)}</span>${escapeHtml(label)}</button>`)
      .join("");
  }

  function setSuggestionsVisible(mode, visible) {
    state.suggestionsVisible[mode] = Boolean(visible);
    if (mode !== state.mode) return;
    if (visible) renderQuickActions(mode);
    elements.suggestions.hidden = !visible;
  }

  function setBusy(busy, label = "Thinking…") {
    state.busy = busy;
    state.agentActivity = busy ? label : "";
    elements.send.disabled = busy;
    elements.input.disabled = busy;
    elements.modeTrigger.disabled = busy;
    setStatus(busy ? label : state.lastModel ? "Answer ready" : hasGeminiKey ? "Research assistant ready" : "");
    elements.panel.classList.toggle("assistant-is-busy", busy);
    if (!busy) setSuggestionsVisible(state.mode, true);
    renderMessages();
  }

  function setAgentActivity(label) {
    state.agentActivity = String(label || "Working on it");
    setStatus(state.agentActivity);
    renderMessages();
  }

  function openAssistant() {
    elements.panel.hidden = false;
    elements.launcher.setAttribute("aria-expanded", "true");
    window.requestAnimationFrame(() => elements.panel.classList.add("open"));
    window.setTimeout(() => elements.input.focus(), 170);
  }

  function setFullscreen(expanded) {
    const next = Boolean(expanded);
    elements.panel.classList.toggle("assistant-fullscreen", next);
    elements.fullscreen.setAttribute("aria-pressed", String(next));
    elements.fullscreen.setAttribute("aria-label", next ? "Exit assistant full screen" : "Open assistant full screen");
    elements.fullscreen.title = next ? "Exit full screen" : "Full screen";
    document.body.classList.toggle("assistant-fullscreen-open", next);
  }

  function toggleFullscreen() {
    setFullscreen(!elements.panel.classList.contains("assistant-fullscreen"));
  }

  function closeAssistant() {
    closeModeMenu();
    setFullscreen(false);
    elements.panel.classList.remove("open");
    elements.launcher.setAttribute("aria-expanded", "false");
    window.setTimeout(() => {
      if (!elements.panel.classList.contains("open")) elements.panel.hidden = true;
    }, 170);
    elements.launcher.focus();
  }

  function stockSnapshot() {
    return dashboard?.getStockSnapshot?.() || null;
  }

  function modeDescription(mode) {
    if (mode === "stock") {
      const snapshot = stockSnapshot();
      if (snapshot) {
        const tone = scoreTone(snapshot.analysis.overall);
        const score = Number.isFinite(snapshot.analysis.overall) ? `${Math.round(snapshot.analysis.overall)}/100` : "Loading";
        return `<span class="assistant-context-dot stock"></span><span class="assistant-context-copy"><small>Selected dashboard stock</small><strong>${escapeHtml(snapshot.data.symbol)} · ${tone.label} ${score}</strong></span><span class="assistant-context-tag">Price signal</span>`;
      }
      return '<span class="assistant-context-dot stock"></span><span class="assistant-context-copy"><small>Stock Analytics</small><strong>Choose a stock above to begin</strong></span>';
    }
    return "";
  }

  function quickActionItems(mode) {
    if (mode === "stock") {
      return [
        ["Full simple analysis", "Give me the full simple analysis", "◎"],
        ["Financial health", "Show and explain revenue, profit, cash flow, and debt trends", "$"],
        ["Valuation", "Is the company valuation expensive or reasonable?", "↕"],
        ["Biggest risks", "What are the biggest risks?", "!"],
      ];
    }
    return [
      ["Explain this dashboard", "Explain how this dashboard works", "?"],
      ["What does positive trend mean?", "What does the positive price trend mean?", "↑"],
      ["How is risk measured?", "How does PlainStock measure risk?", "!"],
      ["Price vs business", "What is the difference between price trend and business quality?", "⇄" ]
    ];
  }

  function renderModeUi() {
    const modeDetails = {
      normal: { label: "Normal", detail: "General questions", icon: "✦" },
      stock: { label: "Stock Analytics", detail: "Selected company", icon: "↗" }
    };
    elements.modes.forEach((button) => {
      const active = button.dataset.assistantMode === state.mode;
      button.classList.toggle("active", active);
      button.setAttribute("aria-selected", String(active));
    });
    elements.modeTriggerIcon.textContent = modeDetails[state.mode].icon;
    elements.modeTriggerLabel.textContent = modeDetails[state.mode].label;
    elements.modeTriggerDetail.textContent = modeDetails[state.mode].detail;
    const modeContext = modeDescription(state.mode);
    elements.modeNote.innerHTML = modeContext;
    elements.modeNote.hidden = !modeContext;
    elements.input.placeholder = state.mode === "stock"
      ? "Ask about the selected stock…"
      : "Ask a question…";
    renderQuickActions(state.mode);
    elements.suggestions.hidden = !state.suggestionsVisible[state.mode];
    renderMessages();
  }

  function switchMode(mode) {
    if (!state.messages[mode] || state.busy) return;
    closeModeMenu();
    state.mode = mode;
    if (!state.messages[mode].length) addWelcome(mode);
    renderModeUi();
  }

  function closeModeMenu() {
    elements.modeMenu.hidden = true;
    elements.modeTrigger.setAttribute("aria-expanded", "false");
    elements.modePicker.classList.remove("open");
  }

  function toggleModeMenu() {
    if (state.busy) return;
    const opening = elements.modeMenu.hidden;
    elements.modeMenu.hidden = !opening;
    elements.modeTrigger.setAttribute("aria-expanded", String(opening));
    elements.modePicker.classList.toggle("open", opening);
    if (opening) elements.modeMenu.querySelector(".active")?.focus();
  }

  function resetConversation() {
    if (state.busy) return;
    cancelTypingForMode(state.mode);
    state.messages[state.mode] = [];
    state.transcript[state.mode] = [];
    state.suggestionsVisible[state.mode] = true;
    state.lastModel = null;
    addWelcome(state.mode);
    renderModeUi();
    setBusy(false);
    elements.input.focus();
  }

  function addWelcome(mode) {
    if (mode === "stock") {
      const snapshot = stockSnapshot();
      addMessage("assistant", snapshot
        ? hasGeminiKey
          ? "I can see the stock currently open on the dashboard. I’ll combine its price trend with researched revenue, profit, cash flow, debt, valuation, risks, model checks, and a final fact-check—then present the important evidence in plain English."
          : "I can see the stock currently open on the dashboard and can explain its price signal. Add a Gemini key when you want researched company finances, valuation, consensus, and visual financial trends."
        : "Search and open a stock above first. I will then use its actual dashboard numbers for a simple analysis.", { mode, animate: false });
      if (snapshot) {
        addMessage("assistant", stockDataCard(snapshot), { mode, trusted: true, label: "Current stock snapshot" });
        state.lastPresentedStock = snapshot.data.symbol;
      }
      return;
    }
    addMessage("assistant", `
      <section class="assistant-welcome-card">
        <span>Welcome to PlainStock</span>
        <h3>Market research, made easier to understand.</h3>
        <p>Ask a question here or choose a specialist mode above. I will keep the explanation simple and show when a number is unavailable.</p>
        <div class="assistant-welcome-points">
          <small><i aria-hidden="true">✦</i>General questions</small>
          <small><i aria-hidden="true">↗</i>Stock research</small>
        </div>
      </section>
    `, { mode, trusted: true, label: "Research companion", animate: false });
  }

  function scoreTone(score) {
    if (!Number.isFinite(score)) return { className: "wait", label: "MIXED TREND" };
    if (score >= 70) return { className: "buy", label: "POSITIVE TREND" };
    if (score >= 50) return { className: "wait", label: "MIXED TREND" };
    return { className: "avoid", label: "WEAK TREND" };
  }

  function stockDataCard(snapshot) {
    const { data, analysis } = snapshot;
    const tone = scoreTone(analysis.overall);
    const currency = data.market?.currency || data.currency || "USD";
    const price = data.market?.currentPrice;
    const history = data.market?.history || [];
    return `
      <section class="assistant-analysis-card ${tone.className}">
        <div class="assistant-analysis-heading">
          <div><span>Dashboard price signal</span><strong>${escapeHtml(data.symbol)} · ${tone.label}</strong></div>
          <b>${Number.isFinite(analysis.overall) ? `${Math.round(analysis.overall)}/100` : "—"}</b>
        </div>
        ${lineChartSvg(history.slice(-80), tone.className)}
        <div class="assistant-table-wrap">
          <table>
            <tbody>
              <tr><th>Latest price</th><td>${formatCurrency(price, currency)}</td></tr>
              <tr><th>1 month</th><td>${formatPercent(analysis.oneMonthReturn)}</td></tr>
              <tr><th>1 year</th><td>${formatPercent(analysis.oneYearReturn)}</td></tr>
              <tr><th>Vs S&amp;P 500</th><td>${formatPercent(Number.isFinite(analysis.relativeOneYear) ? analysis.relativeOneYear : analysis.relativeThreeMonth)}</td></tr>
              <tr><th>Typical daily move</th><td>${Number.isFinite(analysis.typicalDailyMove) ? `${(analysis.typicalDailyMove * 100).toFixed(1)}%` : "—"}</td></tr>
              <tr><th>Worst slide</th><td>${formatPercent(analysis.drawdown)}</td></tr>
            </tbody>
          </table>
        </div>
        <p class="assistant-card-note">This price signal does not include earnings, debt, cash flow, or valuation unless AI research is connected.</p>
      </section>
    `;
  }

  function lineChartSvg(points, tone = "buy") {
    const values = points.map((point) => finite(point.close)).filter(Number.isFinite);
    if (values.length < 2) return "";
    const width = 520;
    const height = 142;
    const pad = 10;
    const minimum = Math.min(...values);
    const maximum = Math.max(...values);
    const span = maximum - minimum || 1;
    const path = values.map((value, index) => {
      const x = pad + (index / (values.length - 1)) * (width - pad * 2);
      const y = pad + (1 - (value - minimum) / span) * (height - pad * 2);
      return `${index ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(" ");
    const area = `${path} L${width - pad},${height - pad} L${pad},${height - pad} Z`;
    return `
      <svg class="assistant-line-chart ${escapeHtml(tone)}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Recent closing-price trend">
        <defs><linearGradient id="assistant-area-${escapeHtml(tone)}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-opacity=".28"/><stop offset="1" stop-opacity=".02"/></linearGradient></defs>
        <path class="area" d="${area}" />
        <path class="line" d="${path}" />
      </svg>
    `;
  }

  function localStockText(prompt, snapshot) {
    const { data, analysis } = snapshot;
    const tone = scoreTone(analysis.overall);
    const lower = prompt.toLowerCase();
    const strengths = [];
    const risks = [];
    if (analysis.recentTrendScore >= 65) strengths.push(`Recent price direction is strong (${Math.round(analysis.recentTrendScore)}/100).`);
    else risks.push(`Recent price direction is not strong (${formatNumber(analysis.recentTrendScore, 0)}/100).`);
    if (analysis.longTermScore >= 65) strengths.push(`The longer trend is healthy (${Math.round(analysis.longTermScore)}/100).`);
    else risks.push(`The longer trend needs caution (${formatNumber(analysis.longTermScore, 0)}/100).`);
    if (analysis.marketComparisonScore >= 65) strengths.push("It has recently performed better than the wider market.");
    else if (analysis.marketComparisonScore < 45) risks.push("It has recently lagged the wider market.");
    if (analysis.stabilityScore >= 65) strengths.push("The price journey has been relatively stable.");
    else if (analysis.stabilityScore < 45) risks.push("The price has been unusually bumpy.");
    if (analysis.rangePosition >= 0.85) risks.push("The price is near the top of its one-year range, so expectations may already be high.");
    if (analysis.distanceFrom50 > 0.12) risks.push("The price is far above its 50-day average and may be stretched in the short term.");

    if (lower.includes("strength")) return `**Main strengths for ${data.symbol}**\n\n${strengths.length ? strengths.map((item) => `- ${item}`).join("\n") : "- The current dashboard has no strong price-based advantage to highlight."}`;
    if (lower.includes("risk") || lower.includes("careful")) return `**Biggest price-based risks for ${data.symbol}**\n\n${risks.length ? risks.map((item) => `- ${item}`).join("\n") : "- No major price warning appears in the current data, but business and valuation risks are still unknown."}\n\nThis does not yet include earnings, debt, cash flow, or valuation.`;
    if (lower.includes("stretch") || lower.includes("expensive") || lower.includes("valuation")) {
      const relation = Number.isFinite(analysis.distanceFrom50)
        ? `The price is ${Math.abs(analysis.distanceFrom50 * 100).toFixed(1)}% ${analysis.distanceFrom50 >= 0 ? "above" : "below"} its 50-day average.`
        : "The 50-day comparison is unavailable.";
      return `**Price stretch for ${data.symbol}**\n\n${relation} ${analysis.rangePosition >= 0.85 ? "It is also near the top of its one-year range." : "It is not at the extreme top of its one-year range."}\n\nThat is not the same as company valuation. A true valuation view needs earnings, cash flow, debt, growth, and ratios such as P/E.`;
    }
    return `**Simple conclusion for ${data.symbol}: ${tone.label} price signal (${formatNumber(analysis.overall, 0)}/100).**\n\n### What supports the price signal\n${strengths.slice(0, 3).map((item) => `- ${item}`).join("\n") || "- No clear price-based strengths."}\n\n### What weakens the price signal\n${risks.slice(0, 3).map((item) => `- ${item}`).join("\n") || "- No major price warning in the current data."}\n\nUse this as a research starting point. The built-in score only measures price and trading activity; it does not judge profits, debt, cash flow, or fair value.`;
  }

  function localNormalText(prompt) {
    const lower = prompt.toLowerCase();
    if (lower.includes("buy") && (lower.includes("mean") || lower.includes("signal"))) {
      return "**A positive trend means several price measures are supportive; it does not mean that you should buy.** PlainStock uses this label when its combined price score is 70 or higher. Company finances, valuation, portfolio fit, and your personal situation are separate checks.";
    }
    if (lower.includes("dashboard") || lower.includes("work")) {
      return "PlainStock downloads daily market data, then asks six simple questions: Is the price rising? Is the longer trend healthy? Is it beating the wider market? Does trading activity support the move? Is it near its yearly high? How bumpy is it? Those answers produce a transparent positive, mixed, or weak price-trend label.";
    }
    if (lower.includes("risk") || lower.includes("bumpy")) {
      return "PlainStock measures price risk in two ways: **volatility**, which describes normal up-and-down movement, and **maximum drawdown**, which is the worst fall from a previous high. These describe the price journey; they do not capture every business or market risk.";
    }
    return hasGeminiKey
      ? "I can answer that with AI. Please try sending it again."
      : "The built-in assistant can explain this dashboard, its price-trend label, price risk, and stock analysis. Connect the protected assistant service later for broader questions and financial-report research.";
  }

  function compactStockContext(snapshot) {
    if (!snapshot) return null;
    const { data, analysis } = snapshot;
    return {
      symbol: data.symbol,
      name: data.name,
      exchange: data.exchange,
      sector: data.sector,
      currency: data.market?.currency || data.currency,
      priceAsOf: data.priceAsOf,
      currentPrice: data.market?.currentPrice,
      marketCap: data.market?.marketCap,
      priceSignal: scoreTone(analysis.overall).label,
      score: analysis.overall,
      oneMonthReturn: analysis.oneMonthReturn,
      threeMonthReturn: analysis.threeMonthReturn,
      oneYearReturn: analysis.oneYearReturn,
      versusMarket: Number.isFinite(analysis.relativeOneYear) ? analysis.relativeOneYear : analysis.relativeThreeMonth,
      distanceFrom50DayAverage: analysis.distanceFrom50,
      distanceFrom200DayAverage: analysis.distanceFrom200,
      yearlyRangePosition: analysis.rangePosition,
      volatility: analysis.volatility,
      maximumDrawdown: analysis.drawdown,
      recentTrendScore: analysis.recentTrendScore,
      longTermScore: analysis.longTermScore,
      marketComparisonScore: analysis.marketComparisonScore,
      volumeSupportScore: analysis.volumeSupportScore,
      stabilityScore: analysis.stabilityScore
    };
  }

  const sharedAssistantInstructions = "You are PlainStock Assistant, an educational market-research guide for non-professionals. Give substantial evidence and detail, but translate every technical idea into short, ordinary language. Start with the direct conclusion, use descriptive headings and compact tables, define unavoidable jargon immediately, and explain why each important number matters. Never invent a figure. State the reporting period or market-data date beside every time-sensitive figure. Clearly separate observed data, calculated signals, researched facts, and uncertainty. Never claim certainty or give personalized financial advice.";

  const agentSkills = {
    stockPrice: {
      name: "Price evidence",
      webSearch: false,
      instructions: "Use only the verified dashboard JSON. Check every calculation against the supplied values, then explain the current price signal, short and long trend, market comparison, range position, volume support, stability, volatility, and drawdown. Do not research or guess company accounts. State the data date, show the strongest supporting and opposing evidence, and distinguish a price signal from a company valuation."
    },
    stockFundamentals: {
      name: "Financial health",
      webSearch: true,
      instructions: "Research official earnings releases, investor-relations material, and regulatory filings for this exact company. When available, collect at least three annual periods or four recent quarters for revenue, net profit or loss, operating cash flow, capital expenditure, free cash flow, total debt, and cash. Verify units and reporting periods across sources. If free cash flow is calculated, show operating cash flow minus capital expenditure. Explain revenue growth, profit margins, cash conversion, debt affordability, liquidity, auditor or going-concern warnings, and the next earnings or reporting item worth watching. Prefer company and regulator sources, but do not require one particular database. Mark unavailable figures instead of estimating them and explicitly list conflicting figures."
    },
    stockValuation: {
      name: "Valuation and risk",
      webSearch: true,
      instructions: "Research the latest defensible valuation measures available for this exact security, such as P/E, forward P/E, price-to-sales, EV/EBITDA, free-cash-flow yield, or an appropriate alternative. Cross-check the valuation date and denominator period. Use reliable current sources for shares, debt, cash, business risks, legal matters, segment concentration, and material changes; official company material and regulatory filings are useful supporting evidence when available. Compare with the company's own history or relevant peers only when reliable current sources support it. Explain what investors appear to be assuming, plus major business, concentration, competition, balance-sheet, legal, and expectation risks. State every valuation date because price-based ratios change. Flag source disagreement and never invent a fair-value target."
    }
  };

  function visualContractFor(mode) {
    const optionalFormats = `Available diagram formats are: [[PLAINSTOCK_VISUAL]]{"kind":"flow","title":"How the idea connects","items":[{"label":"Step","note":"short explanation","tone":"good or warn or bad or neutral"}]}[[/PLAINSTOCK_VISUAL]], [[PLAINSTOCK_VISUAL]]{"kind":"risk-map","title":"Main risks","items":[{"label":"Risk","likelihood":50,"impact":50,"tone":"good or warn or bad","note":"why it matters"}]}[[/PLAINSTOCK_VISUAL]], [[PLAINSTOCK_VISUAL]]{"kind":"timeline","title":"What to watch","items":[{"date":"period or date","label":"Event","note":"why it matters","tone":"good or warn or bad or neutral"}]}[[/PLAINSTOCK_VISUAL]], or [[PLAINSTOCK_VISUAL]]{"kind":"balance","title":"Evidence balance","positive":["supported strength"],"caution":["supported concern"]}[[/PLAINSTOCK_VISUAL]]. Use only evidence already established in the answer. Never invent dates, scores, events, risks, or financial figures merely to fill a visual.`;
    if (mode === "stock") return `After the readable answer, output two raw JSON blocks with no Markdown fence when the underlying data exists. First: [[PLAINSTOCK_VISUAL]]{"kind":"consensus","title":"Model checks","items":[{"label":"Price evidence","vote":"POSITIVE or MIXED or CAUTIOUS","confidence":70,"tone":"good or warn or bad"},{"label":"Financial health","vote":"POSITIVE or MIXED or CAUTIOUS","confidence":70,"tone":"good or warn or bad"},{"label":"Valuation and risk","vote":"POSITIVE or MIXED or CAUTIOUS","confidence":70,"tone":"good or warn or bad"}]}[[/PLAINSTOCK_VISUAL]]. Include only checks supported by returned evidence; omit unavailable or 0-confidence checks entirely. Second: [[PLAINSTOCK_VISUAL]]{"kind":"financial-series","title":"Revenue, profit, cash flow and debt","unit":"currency plus scale, for example USD billions","periods":["FY2023","FY2024","FY2025"],"series":[{"name":"Revenue","values":[0,0,0],"tone":"good"},{"name":"Net profit","values":[0,0,0],"tone":"good"},{"name":"Free cash flow","values":[0,0,0],"tone":"good"},{"name":"Total debt","values":[0,0,0],"tone":"warn"}],"note":"short scope note"}[[/PLAINSTOCK_VISUAL]]. Use only verified figures, null for unavailable values, and the same stated unit. ${optionalFormats} Add at most one of those diagrams when it materially improves the explanation.`;
    return `When a visual materially clarifies the answer, add at most one raw JSON block with no Markdown fence. For numeric comparisons use [[PLAINSTOCK_VISUAL]]{"kind":"comparison","title":"Simple comparison","items":[{"label":"Metric","display":"human-readable value","score":50,"tone":"good or warn or bad or neutral","note":"why it matters"}]}[[/PLAINSTOCK_VISUAL]]. Score is only a 0-100 display position. ${optionalFormats} Choose either the comparison or one diagram, never both. Do not add a visual when ordinary text is clearer.`;
  }

  function instructionsFor(mode) {
    if (mode === "stock") return `${sharedAssistantInstructions} Analyze the selected stock using supplied dashboard facts and current researched evidence. Explain what supports and weakens the case. Describe the price trend as POSITIVE TREND, MIXED TREND, or WEAK TREND, never as a buy or sell instruction, and identify missing valuation or financial data. Use official company material and regulatory filings as optional supporting evidence when available. ${visualContractFor(mode)}`;
    return `${sharedAssistantInstructions} Answer general questions clearly. When explaining PlainStock, say its built-in stock result is based on price and volume, not a full company valuation. Direct detailed company research questions to Stock Analytics. ${visualContractFor(mode)}`;
  }

  function extractResponse(payload) {
    const candidate = payload?.candidates?.[0];
    const texts = (candidate?.content?.parts || [])
      .filter((part) => typeof part?.text === "string" && part.thought !== true)
      .map((part) => part.text);
    const grounding = candidate?.groundingMetadata || {};
    const groundedSources = (grounding.groundingChunks || []).flatMap((chunk) => chunk?.web?.uri
      ? [{ url: chunk.web.uri, title: chunk.web.title }]
      : []);
    const citationSources = (candidate?.citationMetadata?.citationSources || []).flatMap((source) => source?.uri
      ? [{ url: source.uri, title: source.title }]
      : []);
    const sources = [...groundedSources, ...citationSources];
    const uniqueSources = Array.from(new Map(sources.map((source) => [source.url, source])).values());
    const searchWidget = grounding.searchEntryPoint?.renderedContent;
    return {
      text: texts.join("\n\n").trim(),
      sources: uniqueSources,
      searchWidgets: typeof searchWidget === "string" && searchWidget.trim() ? [searchWidget] : [],
      blockReason: payload?.promptFeedback?.blockReason || candidate?.finishReason || ""
    };
  }

  function configuredRoute(group, fallback) {
    const route = config.agentRoutes?.[group];
    return Array.isArray(route) && route.length ? route : fallback;
  }

  function recentConversation(mode, currentPrompt) {
    const conversation = state.transcript[mode];
    const withoutCurrent = conversation.at(-1)?.role === "user" && conversation.at(-1)?.text === currentPrompt
      ? conversation.slice(0, -1)
      : conversation;
    return withoutCurrent.slice(-6)
      .map((item) => `${item.role === "user" ? "Visitor" : "Assistant"}: ${item.text}`)
      .join("\n");
  }

  function modelKeyId(model, apiKey) {
    return `${model}\u0000${apiKey}`;
  }

  function reserveGeminiKey(model, excludedKeys = new Set()) {
    const now = Date.now();
    const available = geminiApiKeys.filter((key) => !excludedKeys.has(key)
      && (keyCooldowns.get(key) || 0) <= now
      && (modelKeyCooldowns.get(modelKeyId(model, key)) || 0) <= now);
    if (!available.length) return null;
    const lightestLoad = Math.min(...available.map((key) => keyInFlight.get(key) || 0));
    const candidates = available.filter((key) => (keyInFlight.get(key) || 0) === lightestLoad);
    const apiKey = candidates[apiKeyCursor % candidates.length];
    apiKeyCursor = (apiKeyCursor + 1) % Number.MAX_SAFE_INTEGER;
    keyInFlight.set(apiKey, (keyInFlight.get(apiKey) || 0) + 1);
    return apiKey;
  }

  function releaseGeminiKey(apiKey) {
    keyInFlight.set(apiKey, Math.max(0, (keyInFlight.get(apiKey) || 1) - 1));
  }

  function coolDownGeminiKey(apiKey, status, model) {
    if (status === 401 || status === 403) {
      keyCooldowns.set(apiKey, Date.now() + 10 * 60_000);
      return;
    }
    const modelCooldown = status === 429
      ? keyCooldownMs
      : status >= 500 || status === 0
        ? 15_000
        : 0;
    if (modelCooldown) modelKeyCooldowns.set(modelKeyId(model, apiKey), Date.now() + modelCooldown);
  }

  async function requestGemini(options) {
    const models = Array.from(new Set((options.models || []).map(String).filter(Boolean)));
    let lastError = new Error("No configured model could answer.");

    for (const model of models) {
      const attemptedKeys = new Set();
      while (attemptedKeys.size < geminiApiKeys.length) {
        const apiKey = reserveGeminiKey(model, attemptedKeys);
        if (!apiKey) break;
        attemptedKeys.add(apiKey);
        const controller = new AbortController();
        const timeout = window.setTimeout(() => controller.abort(), options.timeoutMs || 60_000);
        try {
          const body = {
            system_instruction: {
              parts: [{ text: options.instructions }]
            },
            contents: [{
              role: "user",
              parts: [{ text: options.input }]
            }],
            generationConfig: {
              maxOutputTokens: options.maxOutputTokens || 900
            }
          };
          if (options.tools?.length) body.tools = options.tools;
          const response = await fetch(assistantProxyRoot
            ? `${assistantProxyRoot}/assistant`
            : `${geminiApiRoot}/models/${encodeURIComponent(model)}:generateContent`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...(assistantProxyRoot ? {} : { "x-goog-api-key": apiKey })
            },
            body: JSON.stringify(assistantProxyRoot ? { model, request: body } : body),
            signal: controller.signal
          });
          const payload = await response.json().catch(() => ({}));
          if (!response.ok) {
            const message = payload?.error?.message || `Gemini returned ${response.status}.`;
            const error = new Error(message);
            error.status = response.status;
            error.providerStatus = payload?.error?.status || "";
            lastError = error;
            const credentialError = ["UNAUTHENTICATED", "PERMISSION_DENIED"].includes(error.providerStatus)
              || /api key|credential/i.test(message);
            coolDownGeminiKey(apiKey, credentialError ? 401 : response.status, model);
            if (!credentialError && [400, 404, 422].includes(response.status)) break;
            continue;
          }
          const result = extractResponse(payload);
          if (!result.text) {
            lastError = new Error(result.blockReason
              ? `${model} returned no answer (${result.blockReason}).`
              : `${model} returned no readable text.`);
            continue;
          }
          return { ...result, model };
        } catch (error) {
          const requestError = error.name === "AbortError" ? new Error(`${model} took too long to answer.`) : error;
          requestError.status = error.status || 0;
          lastError = requestError;
          coolDownGeminiKey(apiKey, requestError.status, model);
        } finally {
          window.clearTimeout(timeout);
          releaseGeminiKey(apiKey);
        }
      }
    }
    throw lastError;
  }

  function workflowSkills(mode) {
    return mode === "stock"
      ? [agentSkills.stockPrice, agentSkills.stockFundamentals, agentSkills.stockValuation]
      : [];
  }

  function specialistMetadata(report) {
    const text = String(report?.text || "").replace(/[“”]/g, '"').replace(/[‘’]/g, "'");
    const prefixIndex = text.toUpperCase().indexOf("PLAINSTOCK_SPECIALIST");
    if (prefixIndex < 0) return {};
    const start = text.indexOf("{", prefixIndex);
    if (start < 0) return {};
    let depth = 0;
    let inString = false;
    let escaped = false;
    let end = -1;
    for (let index = start; index < text.length; index += 1) {
      const character = text[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '"') inString = false;
        continue;
      }
      if (character === '"') inString = true;
      else if (character === "{") depth += 1;
      else if (character === "}") {
        depth -= 1;
        if (depth === 0) {
          end = index + 1;
          break;
        }
      }
    }
    if (end < 0) return {};
    try {
      const parsed = JSON.parse(text.slice(start, end));
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }

  function specialistVote(report, mode) {
    if (!report?.text) return { rawVote: "UNAVAILABLE", vote: "UNAVAILABLE", tone: "neutral", confidence: 0 };
    const metadata = specialistMetadata(report);
    const normalized = String(report.text).replace(/[*_`]/g, "").replace(/\u00a0/g, " ");
    const voteMatch = normalized.match(/(?:SPECIALIST\s*VOTE|FINAL\s*VOTE|VOTE)\s*[:=-]\s*(POSITIVE|MIXED|CAUTIOUS)/i);
    const confidenceMatch = normalized.match(/CONFIDENCE\s*[:=-]\s*(\d{1,3})/i);
    let rawVote = String(metadata.vote || voteMatch?.[1] || "").toUpperCase().replace(/[ -]+/g, "_");
    let confidence = Math.max(0, Math.min(100, Number(metadata.confidence ?? confidenceMatch?.[1]) || 0));
    if (!rawVote || !["POSITIVE", "MIXED", "CAUTIOUS"].includes(rawVote)) {
      rawVote = "MIXED";
      confidence = confidence || 25;
    }
    if (rawVote === "POSITIVE") return { rawVote, vote: "POSITIVE", tone: "good", confidence };
    if (rawVote === "MIXED") return { rawVote, vote: "MIXED", tone: "warn", confidence };
    if (rawVote === "CAUTIOUS") return { rawVote, vote: "CAUTIOUS", tone: "bad", confidence };
    return { rawVote: "UNAVAILABLE", vote: "UNAVAILABLE", tone: "neutral", confidence: 0 };
  }

  function conciseSpecialistEvidence(text, maximum = 1500) {
    const cleaned = String(text || "")
      .replace(/^\s*PLAINSTOCK_SPECIALIST\s*:.*$/gim, "")
      .replace(/^.*SPECIALIST_VOTE:.*$/gim, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    if (cleaned.length <= maximum) return cleaned;
    const shortened = cleaned.slice(0, maximum);
    const sentenceEnd = Math.max(shortened.lastIndexOf(". "), shortened.lastIndexOf(".\n"));
    return `${shortened.slice(0, sentenceEnd > maximum * 0.6 ? sentenceEnd + 1 : maximum).trim()}…`;
  }

  function localConsensusResult(mode, context, reports, skills) {
    const reportBySkill = new Map(reports.map((report) => [report.skill, report]));
    const items = skills.map((skill) => {
      const report = reportBySkill.get(skill.name);
      return { label: skill.name, ...specialistVote(report, mode) };
    });
    const available = items.filter((item) => item.rawVote !== "UNAVAILABLE");
    let conclusion = "MIXED TREND";
    if (mode === "stock" && available.length >= 2) {
      const positive = available.filter((item) => item.rawVote === "POSITIVE").length;
      const cautious = available.filter((item) => item.rawVote === "CAUTIOUS").length;
      if (positive >= 2 && cautious === 0) conclusion = "POSITIVE TREND";
      else if (cautious >= 2 && positive === 0) conclusion = "WEAK TREND";
    }

    const consensusVisual = {
      kind: "consensus",
      title: "Agent consensus",
      items: items.map(({ label, vote, tone, confidence }) => ({ label, vote, tone, confidence }))
    };
    const evidence = reports.map((report) => `### ${report.skill}\n${conciseSpecialistEvidence(report.text)}`).join("\n\n");
    const reason = conclusion === "POSITIVE TREND"
      ? "The completed checks are positive."
      : conclusion === "WEAK TREND"
        ? "The completed checks show more serious warnings than positive evidence."
        : "The completed checks disagree, are incomplete, or need stronger evidence.";
    return {
      text: `Research view: ${conclusion}\n\n${reason} PlainStock combined the available model checks automatically.\n\n## Current dashboard facts\n\n| What matters | Current reading |\n|---|---:|\n| Dashboard price trend | ${escapeHtml(context?.priceSignal || "Unavailable")} |\n| Price score | ${formatNumber(context?.score, 0)}/100 |\n| Latest price | ${formatNumber(context?.currentPrice, 2)} ${escapeHtml(context?.currency || "")} |\n| One-year change | ${formatPercent(context?.oneYearReturn)} |\n| Compared with market | ${formatPercent(context?.versusMarket)} |\n\n## Completed model evidence\n\n${evidence}\n\n[[PLAINSTOCK_VISUAL]]${JSON.stringify(consensusVisual)}[[/PLAINSTOCK_VISUAL]]`,
      model: reports[0]?.model || "local-consensus",
      localFallback: true
    };
  }

  function uniqueSources(results) {
    return Array.from(new Map(results.flatMap((result) => result.sources || [])
      .filter((source) => source?.url)
      .map((source) => [source.url, source])).values());
  }

  function uniqueSearchWidgets(results) {
    return Array.from(new Set(results.flatMap((result) => result.searchWidgets || []).filter(Boolean)));
  }

  async function settleWithConcurrency(items, limit, task) {
    const results = Array(items.length);
    let nextIndex = 0;
    const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
      while (nextIndex < items.length) {
        const index = nextIndex;
        nextIndex += 1;
        try {
          results[index] = { status: "fulfilled", value: await task(items[index], index) };
        } catch (reason) {
          results[index] = { status: "rejected", reason };
        }
      }
    });
    await Promise.all(workers);
    return results;
  }

  async function validateDraft({ mode, prompt, history, context, draft, reports = [] }) {
    if (!agentValidation[mode]) return null;
    setAgentActivity(mode === "normal" ? "Fact-checking the answer…" : "Independent validator checking consensus…");
    const reportText = reports.length
      ? reports.map((report) => `## ${report.skill}\n${report.text}`).join("\n\n")
      : "No specialist reports were used in this mode.";
    const stockSourceCheck = mode === "stock"
      ? " For company facts, prefer official earnings material, investor-relations pages, and regulatory filings when available. Missing evidence must be disclosed, but no single source is a mandatory gate."
      : "";
    const validationInstructions = `${sharedAssistantInstructions} You are the independent final validator. Check the draft against the verified app JSON and every specialist report. Recheck arithmetic, units, reporting periods, source dates, direction labels, and confidence claims.${stockSourceCheck} Do not force agreement: preserve and clearly explain genuine disagreement. Remove or correct any unsupported statement or figure. Return the corrected final answer only, not a review memo. Preserve the direct non-technical style. Recreate all required PlainStock visual blocks with corrected values. ${visualContractFor(mode)}`;
    return requestGemini({
      models: configuredRoute("validator", defaultAgentRoutes.validator),
      instructions: validationInstructions,
      input: [
        `Mode: ${mode}`,
        `Visitor's question:\n${prompt}`,
        history ? `Recent conversation:\n${history}` : "",
        context ? `Verified app data (JSON):\n${JSON.stringify(context)}` : "",
        `Specialist reports:\n${reportText}`,
        `Draft answer to validate:\n${draft}`
      ].filter(Boolean).join("\n\n"),
      tools: mode === "stock" ? [{ google_search: {} }] : [],
      maxOutputTokens: mode === "normal" ? 1100 : 1800,
      timeoutMs: mode === "stock" ? 80_000 : 65_000
    });
  }

  async function runAgentWorkflow(mode, prompt) {
    const context = compactStockContext(stockSnapshot());
    const history = recentConversation(mode, prompt);
    const skills = workflowSkills(mode);
    const specialistModels = configuredRoute("specialist", defaultAgentRoutes.specialist);
    const currentDate = new Date().toISOString().slice(0, 10);
    const voteInstructionFor = () => `Your FIRST output line must be valid one-line JSON prefixed exactly with PLAINSTOCK_SPECIALIST: using this shape: PLAINSTOCK_SPECIALIST: {"vote":"POSITIVE or MIXED or CAUTIOUS","confidence":70}. Choose one real vote and integer confidence; do not copy the option list. Put this machine-readable line first so it cannot be cut off, then write the evidence note.`;
    const runSkill = (skill) => requestGemini({
      models: specialistModels,
      instructions: `${sharedAssistantInstructions} You are the ${skill.name} specialist in a coordinated ${mode} research workflow. ${skill.instructions} Validate your own evidence before voting, name contradictions, and do not copy another specialist's likely opinion. Return a detailed evidence note for the lead analyst. Do not address the visitor as if you are the final answer. ${voteInstructionFor()}`,
      input: [
        `Current date: ${currentDate}`,
        history ? `Recent conversation:\n${history}` : "",
        `Verified app data (JSON):\n${JSON.stringify(context)}`,
        `Visitor's question:\n${prompt}`
      ].filter(Boolean).join("\n\n"),
      tools: skill.webSearch ? [{ google_search: {} }] : [],
      maxOutputTokens: skill.name === agentSkills.stockFundamentals.name ? 1200 : 900,
      timeoutMs: skill.webSearch ? 75_000 : 50_000
    });

    setAgentActivity(`Running ${skills.length} independent ${mode} checks…`);
    const settled = await settleWithConcurrency(skills, geminiApiKeys.length, (skill) => runSkill(skill));
    const reports = settled.flatMap((item, index) => item.status === "fulfilled"
      ? [{ skill: skills[index].name, ...item.value }]
      : []);
    if (!reports.length) {
      const firstFailure = settled.find((item) => item.status === "rejected");
      throw firstFailure?.reason || new Error("The research skills could not return a result.");
    }

    setAgentActivity(`Combining ${reports.length} specialist findings…`);
    const missing = skills.filter((skill) => !reports.some((report) => report.skill === skill.name)).map((skill) => skill.name);
    const synthesisInstructions = `${sharedAssistantInstructions} You are the lead stock researcher. Use only the verified app data and specialist reports supplied below. Start with "Research view: POSITIVE TREND", "Research view: MIXED TREND", or "Research view: WEAK TREND", then one short reason. Treat it as a price description, not personal advice. Show the three model checks and explain disagreements before reaching the final view; never imply that model calls are independent human analysts. Keep the dashboard price trend distinct from company quality and valuation. Provide detailed sections for: plain-English conclusion; revenue and profit trend; cash flow quality; debt and liquidity; valuation and market expectations; strongest evidence; biggest risks; upcoming items to watch; and what could change the view. Include a compact table with periods, values, direction, and why each number matters. Be conservative and disclose missing or conflicting figures. ${visualContractFor(mode)}`;
    const synthesisInput = [
      `Current date: ${currentDate}`,
      `Verified app data (JSON):\n${JSON.stringify(context)}`,
      `Visitor's question:\n${prompt}`,
      history ? `Recent conversation:\n${history}` : "",
      `Specialist reports:\n${reports.map((report) => `## ${report.skill}\n${report.text}`).join("\n\n")}`,
      missing.length ? `Unavailable specialist reports: ${missing.join(", ")}. Disclose these gaps.` : ""
    ].filter(Boolean).join("\n\n");

    let synthesis;
    let partial = false;
    try {
      synthesis = await requestGemini({
        models: configuredRoute("synthesis", defaultAgentRoutes.synthesis),
        instructions: synthesisInstructions,
        input: synthesisInput,
        maxOutputTokens: 1800,
        timeoutMs: 70_000
      });
    } catch {
      partial = true;
      synthesis = localConsensusResult(mode, context, reports, skills);
    }

    let finalResult = synthesis;
    let validated = false;
    if (!synthesis.localFallback) {
      try {
        const validation = await validateDraft({ mode, prompt, history, context, draft: synthesis.text, reports });
        if (validation?.text) {
          finalResult = validation;
          validated = true;
        }
      } catch {
        // A complete lead answer is still useful when the optional final check is unavailable.
      }
    }

    const evidenceResults = [...reports, synthesis, finalResult];
    state.lastModel = finalResult.model;
    return {
      text: finalResult.text,
      sources: uniqueSources(evidenceResults),
      searchWidgets: uniqueSearchWidgets(evidenceResults),
      label: validated
        ? `${reports.length} independent checks + final review`
        : partial
          ? `${reports.length} checks · instant consensus`
          : `${reports.length} independent checks`
    };
  }

  async function callSingleAssistant(mode, prompt) {
    const route = Array.isArray(config.modelRoutes?.[mode]) && config.modelRoutes[mode].length
      ? config.modelRoutes[mode]
      : defaultRoutes[mode];
    const history = recentConversation(mode, prompt);
    const context = mode === "stock" ? compactStockContext(stockSnapshot()) : null;
    const draft = await requestGemini({
      models: route,
      instructions: instructionsFor(mode),
      input: [
        history ? `Recent conversation:\n${history}` : "",
        context ? `Current verified app data (JSON):\n${JSON.stringify(context)}` : "",
        `Visitor's current question:\n${prompt}`
      ].filter(Boolean).join("\n\n"),
      tools: mode === "stock" ? [{ google_search: {} }] : [],
      maxOutputTokens: mode === "normal" ? 1300 : 2000
    });
    let result = draft;
    let validated = false;
    try {
      const validation = await validateDraft({ mode, prompt, history, context, draft: draft.text });
      if (validation?.text) {
        result = validation;
        validated = true;
      }
    } catch {
      // Keep the readable first answer if the fact-checking pass is unavailable.
    }
    state.lastModel = result.model;
    return {
      ...result,
      sources: uniqueSources([draft, result]),
      searchWidgets: uniqueSearchWidgets([draft, result]),
      label: validated ? "Answer + fact-check" : "AI answer"
    };
  }

  function responseCacheKey(mode, prompt) {
    const normalizedPrompt = String(prompt || "").trim().toLowerCase().replace(/\s+/g, " ");
    let contextIdentity = "general";
    if (mode === "stock") {
      const context = compactStockContext(stockSnapshot());
      contextIdentity = `${context?.symbol || "none"}|${context?.priceAsOf || ""}|${context?.currentPrice || ""}`;
    }
    const source = `${mode}|${contextIdentity}|${normalizedPrompt}`;
    let hash = 2166136261;
    for (let index = 0; index < source.length; index += 1) {
      hash ^= source.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return `${responseCachePrefix}${(hash >>> 0).toString(36)}`;
  }

  function readCachedResponse(mode, prompt) {
    try {
      const key = responseCacheKey(mode, prompt);
      const stored = JSON.parse(window.sessionStorage.getItem(key) || "null");
      if (!stored?.savedAt || Date.now() - stored.savedAt > responseCacheTtlMs || !stored.result?.text) {
        window.sessionStorage.removeItem(key);
        return null;
      }
      return { ...stored.result, label: "Recent checked answer" };
    } catch {
      return null;
    }
  }

  function cacheResponse(mode, prompt, result) {
    try {
      window.sessionStorage.setItem(responseCacheKey(mode, prompt), JSON.stringify({ savedAt: Date.now(), result }));
    } catch {
      // The assistant still works when browser storage is unavailable or full.
    }
  }

  async function callGemini(mode, prompt) {
    const cached = readCachedResponse(mode, prompt);
    if (cached) {
      setAgentActivity("Reusing the recent checked answer…");
      return cached;
    }
    let result;
    if (mode === "stock" && agentWorkflows.stock) {
      result = await runAgentWorkflow(mode, prompt);
    } else {
      result = await callSingleAssistant(mode, prompt);
    }
    cacheResponse(mode, prompt, result);
    return result;
  }

  function sourcesHtml(sources = []) {
    const links = sources.map(safeSourceLink).filter(Boolean);
    return links.length ? `<div class="assistant-sources"><strong>Sources</strong>${links.join("")}</div>` : "";
  }

  function searchWidgetsHtml(widgets = []) {
    return widgets.length
      ? `<div class="assistant-search-widgets" aria-label="Google Search suggestions">${widgets.join("")}</div>`
      : "";
  }

  function presentAiResult(result, mode = state.mode) {
    const presentation = extractPresentation(result.text);
    const visuals = mode === "stock" ? stockResponseVisuals(presentation.visuals) : presentation.visuals;
    const reportText = mode === "stock"
      ? presentation.text.replace(/^\s*(?:#{1,4}\s*)?Research view\s*:\s*(?:POSITIVE|MIXED|WEAK) TREND\s*/i, "").trim()
      : presentation.text;
    const answer = `${renderVisuals(visuals)}${renderMarkdown(reportText, { dashboard: mode === "stock" })}${sourcesHtml(result.sources)}${searchWidgetsHtml(result.searchWidgets)}`;
    addMessage("assistant", answer, { mode, trusted: true, rawText: presentation.text, label: result.label || state.lastModel });
  }

  async function handlePrompt(prompt) {
    const text = String(prompt || "").trim();
    if (!text || state.busy) return;
    const mode = state.mode;
    addMessage("user", text, { rawText: text });
    setSuggestionsVisible(mode, false);
    elements.input.value = "";
    elements.input.style.height = "auto";

    if (mode === "stock") {
      const snapshot = stockSnapshot();
      if (!snapshot) {
        addMessage("assistant", "Choose and fully load a stock in the dashboard above first. Stock Analytics will automatically use that selected stock.");
        setSuggestionsVisible(mode, true);
        return;
      }
      if (/full|summary|analyse|analyze/i.test(text)) {
        addMessage("assistant", stockDataCard(snapshot), { trusted: true, label: "Live dashboard snapshot" });
      }
      if (!hasGeminiKey) {
        const local = localStockText(text, snapshot);
        addMessage("assistant", local, { rawText: local });
        setSuggestionsVisible(mode, true);
        return;
      }
    }

    if (!hasGeminiKey) {
      const local = localNormalText(text);
      addMessage("assistant", local, { rawText: local });
      setSuggestionsVisible(mode, true);
      return;
    }

    setBusy(true, mode === "normal" ? "Thinking…" : "Preparing research skills…");
    try {
      const result = await callGemini(mode, text);
      presentAiResult(result, mode);
    } catch (error) {
      const fallback = mode === "stock"
        ? localStockText(text, stockSnapshot())
        : "The live research service is busy right now. Please try the question again shortly.";
      const serviceNote = mode === "normal"
        ? "Your conversation is still here."
        : "PlainStock is showing the verified built-in result so the page remains useful while live research capacity recovers.";
      addMessage("assistant", `${fallback}\n\n${serviceNote}`, { rawText: `${fallback}\n\n${serviceNote}`, tone: mode === "normal" ? "warn" : "" });
    } finally {
      setBusy(false);
    }
  }

  elements.launcher.addEventListener("click", () => {
    if (elements.panel.hidden) openAssistant();
    else closeAssistant();
  });
  elements.close.addEventListener("click", closeAssistant);
  elements.reset.addEventListener("click", resetConversation);
  elements.fullscreen.addEventListener("click", toggleFullscreen);
  elements.modeTrigger.addEventListener("click", toggleModeMenu);
  elements.modes.forEach((button) => button.addEventListener("click", () => switchMode(button.dataset.assistantMode)));
  elements.form.addEventListener("submit", (event) => {
    event.preventDefault();
    handlePrompt(elements.input.value);
  });
  elements.input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      elements.form.requestSubmit();
    }
  });
  elements.input.addEventListener("input", () => {
    elements.input.style.height = "auto";
    elements.input.style.height = `${Math.min(120, elements.input.scrollHeight)}px`;
  });
  elements.quickActions.addEventListener("click", (event) => {
    const button = event.target.closest("[data-assistant-prompt]");
    if (button) handlePrompt(button.dataset.assistantPrompt);
  });
  document.addEventListener("plainstock:stock-update", () => {
    if (state.mode === "stock") {
      const snapshot = stockSnapshot();
      if (snapshot) {
        const sameStock = snapshot.data.symbol === state.lastPresentedStock;
        addMessage("assistant", stockDataCard(snapshot), { trusted: true, label: sameStock ? "Full comparison ready" : "Selected stock updated" });
        state.lastPresentedStock = snapshot.data.symbol;
      }
      renderModeUi();
    }
  });
  document.addEventListener("click", (event) => {
    if (!elements.modePicker.contains(event.target)) closeModeMenu();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || elements.panel.hidden) return;
    if (!elements.modeMenu.hidden) closeModeMenu();
    else if (elements.panel.classList.contains("assistant-fullscreen")) setFullscreen(false);
    else closeAssistant();
  });

  addWelcome("normal");
  renderModeUi();
  setBusy(false);
})();
