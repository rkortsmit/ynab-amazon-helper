---
name: ynab-amazon-budget
description: Use when the user wants help reconciling Amazon purchases, refunds, or broader YNAB budget transactions with this repository's local helper by syncing Amazon data when needed, learning from history, generating an analysis bundle, asking only about uncertain transactions, and optionally applying approved updates back to YNAB.
---

# YNAB Budget Reconcile

Use this skill from the `ynab-amazon-helper` repository root.

## Workflow

1. For a full-budget reconcile pass, prefer:
   - `bun run start reconcile analyze --days 90 --history-days 365`
   - Read `data/reconcile-latest.json`
   - Show `bun run start reconcile apply` before any write
2. For an Amazon-focused pass, refresh Amazon order data when needed:
   - `bun run start amazon sync --profile primary --pages 5`
   - `bun run start amazon sync --profile secondary --pages 5`
   - This sync reads both Your Orders and Your Payments > Transactions so split charges and refunds can match more reliably.
   - If older charges or refunds still show as unmatched, re-run sync with a larger `--pages` value.
3. Learn from prior categorized YNAB history for Amazon-specific memory when needed:
   - `bun run start learn --history-days 365`
4. Generate the current Amazon-only analysis bundle when needed:
   - `bun run start analyze --days 90 --history-days 365`
5. Read `data/analysis-latest.json` or `data/reconcile-latest.json` and review:
   - `auto_apply`
   - `needs_review`
   - `no_match`
   - Budget-wide bundles may include Amazon transactions, non-Amazon merchant history suggestions, refunds, and transfer-like transactions that should stay manual.
6. Ask the user only about uncertain or unmatched transactions.
7. Save confirmed one-off choices:
   - `bun run start decide --transaction-id <id> --category "<name-or-id>"`
8. Save reusable Amazon memory only when the user wants that pattern reused:
   - `bun run start remember --transaction-id <id> --category "<name-or-id>" --scope item|fingerprint|both`
9. Show the exact dry run before any write:
   - `bun run start apply`
   - `bun run start reconcile apply`
10. Only after explicit user confirmation, write updates:
   - `bun run start apply --write`
   - `bun run start reconcile apply --write`
11. If approved Amazon transactions are already in YNAB but their memos are blank, backfill them:
   - `bun run start memo backfill --days 45`
   - `bun run start memo backfill --days 45 --write`

## Guardrails

- Treat the scripts as local plumbing and the AI as the reasoning layer.
- Prefer `reconcile analyze` for broad budget-update requests and `analyze` for Amazon-only requests.
- Prefer analysis bundles over the older `match` output when the user wants intelligent help.
- Prefer exact payments-page matches for refunds and split captures when available.
- For non-Amazon transactions, trust repeated payee history and refund matches more than one-off merchant guesses.
- Keep transfer/payment-looking transactions in manual review unless the user explicitly directs otherwise.
- Do not run `apply --write` without explicit user confirmation in the current conversation.
- Use `remember` only after the user confirms the categorization should become a reusable rule.
- If Amazon sessions have expired, let the user complete sign-in, MFA, and captchas manually in the headed browser.
- If the user wants a narrower review pass, use:
  - `bun run start review --days 90 --only unmatched`
  - `bun run start review --days 90 --only ambiguous`

## Useful Files

- `data/analysis-latest.json`: current AI-ready review bundle
- `data/reconcile-latest.json`: current AI-ready full-budget review bundle
- `data/category-memory.json`: learned category memory and reusable overrides
- `data/amazon-orders-<profile>.json`: cached Amazon orders for each local browser profile
