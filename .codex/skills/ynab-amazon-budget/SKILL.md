---
name: ynab-amazon-budget
description: Use when the user wants help reconciling Amazon purchases in YNAB with this repository's local helper by syncing Amazon order history, learning from past categorizations, generating an analysis bundle, asking only about uncertain transactions, and optionally applying approved updates back to YNAB.
---

# YNAB Amazon Budget

Use this skill from the `ynab-amazon-helper` repository root.

## Workflow

1. Refresh Amazon order data when needed:
   - `bun run start amazon sync --profile primary --pages 5`
   - `bun run start amazon sync --profile secondary --pages 5`
2. Learn from prior categorized YNAB history:
   - `bun run start learn --history-days 365`
3. Generate the current analysis bundle:
   - `bun run start analyze --days 90 --history-days 365`
4. Read `data/analysis-latest.json` and review:
   - `auto_apply`
   - `needs_review`
   - `no_match`
5. Ask the user only about uncertain or unmatched transactions.
6. Save confirmed one-off choices:
   - `bun run start decide --transaction-id <id> --category "<name-or-id>"`
7. Save reusable memory only when the user wants that pattern reused:
   - `bun run start remember --transaction-id <id> --category "<name-or-id>" --scope item|fingerprint|both`
8. Show the exact dry run before any write:
   - `bun run start apply`
9. Only after explicit user confirmation, write updates:
   - `bun run start apply --write`

## Guardrails

- Treat the scripts as local plumbing and the AI as the reasoning layer.
- Prefer `analyze` over the older `match` output when the user wants intelligent help.
- Do not run `apply --write` without explicit user confirmation in the current conversation.
- Use `remember` only after the user confirms the categorization should become a reusable rule.
- If Amazon sessions have expired, let the user complete sign-in, MFA, and captchas manually in the headed browser.
- If the user wants a narrower review pass, use:
  - `bun run start review --days 90 --only unmatched`
  - `bun run start review --days 90 --only ambiguous`

## Useful Files

- `data/analysis-latest.json`: current AI-ready review bundle
- `data/category-memory.json`: learned category memory and reusable overrides
- `data/amazon-orders-<profile>.json`: cached Amazon orders for each local browser profile
