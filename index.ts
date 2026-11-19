import type { UsageFetchContext, UsageFetchParams, UsageLimit, UsageProvider, UsageReport } from "@oh-my-pi/pi-ai";
import { ProviderHttpError } from "@oh-my-pi/pi-ai/error";
import { clearInterval, setInterval } from "node:timers";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

const ORIGIN = "https://api.mistral.ai";
const PROVIDER = "mistral";
/** Vibe first: `omp login mistral` mints a key that bills against the Vibe Code budget. */
const POOLS = ["vibe", "api"] as const;
type Pool = (typeof POOLS)[number];
type RecordValue = Record<string, unknown>;

function isRecord(value: unknown): value is RecordValue {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Control characters and lone surrogates would let API text reach the terminal as escape sequences. */
function plainText(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.replace(/[\p{Cc}\p{Cs}\u2028\u2029]+/gu, " ").replace(/\s+/g, " ").trim();
  return text ? Array.from(text).slice(0, max).join("") : undefined;
}

function canonical(value: string | undefined): boolean {
  if (value === undefined || value.trim() === "") return true;
  try {
    const url = new URL(value);
    return url.origin === ORIGIN && !url.username && !url.password;
  } catch {
    return false;
  }
}

/**
 * A key bills against one budget, but nothing in the credential says which. Both are reported by
 * default; `MISTRAL_USAGE_POOLS=vibe` (or `api`) keeps only the budget the key draws from, so an
 * unrelated drained budget cannot make omp treat the key as depleted.
 */
function selectedPools(): readonly Pool[] {
  const requested = (process.env.MISTRAL_USAGE_POOLS ?? "").split(",").map(name => name.trim().toLowerCase());
  const chosen = POOLS.filter(name => requested.includes(name));
  return chosen.length ? chosen : POOLS;
}

async function getJson(path: string, key: string, params: UsageFetchParams, ctx: UsageFetchContext, required: boolean): Promise<RecordValue | null> {
  try {
    // The Vibe CLI and inference both use the bearer form; the billing routes also accept x-api-key.
    const response = await ctx.fetch(`${ORIGIN}${path}`, {
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
      redirect: "error",
      ...(params.signal ? { signal: params.signal } : {}),
    });
    if (!response.ok) {
      if (required && (response.status === 401 || response.status === 403)) {
        throw new ProviderHttpError(response.status === 403
          ? "Mistral billing budget access forbidden; see_org_inference_usage permission may be required"
          : "Mistral billing budget authentication failed", response.status);
      }
      ctx.logger?.warn("Mistral billing request failed", { endpoint: path, status: response.status });
      return null;
    }
    const body: unknown = await response.json();
    return isRecord(body) ? body : null;
  } catch (error) {
    if (error instanceof ProviderHttpError) throw error;
    ctx.logger?.warn("Mistral billing request failed", { endpoint: path, error: error instanceof Error ? error.name : "UnknownError" });
    return null;
  }
}

function resetTimestamp(value: unknown): number | undefined {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/i.test(value)) return undefined;
  const time = Date.parse(value);
  return Number.isFinite(time) && time > 0 ? time : undefined;
}

/**
 * Pay-as-you-go flag of one budget. The API documents the budget's own `payg_enabled` as meaningful
 * only for Vibe (it defaults to false for the API budget), so the API budget follows the subscription.
 */
function payAsYouGo(name: Pool, data: RecordValue, subscription: RecordValue | null): boolean | undefined {
  if (name === "vibe" && typeof data.payg_enabled === "boolean") return data.payg_enabled;
  const flag = name === "vibe" ? subscription?.vibe_payg_enabled : subscription?.payg_enabled;
  return typeof flag === "boolean" ? flag : undefined;
}

function pool(name: Pool, value: unknown, accountId: string | undefined, subscription: RecordValue | null): UsageLimit | null {
  if (!isRecord(value)) return null;
  const data = value;
  const percentage = data.usage_percentage;
  const budget = data.initial_budget;
  if (typeof percentage !== "number" || !Number.isFinite(percentage) || percentage < 0 ||
      typeof budget !== "number" || !Number.isFinite(budget) || budget < 0) return null;
  const currency = typeof data.currency === "string" && /^[A-Za-z]{3}$/.test(data.currency) ? data.currency.toUpperCase() : undefined;
  const notes: string[] = [];
  if (currency) notes.push(`Monthly budget: ${budget} ${currency}`);
  else notes.push(`Monthly budget: ${budget} (currency unavailable)`);
  const payg = payAsYouGo(name, data, subscription);
  if (typeof payg === "boolean") notes.push(`Pay-as-you-go overage: ${payg ? "enabled" : "disabled"}`);
  const resetsAt = resetTimestamp(data.reset_at);
  const fraction = percentage / 100;
  if (budget === 0) notes.push("Zero budget; percentage is not a usable allowance.");
  // With pay-as-you-go, usage past the allowance is billed rather than stopped.
  const overage = payg === true ? "warning" : "exhausted";
  return {
    id: `mistral:${name}:monthly`,
    label: name === "api" ? "API monthly budget" : "Vibe monthly budget",
    scope: { provider: PROVIDER, ...(accountId ? { accountId } : {}), windowId: "monthly" },
    window: { id: "monthly", label: "Monthly", ...(resetsAt !== undefined ? { resetsAt } : {}) },
    amount: budget === 0 ? { unit: "unknown" } : currency === "USD" && Number.isFinite(budget * fraction) ? {
      unit: "usd", used: budget * fraction, limit: budget, remaining: Math.max(0, budget - budget * fraction),
      usedFraction: fraction, remainingFraction: Math.max(0, 1 - fraction),
    } : {
      unit: "percent", used: percentage, limit: 100, remaining: Math.max(0, 100 - percentage),
      usedFraction: fraction, remainingFraction: Math.max(0, 1 - fraction),
    },
    status: budget === 0 ? "unknown" : percentage >= 100 ? overage : percentage >= 80 ? "warning" : "ok",
    notes,
  };
}

async function fetchUsage(params: UsageFetchParams, ctx: UsageFetchContext): Promise<UsageReport | null> {
  if (params.provider !== PROVIDER || params.credential.type !== "api_key" || !params.credential.apiKey?.trim()) return null;
  if (!canonical(params.baseUrl) || !canonical(params.credential.apiEndpoint)) {
    ctx.logger?.warn("Mistral billing skipped for noncanonical API origin");
    return null;
  }
  const key = params.credential.apiKey;
  const budget = await getJson("/v1/billing/budget", key, params, ctx, true);
  if (!budget) return null;
  const subscription = await getJson("/v1/billing/subscription", key, params, ctx, false);
  const limits = selectedPools().map(name => pool(name, budget[`${name}_budget`], params.credential.accountId, subscription)).filter((limit): limit is UsageLimit => limit !== null);
  if (!limits.length) return null;
  const planType = plainText(subscription?.plan_name, 40);
  return {
    provider: PROVIDER,
    fetchedAt: Date.now(),
    limits,
    ...(subscription?.enterprise === true ? { notes: ["Enterprise subscription"] } : {}),
    ...(planType ? { metadata: { planType } } : {}),
  };
}

export const usageProvider: UsageProvider = {
  id: PROVIDER,
  cacheVersion: 2026111901,
  supports: params => params.provider === PROVIDER && params.credential.type === "api_key" && !!params.credential.apiKey?.trim(),
  fetchUsage,
};

/** Plan names the billing API documents, in the words Mistral's pricing page uses. */
const PLAN_NAMES: Record<string, string> = { FREE: "Free", INDIVIDUAL: "Pro", EDU: "Education", TEAM: "Team" };
const POOL_LABELS: Record<Pool, string> = { vibe: "Vibe", api: "API" };

/** `11d`, `2d5h`, `2h30m`, `40m`: two units at most, like omp's own reset countdowns. */
function compactDuration(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const rest = minutes % 60;
  if (days) return hours ? `${days}d${hours}h` : `${days}d`;
  if (hours) return rest ? `${hours}h${rest}m` : `${hours}h`;
  return `${rest}m`;
}

/**
 * One status-bar line: the plan, every budget that has an allowance, and the nearest reset.
 * Zero-allowance budgets (a plan without that kind of usage) are left out rather than shown as 0%.
 */
export function statusText(report: UsageReport, now: number): string | undefined {
  const parts: string[] = [];
  let reset: number | undefined;
  for (const name of POOLS) {
    const limit = report.limits.find(candidate => candidate.id === `mistral:${name}:monthly`);
    const fraction = limit?.amount.usedFraction;
    if (!limit || limit.amount.unit === "unknown" || fraction === undefined) continue;
    parts.push(`${POOL_LABELS[name]} ${Math.round(fraction * 100)}%`);
    const at = limit.window?.resetsAt;
    if (at !== undefined && at > now && (reset === undefined || at < reset)) reset = at;
  }
  if (!parts.length) return undefined;
  const plan = report.metadata?.planType;
  const head = typeof plan === "string" && plan ? `Mistral ${PLAN_NAMES[plan.toUpperCase()] ?? plan}` : "Mistral";
  return [head, ...parts, ...(reset === undefined ? [] : [`resets ${compactDuration(reset - now)}`])].join(" · ");
}

const STATUS_KEY = "mistral-usage";
const REFRESH_MS = 5 * 60_000;
const FAILURE_RETRY_MS = 60_000;
const REQUEST_TIMEOUT_MS = 10_000;
const TICK_MS = 60_000;

export default function mistralUsage(pi: ExtensionAPI): void {
  pi.registerProvider(PROVIDER, { usage: usageProvider });

  // omp's own `usage` status-line segment drops monthly windows from providers it does not know,
  // so Mistral gets a status entry of its own. Hook statuses render without any configuration.
  let latest: ExtensionContext | undefined;
  let text: string | undefined;
  let nextFetchAt = 0;
  let inFlight = false;
  let timer: NodeJS.Timeout | undefined;

  const publish = (ctx: ExtensionContext): void => {
    ctx.ui.setStatus(STATUS_KEY, ctx.model?.provider === PROVIDER ? text : undefined);
  };

  async function refresh(ctx: ExtensionContext): Promise<void> {
    if (!ctx.hasUI) return;
    latest = ctx;
    if (!timer) {
      timer = setInterval(() => { if (latest) void refresh(latest); }, TICK_MS);
      timer.unref();
    }
    publish(ctx);
    const model = ctx.model;
    if (model?.provider !== PROVIDER || inFlight || Date.now() < nextFetchAt) return;
    inFlight = true;
    try {
      const apiKey = (await ctx.modelRegistry.getApiKeyForProvider(PROVIDER))?.trim();
      const report = apiKey
        ? await usageProvider.fetchUsage(
            { provider: PROVIDER, credential: { type: "api_key", apiKey }, baseUrl: model.baseUrl, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
            { fetch: globalThis.fetch.bind(globalThis) },
          )
        : null;
      text = report ? statusText(report, Date.now()) : undefined;
    } catch {
      text = undefined;
    } finally {
      inFlight = false;
      nextFetchAt = Date.now() + (text ? REFRESH_MS : FAILURE_RETRY_MS);
    }
    publish(ctx);
  }

  const onActivity = (_event: unknown, ctx: ExtensionContext): void => { void refresh(ctx); };
  pi.on("session_start", onActivity);
  pi.on("session_switch", onActivity);
  pi.on("agent_start", onActivity);
  pi.on("turn_end", onActivity);
  pi.on("agent_end", onActivity);
  pi.on("session_shutdown", (_event, ctx) => {
    clearInterval(timer);
    timer = undefined;
    latest = undefined;
    text = undefined;
    nextFetchAt = 0;
    if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
  });
}
