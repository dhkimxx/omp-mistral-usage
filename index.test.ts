import test from "node:test";
import assert from "node:assert/strict";
import type { UsageFetchContext, UsageFetchParams } from "@oh-my-pi/pi-ai";
import { ProviderHttpError } from "@oh-my-pi/pi-ai/error";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import mistralUsage, { statusText, usageProvider } from "./index.js";

const detail = (usage_percentage: number, initial_budget = 100, currency: unknown = "USD", payg_enabled: unknown = false) => ({
  usage_percentage, initial_budget, currency, reset_at: "2026-12-01T00:00:00Z", payg_enabled,
});

function harness(budget: unknown, subscription: unknown = {}, options: { budgetStatus?: number; subscriptionStatus?: number; baseUrl?: string; apiEndpoint?: string } = {}) {
  const calls: { url: string; init: RequestInit }[] = [];
  const params: UsageFetchParams = {
    provider: "mistral", credential: { type: "api_key", apiKey: "test-key", accountId: "account", ...(options.apiEndpoint ? { apiEndpoint: options.apiEndpoint } : {}) },
    ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
  };
  const ctx = {
    fetch: async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      const isBudget = url.endsWith("/budget");
      const status = isBudget ? options.budgetStatus ?? 200 : options.subscriptionStatus ?? 200;
      return new Response(JSON.stringify(isBudget ? budget : subscription), { status, headers: { "content-type": "application/json" } });
    },
  } as unknown as UsageFetchContext;
  return { calls, params, ctx, fetch: () => usageProvider.fetchUsage(params, ctx) };
}

async function withPools<T>(value: string | undefined, run: () => Promise<T>): Promise<T> {
  const previous = process.env.MISTRAL_USAGE_POOLS;
  if (value === undefined) delete process.env.MISTRAL_USAGE_POOLS;
  else process.env.MISTRAL_USAGE_POOLS = value;
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env.MISTRAL_USAGE_POOLS;
    else process.env.MISTRAL_USAGE_POOLS = previous;
  }
}

test("Vibe and API budgets are reported separately, Vibe first, with reset, plan and bearer auth", async () => {
  const h = harness({ api_budget: detail(0, 15, "USD"), vibe_budget: detail(60, 30, "EUR") },
    { plan_name: "EDU", payg_enabled: false, vibe_payg_enabled: false });
  const report = await h.fetch();
  assert.ok(report);
  assert.deepEqual(report.limits.map(limit => limit.id), ["mistral:vibe:monthly", "mistral:api:monthly"]);
  const [vibe, api] = report.limits;
  assert.deepEqual(vibe.amount, { unit: "percent", used: 60, limit: 100, remaining: 40, usedFraction: 0.6, remainingFraction: 0.4 });
  assert.deepEqual(api.amount, { unit: "usd", used: 0, limit: 15, remaining: 15, usedFraction: 0, remainingFraction: 1 });
  assert.equal(vibe.window?.resetsAt, Date.parse("2026-12-01T00:00:00Z"));
  assert.equal(api.scope.accountId, "account");
  assert.equal(report.metadata?.planType, "EDU");
  assert.equal(h.calls[0].url, "https://api.mistral.ai/v1/billing/budget");
  const headers = h.calls[0].init.headers as Record<string, string>;
  assert.equal(headers.Authorization, "Bearer test-key");
  assert.equal(headers["x-api-key"], undefined);
  assert.equal(h.calls[0].init.redirect, "error");
});

test("status is ok below 80%, warning from 80%, and exhausted at or past the budget", async () => {
  for (const [used, remaining, status] of [[0, 100, "ok"], [79, 21, "ok"], [80, 20, "warning"], [100, 0, "exhausted"], [125, 0, "exhausted"]] as const) {
    const report = await harness({ vibe_budget: detail(used) }).fetch();
    assert.equal(report?.limits[0].amount.used, used);
    assert.equal(report?.limits[0].amount.remaining, remaining);
    assert.equal(report?.limits[0].status, status);
  }
});

test("pay-as-you-go keeps usage past the allowance at warning because it is billed rather than stopped", async () => {
  const own = await harness({ vibe_budget: detail(125, 100, "USD", true), api_budget: detail(125, 100, "USD", false) }).fetch();
  assert.equal(own?.limits[0].status, "warning");
  assert.equal(own?.limits[0].amount.usedFraction, 1.25);
  assert.equal(own?.limits[1].status, "exhausted");
  const subscription = await harness({ vibe_budget: { ...detail(110), payg_enabled: undefined }, api_budget: { ...detail(110), payg_enabled: undefined } },
    { vibe_payg_enabled: true, payg_enabled: false }).fetch();
  assert.equal(subscription?.limits[0].status, "warning");
  assert.equal(subscription?.limits[1].status, "exhausted");
  assert.ok(subscription?.limits[0].notes?.includes("Pay-as-you-go overage: enabled"));
  assert.ok(subscription?.limits[1].notes?.includes("Pay-as-you-go overage: disabled"));
});

test("null, absent, malformed and zero-budget sibling do not hide valid pool", async () => {
  for (const sibling of [undefined, null, {}, { ...detail(10), usage_percentage: "10" }, { ...detail(10), initial_budget: -1 }]) {
    const report = await harness({ api_budget: detail(20), vibe_budget: sibling }).fetch();
    assert.equal(report?.limits.length, 1);
    assert.equal(report?.limits[0].id, "mistral:api:monthly");
  }
  const report = await harness({ api_budget: detail(0, 0), vibe_budget: detail(20) }).fetch();
  assert.equal(report?.limits.length, 2);
  assert.equal(report?.limits[0].amount.used, 20);
  assert.equal(report?.limits[1].status, "unknown");
  assert.deepEqual(report?.limits[1].amount, { unit: "unknown" });
  assert.equal(await harness({ api_budget: null, vibe_budget: {} }).fetch(), null);
});

test("unknown currency is not mislabeled USD and timestamps require a timezone", async () => {
  const report = await harness({ vibe_budget: { ...detail(5, 20, "eur"), reset_at: "invalid" }, api_budget: { ...detail(12, 50, null), reset_at: "2026-12-01" } }).fetch();
  assert.equal(report?.limits[0].amount.unit, "percent");
  assert.equal(report?.limits[1].amount.unit, "percent");
  assert.equal(report?.limits[0].window?.resetsAt, undefined);
  assert.equal(report?.limits[1].window?.resetsAt, undefined);
  const offset = await harness({ vibe_budget: { ...detail(1), reset_at: "2026-12-01T02:00:00+02:00" } }).fetch();
  assert.equal(offset?.limits[0].window?.resetsAt, Date.parse("2026-12-01T00:00:00Z"));
});

test("primary authentication and permission failures are definitive without false quota", async () => {
  for (const status of [401, 403]) {
    const h = harness({}, {}, { budgetStatus: status });
    await assert.rejects(h.fetch(), (error: unknown) => error instanceof ProviderHttpError && error.status === status);
    assert.equal(h.calls.length, 1);
  }
});

test("optional subscription failure leaves budget intact and omits the plan", async () => {
  for (const status of [401, 403, 500]) {
    const report = await harness({ vibe_budget: detail(42) }, {}, { subscriptionStatus: status }).fetch();
    assert.equal(report?.limits[0].amount.used, 42);
    assert.equal(report?.metadata, undefined);
  }
});

test("plan names from the API cannot inject terminal escapes or grow without bound", async () => {
  const hostile = "\u001b]8;;https://evil.example\u0007TEAM\u001b]8;;\u0007\n\u009b31m\ud800";
  const report = await harness({ vibe_budget: detail(1) }, { plan_name: hostile }).fetch();
  const plan = String(report?.metadata?.planType);
  assert.doesNotMatch(plan, /[\u0000-\u001f\u007f-\u009f\ud800-\udfff]/);
  assert.match(plan, /TEAM/);
  const long = await harness({ vibe_budget: detail(1) }, { plan_name: "x".repeat(500) }).fetch();
  assert.equal(String(long?.metadata?.planType).length, 40);
  assert.equal((await harness({ vibe_budget: detail(1) }, { plan_name: " \n\t " }).fetch())?.metadata, undefined);
  assert.deepEqual((await harness({ vibe_budget: detail(1) }, { enterprise: true }).fetch())?.notes, ["Enterprise subscription"]);
});

test("MISTRAL_USAGE_POOLS keeps only the budget the key bills against", async () => {
  const budget = { api_budget: detail(100), vibe_budget: detail(10) };
  const ids = async (value: string | undefined) => withPools(value, async () => (await harness(budget).fetch())?.limits.map(limit => limit.id));
  assert.deepEqual(await ids("vibe"), ["mistral:vibe:monthly"]);
  assert.deepEqual(await ids(" API "), ["mistral:api:monthly"]);
  assert.deepEqual(await ids("api,vibe"), ["mistral:vibe:monthly", "mistral:api:monthly"]);
  for (const ignored of [undefined, "", "all", "bogus"]) assert.deepEqual(await ids(ignored), ["mistral:vibe:monthly", "mistral:api:monthly"]);
  assert.equal(await withPools("vibe", async () => harness({ api_budget: detail(1) }).fetch()), null);
});

test("credentials never leave canonical origin and unsupported credentials are ignored", async () => {
  for (const options of [{ baseUrl: "https://api.mistral.ai.evil.test/v1" }, { baseUrl: "http://api.mistral.ai" }, { baseUrl: "not a url" }, { apiEndpoint: "https://proxy.example/v1" }, { baseUrl: "https://user@api.mistral.ai/v1" }]) {
    const h = harness({}, {}, options);
    assert.equal(await h.fetch(), null);
    assert.equal(h.calls.length, 0);
  }
  const h = harness({ api_budget: detail(1) }, {}, { baseUrl: "https://api.mistral.ai/v1" });
  assert.ok(await h.fetch());
  h.params.credential = { type: "oauth", accessToken: "test" };
  assert.equal(await h.fetch(), null);
});

test("the API budget follows the subscription's pay-as-you-go flag, not its own default false", async () => {
  const budget = { vibe_budget: detail(125, 100, "USD", false), api_budget: detail(125, 100, "USD", false) };
  const report = await harness(budget, { payg_enabled: true, vibe_payg_enabled: false }).fetch();
  assert.equal(report?.limits[0].status, "exhausted");
  assert.equal(report?.limits[1].status, "warning");
  assert.ok(report?.limits[1].notes?.includes("Pay-as-you-go overage: enabled"));
});

const NOW = Date.parse("2026-11-20T00:00:00Z");

// The OpenAPI spec lists FREE, INDIVIDUAL, EDU and TEAM and requires both budgets, whose
// initial_budget is 0 when a plan has no allowance of that kind. EDU and INDIVIDUAL were checked live.
const planCases = [
  { plan: "EDU", budgets: { vibe_budget: detail(22.9, 150), api_budget: detail(0, 15) }, expected: "Mistral Education · Vibe 23% · API 0% · resets 11d" },
  { plan: "INDIVIDUAL", budgets: { vibe_budget: detail(0.0319, 300), api_budget: detail(0, 30) }, expected: "Mistral Pro · Vibe 0% · API 0% · resets 11d" },
  { plan: "TEAM", budgets: { vibe_budget: detail(0, 0), api_budget: detail(55.5, 300) }, expected: "Mistral Team · API 56% · resets 11d" },
  { plan: "FREE", budgets: { vibe_budget: detail(0, 0), api_budget: detail(0, 0) }, expected: undefined },
  { plan: "SOMETHING_NEW", budgets: { vibe_budget: detail(10, 100), api_budget: detail(0, 0) }, expected: "Mistral SOMETHING_NEW · Vibe 10% · resets 11d" },
];
for (const { plan, budgets, expected } of planCases) {
  test(`${plan} plan: status text shows only budgets with an allowance`, async () => {
    const report = await harness(budgets, { plan_name: plan }).fetch();
    assert.ok(report || expected === undefined);
    assert.equal(report && statusText(report, NOW), expected);
  });
}

test("a plan whose budgets are all zero still reports a plan but no usage figure", async () => {
  const report = await harness({ vibe_budget: detail(0, 0), api_budget: detail(0, 0) }, { plan_name: "FREE" }).fetch();
  assert.equal(report?.metadata?.planType, "FREE");
  assert.deepEqual(report?.limits.map(limit => limit.status), ["unknown", "unknown"]);
});

test("status text counts over-budget use, omits the reset once it has passed, and formats short resets", async () => {
  const report = await harness({ vibe_budget: { ...detail(125, 100), reset_at: "2026-11-20T02:30:00Z" } }, { plan_name: "EDU", vibe_payg_enabled: true }).fetch();
  assert.equal(statusText(report!, NOW), "Mistral Education · Vibe 125% · resets 2h30m");
  assert.equal(statusText(report!, Date.parse("2026-11-18T20:30:00Z")), "Mistral Education · Vibe 125% · resets 1d6h");
  assert.equal(statusText(report!, Date.parse("2026-11-20T02:00:00Z")), "Mistral Education · Vibe 125% · resets 30m");
  assert.equal(statusText(report!, Date.parse("2026-11-21T00:00:00Z")), "Mistral Education · Vibe 125%");
  const noPlan = await harness({ vibe_budget: detail(5) }).fetch();
  assert.equal(statusText(noPlan!, Date.parse("2026-12-01T00:00:00Z")), "Mistral · Vibe 5%");
});

interface Wiring {
  statuses: (string | undefined)[];
  requests: { url: string; authorization: string | undefined }[];
  keyLookups: number;
  emit(event: string): void;
  setProvider(provider: string): void;
  last(): string | undefined;
  /** Resolves once setStatus has been called `total` times, the signal that a refresh has finished. */
  settled(total: number): Promise<void>;
}

async function wired(
  options: { hasUI?: boolean; apiKey?: string | undefined; baseUrl?: string; status?: number },
  run: (wiring: Wiring) => Promise<void>,
): Promise<void> {
  const handlers = new Map<string, (event: unknown, ctx: unknown) => void>();
  const pi = { registerProvider() {}, on(event: string, handler: (event: unknown, ctx: unknown) => void) { handlers.set(event, handler); } } as unknown as ExtensionAPI;
  const statuses: (string | undefined)[] = [];
  const requests: { url: string; authorization: string | undefined }[] = [];
  let waiting: { total: number; resolve: () => void } | undefined;
  let provider = "mistral";
  let keyLookups = 0;
  const ctx = {
    hasUI: options.hasUI ?? true,
    ui: {
      setStatus: (_key: string, text: string | undefined) => {
        statuses.push(text);
        if (waiting && statuses.length >= waiting.total) waiting.resolve();
      },
    },
    get model() { return { provider, baseUrl: options.baseUrl ?? "https://api.mistral.ai/v1" }; },
    modelRegistry: { getApiKeyForProvider: async () => { keyLookups++; return "apiKey" in options ? options.apiKey : "test-key"; } },
  };
  const future = new Date(Date.now() + 3 * 86_400_000 + 3_600_000).toISOString();
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    requests.push({ url, authorization: (init?.headers as Record<string, string> | undefined)?.Authorization });
    const body = url.endsWith("/budget")
      ? { vibe_budget: { ...detail(22.9, 150), reset_at: future }, api_budget: { ...detail(0, 15), reset_at: future } }
      : { plan_name: "EDU", payg_enabled: false, vibe_payg_enabled: false, enterprise: false };
    return new Response(JSON.stringify(body), { status: options.status ?? 200 });
  }) as typeof fetch;
  const previousPools = process.env.MISTRAL_USAGE_POOLS;
  delete process.env.MISTRAL_USAGE_POOLS;
  mistralUsage(pi);
  try {
    await run({
      statuses, requests,
      get keyLookups() { return keyLookups; },
      emit: event => handlers.get(event)?.({}, ctx),
      setProvider: next => { provider = next; },
      last: () => statuses.at(-1),
      settled: total => {
        if (statuses.length >= total) return Promise.resolve();
        const { promise, resolve } = Promise.withResolvers<void>();
        waiting = { total, resolve };
        return promise;
      },
    });
  } finally {
    handlers.get("session_shutdown")?.({}, ctx);
    globalThis.fetch = original;
    if (previousPools !== undefined) process.env.MISTRAL_USAGE_POOLS = previousPools;
  }
}

const STATUS_PATTERN = /^Mistral Education · Vibe 23% · API 0% · resets 3d\dh$/;

test("a status entry shows plan and budgets for an active Mistral model and refetches at most every five minutes", async () => {
  await wired({}, async w => {
    w.emit("session_start");
    await w.settled(2);
    assert.match(w.last() ?? "", STATUS_PATTERN);
    for (const event of ["agent_start", "turn_end", "turn_end", "agent_end"]) w.emit(event);
    assert.deepEqual(w.requests.map(request => request.url), ["https://api.mistral.ai/v1/billing/budget", "https://api.mistral.ai/v1/billing/subscription"]);
    assert.equal(w.requests[0].authorization, "Bearer test-key");
    assert.equal(w.keyLookups, 1);
    w.emit("session_shutdown");
    assert.equal(w.last(), undefined);
  });
});

test("the entry disappears for other providers and returns from cache without another request", async () => {
  await wired({}, async w => {
    w.emit("session_start");
    await w.settled(2);
    w.setProvider("anthropic");
    w.emit("agent_start");
    assert.equal(w.last(), undefined);
    w.setProvider("mistral");
    w.emit("agent_start");
    assert.match(w.last() ?? "", STATUS_PATTERN);
    assert.equal(w.requests.length, 2);
    assert.equal(w.keyLookups, 1);
  });
});

test("nothing is requested without a UI or for another provider", async () => {
  await wired({ hasUI: false }, async w => {
    w.emit("session_start");
    assert.deepEqual([w.statuses.length, w.keyLookups, w.requests.length], [0, 0, 0]);
  });
  await wired({}, async w => {
    w.setProvider("anthropic");
    w.emit("session_start");
    assert.deepEqual([w.statuses, w.keyLookups, w.requests.length], [[undefined], 0, 0]);
  });
});

test("no key or a custom base URL sends nothing and shows no entry", async () => {
  for (const options of [{ apiKey: undefined }, { baseUrl: "https://proxy.example/v1" }] as const) {
    await wired(options, async w => {
      w.emit("session_start");
      await w.settled(2);
      assert.equal(w.requests.length, 0);
      assert.ok(w.statuses.every(text => text === undefined));
    });
  }
});

test("a rejected key hides the entry instead of showing stale numbers", async () => {
  await wired({ status: 401 }, async w => {
    w.emit("session_start");
    await w.settled(2);
    assert.ok(w.statuses.every(text => text === undefined));
    assert.equal(w.requests.length, 1);
  });
});
