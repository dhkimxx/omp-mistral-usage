# Changelog

## 0.1.0

- Report the Mistral Vibe Code and API monthly budgets in `omp usage`: amount, percentage, reset time, pay-as-you-go state, and the plan name in the account header.
- Authenticate with the key omp already stores, including the one minted by `omp login mistral` browser sign-in. Requests use a bearer key, never leave `api.mistral.ai`, and refuse redirects.
- Keep usage past the allowance at `warning` when pay-as-you-go is enabled, and `exhausted` otherwise.
- Strip control characters from API text before display.
- `MISTRAL_USAGE_POOLS=vibe|api` limits the report to the budget a key draws from, so an unrelated drained budget cannot mark the key depleted under `retry.usageAwareFallback`.
