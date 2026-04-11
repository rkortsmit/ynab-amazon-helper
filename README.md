# YNAB Amazon Helper

Local-first tooling for reconciling Amazon credit card purchases in YNAB with help from Codex or another AI assistant.

## What This Is

Amazon credit card charges in YNAB are often hard to categorize because the bank transaction usually only shows `Amazon` plus an amount. This project does the repetitive work locally on your machine:

- pulls pending YNAB transactions
- pulls recent Amazon order history from your local browser sessions
- learns from your past categorizations
- builds a structured analysis bundle for an AI assistant
- lets you apply only the decisions you explicitly trust

The scripts are the plumbing. The AI is the reasoning layer.

## Who This Is For

This is for anyone who:

- uses YNAB
- buys a lot of things from Amazon on one shared card
- wants a safer alternative to giving a third-party service their Amazon password
- wants an AI assistant to help categorize transactions faster without fully automating risky decisions

## Privacy And Safety

This project is designed to stay local-first:

- Amazon login stays manual in a headed browser.
- Amazon browser sessions are stored locally in `profiles/`.
- Scraped Amazon order data is stored locally in `data/`.
- YNAB access can be used in a read-only workflow until you decide to write changes.
- Nothing is auto-approved or auto-categorized in YNAB unless you run an explicit write command.

Important: if you use an external AI provider, only share the local files you are comfortable sharing. The safest setup is still a local workflow where the helper runs on your machine and the data stays on your machine.

## How It Works

1. You sync recent Amazon orders from one or more local browser profiles.
2. You pull your YNAB history and learn from past categorized Amazon transactions.
3. You generate a single AI-ready analysis file.
4. Codex or another AI assistant reviews the file, proposes safe categorizations, and asks you only about uncertain cases.
5. Confirmed decisions can be remembered for future runs.
6. You preview the exact YNAB changes before writing anything.
7. You write back only when you are ready.

## Setup

1. Clone this repo and `cd ynab-amazon-helper`
2. `cp .env.example .env`
3. Add your `YNAB_ACCESS_TOKEN`, `YNAB_PLAN_ID`, and `YNAB_ACCOUNT_NAME` to `.env`
4. `bun install`
5. `bunx playwright install chromium`

If you use two Amazon accounts on the same credit card, plan to keep two local browser profiles, for example `primary` and `secondary`.

## Recommended Workflow

### 1. Sync Amazon Orders

Primary account:

```bash
bun run start amazon sync --profile primary --pages 5
```

Second account:

```bash
bun run start amazon sync --profile secondary --pages 5
```

If Amazon asks for login, MFA, or a captcha, handle that manually in the opened browser window.

### 2. Learn From Past YNAB Decisions

```bash
bun run start learn --history-days 365
```

This builds reusable memory from previously categorized transactions in your YNAB history.

### 3. Generate The AI Analysis Bundle

```bash
bun run start analyze --days 90 --history-days 365
```

This creates the main file the AI should read:

- `data/analysis-latest.json`

### 4. Review With Codex Or Another AI

Ask the AI to:

- read `data/analysis-latest.json`
- use `data/category-memory.json` as prior memory
- auto-handle only high-confidence matches
- ask you only about `needs_review` and `no_match`
- avoid writing to YNAB until you explicitly confirm

### 5. Save Confirmed Decisions

Save a one-off decision into the current analysis bundle:

```bash
bun run start decide --transaction-id <transaction-id> --category "Groceries"
```

Remember a decision for future runs:

```bash
bun run start remember --transaction-id <transaction-id> --category "Groceries" --scope item
```

### 6. Preview YNAB Changes

```bash
bun run start apply
```

This is a dry run. Review it before writing anything.

### 7. Write Approved Changes Back To YNAB

```bash
bun run start apply --write
```

Only run this after you have reviewed the decisions and are comfortable with the result.

## Using This With Codex

A good Codex workflow is:

1. Run `analyze`
2. Tell Codex to process your Amazon YNAB bundle
3. Let Codex walk through the uncertain transactions with you
4. Let Codex save confirmed decisions with `decide` and `remember`
5. Let Codex show the dry-run `apply`
6. Only then allow `apply --write`

Example prompt:

```text
Please help reconcile my Amazon transactions in YNAB.
Read data/analysis-latest.json and data/category-memory.json.
Auto-handle only high-confidence items.
Ask me only about anything uncertain or unmatched.
Do not write to YNAB until I explicitly approve the final apply step.
```

## Using This With Another AI

This repo does not require Codex specifically.

Any AI assistant can help if it can read local files or if you provide the generated bundle. The most important files are:

- `data/analysis-latest.json`: current transactions, matches, suggestions, and review buckets
- `data/category-memory.json`: learned memory and reusable rules

If the AI cannot run local commands, you can still use this repo manually to generate the files and then give those files to the AI for review.

## AI Agent Notes

If you are an AI assistant reading this repository, use this order of operations:

1. Sync Amazon profiles when the user wants fresh order data.
2. Run `bun run start learn --history-days 365` unless the user wants a narrower pass.
3. Run `bun run start analyze --days 90 --history-days 365`.
4. Read `data/analysis-latest.json`.
5. Focus on `auto_apply`, `needs_review`, and `no_match`.
6. Ask the user only about uncertain or unmatched transactions.
7. Save confirmed one-off decisions with `decide`.
8. Save reusable memory with `remember` only when the user wants that pattern reused.
9. Show `bun run start apply` before any write.
10. Never run `bun run start apply --write` without explicit user confirmation.

## Command Reference

List YNAB plans:

```bash
bun run start ynab plans
```

List YNAB accounts:

```bash
bun run start ynab accounts
```

List YNAB categories:

```bash
bun run start ynab categories
```

Match transactions against cached orders:

```bash
bun run start match --days 90
```

JSON match output:

```bash
bun run start match --days 90 --json
```

Review transactions one at a time:

```bash
bun run start review --days 90
```

Review only unmatched transactions:

```bash
bun run start review --days 90 --only unmatched
```

Review only ambiguous transactions:

```bash
bun run start review --days 90 --only ambiguous
```

## Local Data Files

- `profiles/`: persistent Playwright browser profiles used for Amazon sessions
- `data/amazon-orders-*.json`: cached Amazon order history per profile
- `data/category-memory.json`: learned rules plus reusable manual memory
- `data/analysis-latest.json`: latest AI-ready review bundle

These files are ignored by git and are meant to stay local to your machine.

## License

This project is licensed under the MIT License. That means you can use, modify, publish, sublicense, or sell it, as long as the license notice is preserved.
