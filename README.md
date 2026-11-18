# omp-mistral-usage

Mistral usage for [omp](https://github.com/can1357/oh-my-pi): your monthly **Vibe Code** and **API** budgets in `omp usage` and `/usage`, with the plan, reset time and pay-as-you-go state.

```
Mistral — 1 account
  ● account 1 · plan: EDU
      ● Vibe monthly budget  ██████░░░░░░░░░░░░░░░░░░░░░░  $34.32 / $150.00 · 22.9% used · resets in 12d19h
        Monthly budget: 150 USD · Pay-as-you-go overage: disabled
      ● API monthly budget   ░░░░░░░░░░░░░░░░░░░░░░░░░░░░  $0.00 / $15.00 · 0.0% used · resets in 12d19h
        Monthly budget: 15 USD · Pay-as-you-go overage: disabled
```

## Install

```sh
omp plugin install github:dhkimxx/omp-mistral-usage
omp login mistral
omp usage --provider mistral
```

`omp login mistral` opens a browser sign-in with your Mistral account, so there is no API key to create or paste. The plugin reads whichever key omp already holds, including a `MISTRAL_API_KEY` console key, and stores nothing itself. Only the sign-in key has been tested against the live API.

Update with `omp plugin upgrade omp-mistral-usage`, remove with `omp plugin uninstall omp-mistral-usage`.

## What it reports

| Budget | Drawn on by |
| --- | --- |
| `Vibe monthly budget` | keys minted by `omp login mistral`: the Vibe Code allowance of your plan, per upstream's description of the login |
| `API monthly budget` | console API keys (`MISTRAL_API_KEY`), per Mistral's plan model; not tested here |

- USD budgets show dollars. Any other currency shows a percentage with the currency named in a note.
- Status is `ok` below 80%, `warning` from 80%, and `exhausted` at or past the budget. With pay-as-you-go enabled, usage past the allowance stays `warning` because it is billed rather than stopped.
- A budget of zero is shown as unknown, not as 0% used.
- The plan name (for example `EDU`) appears next to the account. Text from the API is stripped of control characters and capped before it reaches the terminal.

## How it works

It calls `GET /v1/billing/budget` and `GET /v1/billing/subscription` on `https://api.mistral.ai` with `Authorization: Bearer <key>`, the same public billing routes the Mistral Vibe CLI reads. The key is sent only to that origin: redirects are refused, and a custom base URL or API endpoint disables the request.

- Reading the budget needs the `see_org_inference_usage` permission. A `401` or `403` is reported as an authentication error rather than as zero usage.
- The subscription call is optional. If it fails you lose the plan name and the subscription's pay-as-you-go flag, not the budgets.

## Known limitation: a key bills one budget, but omp cannot be told which

Nothing in a stored credential says whether a key draws from the Vibe budget or the API budget, and a plugin cannot register the ranking strategy omp uses for its built-in providers. So both budgets are reported.

omp's usage-aware fallback (`retry.usageAwareFallback`) counts every reported limit. A drained budget your key does not use, such as the $15 API credit of an EDU plan while you sign in through Vibe, can therefore mark the key as depleted. Set `MISTRAL_USAGE_POOLS` to report only the budget your key draws from:

```sh
export MISTRAL_USAGE_POOLS=vibe   # keys from `omp login mistral`
export MISTRAL_USAGE_POOLS=api    # console API keys
```

Unset, empty, or unrecognised values report both.

## Relation to omp itself

Mistral usage is not built into omp yet. Pull requests that add it ([#19552](https://github.com/can1357/oh-my-pi/pull/19552), [#18993](https://github.com/can1357/oh-my-pi/pull/18993), [#18723](https://github.com/can1357/oh-my-pi/pull/18723), for [#18748](https://github.com/can1357/oh-my-pi/issues/18748)) are open. If one is merged, uninstall this plugin. Both register the same `mistral:vibe:monthly` and `mistral:api:monthly` limit ids.

## Compatibility

Tested with omp 18.22.0 against a live Mistral Vibe sign-in key on an EDU plan. The plugin uses `registerProvider` with a `usage` provider and `ProviderHttpError` from `@oh-my-pi/pi-ai/error`, both part of the extension API surface omp exposes.

## Development

```sh
npm ci --ignore-scripts
npm rebuild bun --ignore-scripts=false
npm run verify
```

`verify` runs the type check and the Bun tests. Tests never touch the network or a real key.

## License

[MIT](LICENSE)
