# YNAB Amazon Helper

Local-only helper for matching unapproved YNAB Amazon Visa transactions with your Amazon order history.

## Safety model

- YNAB access is read-only in the first version.
- Amazon login stays manual in a headed browser.
- Browser sessions are stored locally in `profiles/`.
- Scraped order data is stored locally in `data/`.
- No transaction approval or categorization is sent back to YNAB yet.

## Setup

1. `cd /home/steven/code/personal/ynab-amazon-helper`
2. `cp .env.example .env`
3. Add your `YNAB_ACCESS_TOKEN` and `YNAB_ACCOUNT_NAME` to `.env`
4. `bun install`
5. `bunx playwright install chromium`

## Commands

List your YNAB plans:

```bash
bun run start ynab plans
```

List YNAB accounts in your selected plan:

```bash
bun run start ynab accounts
```

List YNAB categories:

```bash
bun run start ynab categories
```

Sync orders for your Amazon account:

```bash
bun run start amazon sync --profile you --pages 5
```

Sync orders for your wife's Amazon account:

```bash
bun run start amazon sync --profile wife --pages 5
```

Match unapproved transactions from your Amazon Visa account against the cached orders:

```bash
bun run start match --days 90
```

JSON output:

```bash
bun run start match --days 90 --json
```

Step through transactions one at a time in review mode:

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

Learn from your categorized Amazon Visa history:

```bash
bun run start learn --history-days 365
```

Generate the AI-ready analysis bundle:

```bash
bun run start analyze --days 90 --history-days 365
```

Save a manual category decision into the current analysis bundle:

```bash
bun run start decide --transaction-id <transaction-id> --category "Groceries"
```

Remember a confirmed decision for future runs:

```bash
bun run start remember --transaction-id <transaction-id> --category "Groceries" --scope item
```

Preview what would be written back to YNAB:

```bash
bun run start apply
```

Actually write eligible decisions back to YNAB:

```bash
bun run start apply --write
```

## Notes

- The scraper uses your local Amazon browser session and may occasionally need you to solve a captcha or MFA challenge.
- Amazon shipment splitting means some matches will still be ambiguous; those are surfaced instead of being forced.
- The first version aims to answer "what was this Amazon charge for?" not "auto-approve everything."
- `data/analysis-latest.json` is the main bundle for AI-assisted review.
- `data/category-memory.json` stores learned history plus reusable manual overrides.
