/**
 * "Ask-Tessa" — a natural-language layer over the car's own data, plus
 * proactive briefings and per-drive coach notes. Runs on Cloudflare Workers AI
 * (Llama, free tier), so it stays $0 and needs no external API key.
 *
 * Design: this is retrieval-then-generate, not open tool-calling. The question
 * is keyword-routed to a small set of the existing read functions (the same
 * ones behind the MCP tools), their JSON is assembled into a compact context,
 * and one Workers AI call turns it into a grounded answer. If the AI binding
 * isn't configured, every entry point degrades to a structured, non-LLM
 * summary so the feature never hard-fails.
 */

import { getBudgetStatus } from "./budget";
import { getBatteryForecast } from "./forecast";
import {
  getChargeSessions,
  getDriverScores,
  getEfficiencyByTemp,
  getMonthlyReport,
  getTirePressures,
  getTrackingSummary,
  getVampireDrain,
} from "./tracking";
import { Env } from "./types";

// Candidate models, tried in order — the first that the account has access to
// wins. Kept in a list so a model rename/deprecation is a one-line change.
const MODELS = [
  "@cf/meta/llama-3.1-8b-instruct",
  "@cf/meta/llama-3-8b-instruct",
  "@cf/meta/llama-3.2-3b-instruct",
];

let lastAiError = "";

/** Extracts the text from Workers AI's several possible response shapes. */
function extractText(out: unknown): string | null {
  if (typeof out === "string") return out.trim() || null;
  const o = out as { response?: unknown; result?: { response?: unknown } };
  const r = o?.response ?? o?.result?.response;
  return typeof r === "string" ? r.trim() || null : null;
}

async function runModel(env: Env, system: string, user: string): Promise<string | null> {
  if (!env.AI) { lastAiError = "no AI binding"; return null; }
  for (const model of MODELS) {
    try {
      const out = await env.AI.run(model, {
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        max_tokens: 400,
      });
      const text = extractText(out);
      if (text) return text;
      lastAiError = `empty response from ${model}`;
    } catch (e) {
      lastAiError = `${model}: ${e instanceof Error ? e.message : String(e)}`;
    }
  }
  return null;
}

/** Test-only / diagnostic accessor for the last Workers AI error. */
export function lastAiErrorText(): string {
  return lastAiError;
}

/** Picks which data to load for a question (cheap keyword routing). */
async function assembleContext(env: Env, vin: string, q: string): Promise<{ tools: string[]; data: Record<string, unknown> }> {
  const s = q.toLowerCase();
  const tools: string[] = [];
  const data: Record<string, unknown> = {};
  const want = (re: RegExp) => re.test(s);

  // Always include a compact summary as grounding.
  data.summary = await getTrackingSummary(env, vin).catch(() => null);
  tools.push("get_tracking_summary");

  if (want(/batter|degrad|health|warrant|range loss|capacity/)) {
    data.battery_forecast = await getBatteryForecast(env, vin).catch(() => null);
    tools.push("get_battery_forecast");
  }
  if (want(/driver|who|safe|risk|scor|behav|braking|harsh/)) {
    data.driver_scores = await getDriverScores(env, vin).catch(() => null);
    tools.push("get_driver_scores");
  }
  if (want(/charg|cost|kwh|money|spend|tariff|₪|shekel|price|month/)) {
    data.monthly = await getMonthlyReport(env, vin, 6).catch(() => null);
    tools.push("get_monthly_report");
  }
  if (want(/charg|session|superchar/)) {
    data.recent_charges = await getChargeSessions(env, vin, 5).catch(() => null);
    tools.push("get_charge_sessions");
  }
  if (want(/efficien|wh\/km|consumption|cold|temperature|weather|winter|summer/)) {
    data.efficiency_by_temp = await getEfficiencyByTemp(env, vin).catch(() => null);
    tools.push("get_efficiency_by_temp");
  }
  if (want(/tire|tyre|pressure|psi|bar|leak/)) {
    data.tires = await getTirePressures(env, vin, 30).catch(() => null);
    tools.push("get_tire_pressures");
  }
  if (want(/vampire|phantom|drain|parked|sentry|overnight|sleep/)) {
    data.vampire = await getVampireDrain(env, vin, 30).catch(() => null);
    tools.push("get_vampire_drain");
  }
  // If nothing matched beyond summary, add the monthly report as a safe default.
  if (tools.length === 1) {
    data.monthly = await getMonthlyReport(env, vin, 6).catch(() => null);
    tools.push("get_monthly_report");
  }
  return { tools, data };
}

export interface AskResult {
  answer: string;
  tools_used: string[];
  data: Record<string, unknown> | null;
  note?: string;
}

export async function askTessa(env: Env, question: string, vin: string): Promise<AskResult> {
  const q = (question || "").trim().slice(0, 500);
  if (!q) return { answer: "Ask me anything about your car — efficiency, battery health, charging cost, who drives safest…", tools_used: [], data: null };

  const { tools, data } = await assembleContext(env, vin, q);
  const system =
    "You are Tessa, a concise assistant for a personal Tesla telemetry app. Answer the user's question using ONLY the JSON data provided (it is this specific car's real logged data). Be direct and specific with numbers and units (km, kWh, Wh/km, %, ₪). If the data doesn't contain the answer, say so briefly. 1-4 sentences, no preamble, no markdown headers.";
  const user = `Question: ${q}\n\nCar data (JSON):\n${JSON.stringify(data)}`;

  const answer = await runModel(env, system, user);
  if (answer) return { answer, tools_used: tools, data };

  // Fallback: no AI binding or model error — return a structured summary.
  return {
    answer: "The AI answer layer isn't available right now, but here's the raw data for your question.",
    tools_used: tools,
    data,
    note: `Workers AI unavailable — showing structured data instead. (${lastAiError || "unknown"})`,
  };
}

/**
 * One-sentence proactive briefing from the month's derivations, for the
 * ai_brief automation rule. Returns null when there's nothing worth saying
 * (so the rule stays quiet) or when the model is unavailable.
 */
export async function generateBrief(env: Env, vin: string): Promise<string | null> {
  const [summary, monthly, vampire, tires, budget] = await Promise.all([
    getTrackingSummary(env, vin).catch(() => null),
    getMonthlyReport(env, vin, 2).catch(() => null),
    getVampireDrain(env, vin, 14).catch(() => null),
    getTirePressures(env, vin, 21).catch(() => null),
    getBudgetStatus(env).catch(() => null),
  ]);
  const digest = { summary, monthly, vampire, tires, api_budget: budget };
  const system =
    "You are Tessa. Write ONE short, useful sentence briefing the owner about their Tesla this period — highlight the single most noteworthy thing (an efficiency shift, a cost, a health/tire trend, a drain anomaly). If nothing is noteworthy, reply exactly with the word SKIP. No preamble.";
  const line = await runModel(env, system, `Data (JSON):\n${JSON.stringify(digest)}`);
  if (!line || /^skip$/i.test(line.trim())) return null;
  return line;
}

/** ~3-sentence coaching note for a single just-closed drive (or null). */
export async function generateCoachNote(env: Env, drive: Record<string, unknown>): Promise<string | null> {
  // Only worth coaching drives with real behaviour signal.
  if (drive.behavior_score == null || (Number(drive.distance_km) || 0) < 1) return null;
  const facts = {
    distance_km: drive.distance_km, duration_min: drive.duration_min,
    behavior_score: drive.behavior_score, avg_speed: drive.avg_speed, max_speed: drive.max_speed,
    harsh_brake_count: drive.harsh_brake_count, harsh_accel_count: drive.harsh_accel_count,
    harsh_turn_count: drive.harsh_turn_count, max_decel_ms2: drive.max_decel_ms2,
    over_limit_severity: drive.over_limit_severity, night_frac: drive.night_frac,
    efficiency_wh_km: drive.efficiency_wh_km,
  };
  const system =
    "You are a supportive driving coach. In 2-3 short sentences, give specific, encouraging feedback on THIS drive using the metrics. Mention what went well and one concrete thing to improve if warranted. No preamble, no markdown.";
  return runModel(env, system, `Drive metrics (JSON):\n${JSON.stringify(facts)}`);
}
