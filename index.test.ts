import test from "node:test";
import assert from "node:assert/strict";
import type { UsageFetchContext, UsageFetchParams } from "@oh-my-pi/pi-ai";
import { ProviderHttpError } from "@oh-my-pi/pi-ai/error";
import { usageProvider } from "./index.js";

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
