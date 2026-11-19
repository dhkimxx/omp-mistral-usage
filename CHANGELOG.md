# Changelog

## 0.2.0

- Show the plan and budgets in the status bar while a Mistral model is active, for example `Mistral Pro · Vibe 40% · resets 11d`. omp's own `usage` status segment drops Mistral's monthly windows, so the plugin sets a status entry of its own. It needs no configuration, makes no request without a UI, and queries the billing API at most every five minutes.
- Fix the API budget's pay-as-you-go state. It now follows the subscription's `payg_enabled`; the budget's own flag is documented as meaningful only for Vibe and is false by default for the API budget, which marked pay-as-you-go API overage as exhausted.
- Leave zero-allowance budgets out of the status bar and name the plan the way Mistral's pricing page does (`INDIVIDUAL` is Pro, `EDU` is Education).
- Cover Free, Pro, Team and unknown plan names with spec-shaped tests. Only the Education plan has been verified live.
- Develop against omp 19.0.0 types.

## 0.1.0

- Report the Mistral Vibe Code and API monthly budgets in `omp usage`: amount, percentage, reset time, pay-as-you-go state, and the plan name in the account header.
- Authenticate with the key omp already stores, including the one minted by `omp login mistral` browser sign-in. Requests use a bearer key, never leave `api.mistral.ai`, and refuse redirects.
- Keep usage past the allowance at `warning` when pay-as-you-go is enabled, and `exhausted` otherwise.
- Strip control characters from API text before display.
- `MISTRAL_USAGE_POOLS=vibe|api` limits the report to the budget a key draws from, so an unrelated drained budget cannot mark the key depleted under `retry.usageAwareFallback`.
