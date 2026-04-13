# YNAB Amazon Helper

Local-first tooling for reconciling Amazon purchases and broader YNAB budget transactions with help from Codex or another AI assistant.

## What This Is

Amazon credit card charges and refunds in YNAB are often hard to categorize because the bank transaction usually only shows `Amazon` plus an amount. Non-Amazon transactions are often easier, but still repetitive. This project does the repetitive work locally on your machine:

- pulls pending YNAB transactions
- pulls recent Amazon order history from your local browser sessions
- learns from your past categorizations
- learns recurring non-Amazon merchant patterns from payee, payee+memo, payee-by-account, and refund history
- builds a structured analysis bundle for an AI assistant
- lets you apply only the decisions you explicitly trust
- adds short YNAB memos for matched purchases when it can generate a useful description
- uses Amazon's payments transaction history to improve split-charge and refund matching
- keeps transfer/payment-looking transactions out of auto-apply so they can be reviewed manually

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

1. You sync recent Amazon orders from one or more local browser profiles when you want fresh Amazon data.
   The sync now reads both Your Orders and Your Payments > Transactions so split charges and refunds have a better source of truth.
2. You pull your YNAB history and learn from past categorized transactions.
   Amazon transactions learn from matched order/item history.
   Non-Amazon transactions learn from exact payee, payee+memo, same-account payee, and refund history.
3. You generate a single AI-ready analysis file for either an Amazon-only pass or a full-budget pass.
4. Codex or another AI assistant reviews the file, proposes safe categorizations for both charges and refunds, and asks you only about uncertain cases.
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

### Full Budget Reconcile

This is the best umbrella workflow when you want to say something like "let's update the budget" or "let's reconcile transactions."

If you want the freshest Amazon matches too, sync your Amazon profiles first:

```bash
bun run start amazon sync --profile primary --pages 5
bun run start amazon sync --profile secondary --pages 5
```

Then generate the budget-wide analysis bundle:

```bash
bun run start reconcile analyze --days 90 --history-days 365
```

This creates:

- `data/reconcile-latest.json`

The full-budget bundle:

- includes all unapproved transactions across the budget
- routes Amazon-like transactions through the Amazon matcher
- routes non-Amazon transactions through generic payee-history logic
- tries to auto-handle easy merchants and refund matches
- keeps transfer/payment-looking transactions in manual review

Preview the write:

```bash
bun run start reconcile apply
```

Write only when you are ready:

```bash
bun run start reconcile apply --write
```

### Amazon-Focused Reconcile

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
This sync reads both order history and the payments transaction list, which helps with split captures, Subscribe & Save style charges, and refund detection.
If older charges or refunds still show as unmatched, sync more history with a larger `--pages` value.

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
- auto-handle only high-confidence matches, including refunds when the original order/category is already known
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
When the helper can generate a short description and the existing YNAB memo is empty, the dry run also previews that memo.

### 7. Write Approved Changes Back To YNAB

```bash
bun run start apply --write
```

Only run this after you have reviewed the decisions and are comfortable with the result.

### 8. Backfill Memos For Already-Approved Amazon Transactions

Preview memo backfill:

```bash
bun run start memo backfill --days 45
```

Write memo backfill:

```bash
bun run start memo backfill --days 45 --write
```

This is useful when a transaction is already categorized and approved in YNAB, but you still want a short memo description added afterward. It works for both Amazon charges and Amazon refunds when a good match is available.

## Using This With Codex

A good Codex workflow is:

1. Run `reconcile analyze` when you want a budget-wide pass, or `analyze` when you want an Amazon-only pass
2. Tell Codex to process the latest bundle
3. Let Codex walk through only the uncertain transactions with you
4. Let Codex save confirmed decisions with `decide`, and Amazon-specific reusable memory with `remember` when appropriate
5. Let Codex show the dry-run `reconcile apply` or `apply`
6. Only then allow the write command

Example prompt:

```text
Please help update my YNAB budget.
Read data/reconcile-latest.json and data/category-memory.json.
Auto-handle only high-confidence transactions, including Amazon refunds and easy recurring merchants.
Ask me only about anything uncertain or unmatched.
Do not write to YNAB until I explicitly approve the final apply step.
```

### Repo-Contained Codex Skill

This repository includes a reusable Codex skill at:

- `.codex/skills/ynab-amazon-budget/`

Install it into your local Codex skills directory with:

```bash
bun run install:codex-skill
```

That copies the skill into `${CODEX_HOME:-~/.codex}/skills/ynab-amazon-budget` so future Codex chats can discover and use it directly.

## Using This With Another AI

This repo does not require Codex specifically.

Any AI assistant can help if it can read local files or if you provide the generated bundle. The most important files are:

- `data/analysis-latest.json`: current Amazon-focused transactions, matches, suggestions, and review buckets
- `data/reconcile-latest.json`: current full-budget reconcile bundle
- `data/category-memory.json`: learned memory and reusable rules

If the AI cannot run local commands, you can still use this repo manually to generate the files and then give those files to the AI for review.

## AI Agent Notes

If you are an AI assistant reading this repository, use this order of operations:

1. If the user wants a budget-wide pass, prefer `bun run start reconcile analyze --days 90 --history-days 365`.
2. If the user wants an Amazon-only pass, sync Amazon profiles when the user wants fresh order and payments data, run `bun run start learn --history-days 365`, then run `bun run start analyze --days 90 --history-days 365`.
3. Read `data/reconcile-latest.json` for the budget-wide flow or `data/analysis-latest.json` for the Amazon-only flow.
4. Focus on `auto_apply`, `needs_review`, and `no_match`, including Amazon refunds and non-Amazon recurring merchants.
5. Ask the user only about uncertain or unmatched transactions.
6. Save confirmed one-off decisions with `decide`.
7. Save reusable Amazon memory with `remember` only when the user wants that pattern reused.
8. Show `bun run start reconcile apply` or `bun run start apply` before any write.
9. Never run a write command without explicit user confirmation.

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

Generate a full-budget analysis bundle:

```bash
bun run start reconcile analyze --days 90 --history-days 365
```

Preview a full-budget apply:

```bash
bun run start reconcile apply
```

Write a full-budget apply:

```bash
bun run start reconcile apply --write
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
- `data/amazon-payments-*.json`: cached Amazon payments transaction history per profile
- `data/category-memory.json`: learned rules plus reusable manual memory
- `data/analysis-latest.json`: latest AI-ready review bundle
- `data/reconcile-latest.json`: latest AI-ready full-budget bundle

These files are ignored by git and are meant to stay local to your machine.

## License

This project is licensed under the MIT License. That means you can use, modify, publish, sublicense, or sell it, as long as the license notice is preserved.
