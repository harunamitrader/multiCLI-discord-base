// Token pricing table (USD per 1M tokens)
const PRICING = {
  // Claude
  "claude-opus-4-6":        { input: 15.00, output: 75.00, cacheRead: 1.50 },
  "claude-opus-4-5":        { input: 15.00, output: 75.00, cacheRead: 1.50 },
  "claude-sonnet-4-6":      { input: 3.00,  output: 15.00, cacheRead: 0.30 },
  "claude-sonnet-4-5":      { input: 3.00,  output: 15.00, cacheRead: 0.30 },
  "claude-haiku-4-5":       { input: 0.25,  output: 1.25,  cacheRead: 0.03 },
  // Gemini
  "gemini-2.5-pro":         { input: 1.25,  output: 10.00, cacheRead: 0.31 },
  "gemini-2.5-flash":       { input: 0.30,  output: 2.50,  cacheRead: 0.075 },
  "gemini-2.0-flash":       { input: 0.10,  output: 0.40,  cacheRead: 0 },
  "gemini-1.5-pro":         { input: 1.25,  output: 5.00,  cacheRead: 0 },
  "gemini-1.5-flash":       { input: 0.075, output: 0.30,  cacheRead: 0 },
  // Codex
  "codex-mini-latest":      { input: 1.50,  output: 6.00,  cacheRead: 0 },
  "o4-mini":                { input: 1.10,  output: 4.40,  cacheRead: 0.275 },
  "o3":                     { input: 10.00, output: 40.00, cacheRead: 2.50 },
};

const USD_TO_JPY = 150;

/**
 * Calculates cost from token usage.
 * @param {string} model
 * @param {{ inputTokens?: number, outputTokens?: number, cacheReadTokens?: number }} usage
 * @returns {{ usd: number, jpy: number } | null}
 */
export function calcCost(model, usage) {
  const p = PRICING[model] || PRICING[Object.keys(PRICING).find((k) => model?.startsWith(k))] || null;
  if (!p) return null;

  const usd =
    ((usage.inputTokens || 0) * p.input +
      (usage.outputTokens || 0) * p.output +
      (usage.cacheReadTokens || 0) * p.cacheRead) /
    1_000_000;

  return { usd, jpy: Math.round(usd * USD_TO_JPY * 10) / 10 };
}

/**
 * Formats usage + cost as a compact string.
 * @param {string} model
 * @param {{ inputTokens?: number, outputTokens?: number, cacheReadTokens?: number }} usage
 * @returns {string}
 */
export function formatUsage(model, usage) {
  if (!usage || (!usage.inputTokens && !usage.outputTokens)) return "";
  const parts = [`in: ${(usage.inputTokens || 0).toLocaleString()} / out: ${(usage.outputTokens || 0).toLocaleString()} tokens`];
  const cost = calcCost(model, usage);
  if (cost) {
    parts.push(`¥${cost.jpy} / $${cost.usd.toFixed(4)}`);
  }
  return parts.join(" — ");
}
