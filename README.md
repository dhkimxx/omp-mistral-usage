# omp-mistral-usage

Mistral usage for [omp](https://github.com/can1357/oh-my-pi): your monthly **Vibe Code** and **API** budgets in `omp usage` and `/usage`, plus a one-line entry in the status bar while a Mistral model is active. It shows the plan, reset time and pay-as-you-go state and does not depend on a particular plan, but only the Education plan has been verified live (see [Compatibility](#compatibility)).

```
Mistral — 1 account
  ● account 1 · plan: EDU
      ● Vibe monthly budget  ██████░░░░░░░░░░░░░░░░░░░░░░  $34.32 / $150.00 · 22.9% used · resets in 12d19h
        Monthly budget: 150 USD · Pay-as-you-go overage: disabled
      ● API monthly budget   ░░░░░░░░░░░░░░░░░░░░░░░░░░░░  $0.00 / $15.00 · 0.0% used · resets in 12d19h
        Monthly budget: 15 USD · Pay-as-you-go overage: disabled
```

Status bar, with a Mistral model selected and no configuration:

```
Mistral Education · Vibe 23% · API 0% · resets 11d17h
```

## Install

```sh
omp plugin install github:dhkimxx/omp-mistral-usage#v0.2.0
omp login mistral
omp usage --provider mistral
```

`omp login mistral` opens a browser sign-in with your Mistral account, so there is no API key to create or paste. The plugin reads whichever key omp already holds, including a `MISTRAL_API_KEY` console key, and stores nothing itself. Only the sign-in key has been tested against the live API.

Install a release tag, as above, rather than the bare `github:` spec.

## Update

1. Find the newest version on the [tags page](https://github.com/dhkimxx/omp-mistral-usage/tags), or list it from a shell:

   ```sh
   git ls-remote --tags --refs https://github.com/dhkimxx/omp-mistral-usage.git
   ```

2. Install that tag over the current one. `--force` replaces the installed copy. The plugin stores no credentials, so your Mistral login is untouched:

   ```sh
   omp plugin install github:dhkimxx/omp-mistral-usage#vX.Y.Z --force
   ```

3. Check the version, then restart any running omp session so it loads the new code:

   ```sh
   omp plugin list
   ```

Read [CHANGELOG.md](CHANGELOG.md) first if you want to know what changed.

Do not rely on `omp plugin upgrade` or an untagged `github:` install. On omp 19.0.0 both kept installing the first commit even after newer ones were pushed, while a tag (or a fresh Bun cache) resolved the newest.

## Uninstall

```sh
omp plugin uninstall omp-mistral-usage
```

## What it reports

| Budget | Drawn on by |
| --- | --- |
| `Vibe monthly budget` | keys minted by `omp login mistral`: the Vibe Code allowance of your plan, per upstream's description of the login |
| `API monthly budget` | console API keys (`MISTRAL_API_KEY`), per Mistral's plan model; not tested here |

- USD budgets show dollars. Any other currency shows a percentage with the currency named in a note.
- Status is `ok` below 80%, `warning` from 80%, and `exhausted` at or past the budget. With pay-as-you-go enabled, usage past the allowance stays `warning` because it is billed rather than stopped.
- A budget of zero means the plan has no allowance of that kind. It is shown as unknown in `omp usage`, not as 0% used, and left out of the status bar.
- The plan name appears next to the account as the API reports it (`FREE`, `INDIVIDUAL`, `EDU`, `TEAM`). The status bar uses the names from Mistral's pricing page: Free, Pro, Education, Team. Text from the API is stripped of control characters and capped before it reaches the terminal.
- Pay-as-you-go comes from the budget itself for Vibe and from the subscription for the API budget, because the API documents the budget's own flag as meaningful only for Vibe.

## Status bar

omp's built-in `usage` status-line segment only understands 5-hour, daily and weekly windows, plus monthly windows from a hard-coded list of providers (Cursor, OpenCode Go, Alibaba Token Plan). Mistral's monthly budgets are not on that list, so the segment stays empty. This plugin sets its own status entry instead, which omp renders without any setting (`statusLine.showHookStatus` is on by default).

- It appears only while the active model's provider is `mistral`, and only in the interactive UI. Without a UI (print mode, RPC) it makes no request.
- It refreshes on session start, each turn and agent run, and once a minute for model switches, but asks the billing API at most every five minutes, and every minute while it is failing. `omp usage` has its own cache and request.
- It is hidden when there is no key, the key is rejected, the API is unreachable, the model uses a custom base URL, or the plan has no allowance.
- With a custom status line that lists the `status` segment, omp renders extension status entries there instead of below the bar.

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

Tested with omp 19.0.0 and 18.22.0 types. Verified live against a Mistral Vibe sign-in key on an **EDU** plan only. The Free, Pro (`INDIVIDUAL`), Team and Enterprise handling follows Mistral's [OpenAPI spec](https://docs.mistral.ai/openapi.yaml) and is covered by tests that use spec-shaped payloads, not by a live account of those plans. If your plan reports something unexpected, open an issue with the output of `omp usage --provider mistral --json`, with account identifiers removed.

## Development

```sh
npm ci --ignore-scripts
npm rebuild bun --ignore-scripts=false
npm run verify
```

`verify` runs the type check and the Bun tests. Tests never touch the network or a real key.

## License

[MIT](LICENSE)
