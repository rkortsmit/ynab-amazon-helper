import { loadConfig } from "./config.ts";
import {
  readAllOrders,
  readAllPaymentTransactions,
  writeProfileOrders,
  writeProfilePaymentTransactions,
} from "./cache.ts";
import { openOrderInProfile, syncAmazonOrders, syncAmazonPaymentTransactions } from "./amazon.ts";
import { readFile as readFileAsync, writeFile as writeFileAsync } from "node:fs/promises";
import { join as joinPath } from "node:path";
import { addOverrideRule, fingerprintOrder } from "./memory.ts";
import { generateMemoFromMatch } from "./memo.ts";
import { isAmazonishTransaction, matchTransactions } from "./match.ts";
import { printMatchReport, printMatchesAsJson } from "./report.ts";
import { reviewMatchesInteractive, type ReviewFilter } from "./review.ts";
import {
  analyzePendingTransactions,
  defaultAnalysisPath,
  defaultBudgetAnalysisPath,
  learnMemoryFromHistory,
  analyzeBudgetTransactions,
  loadPendingMatchContext,
  readAnalysisBundle,
  writeAnalysisBundle,
} from "./workflow.ts";
import { resolveAccount, YnabClient } from "./ynab.ts";
import { addDays, normalizeText } from "./utils.ts";
import type { AnalysisBundle, YnabCategory } from "./types.ts";

type ParsedArgs = {
  positionals: string[];
  options: Record<string, string | boolean>;
};

function formatSignedCents(cents: number): string {
  const sign = cents > 0 ? "+" : cents < 0 ? "-" : "";
  return `${sign}$${(Math.abs(cents) / 100).toFixed(2)}`;
}

function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const options: Record<string, string | boolean> = {};

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }

    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      options[key] = true;
      continue;
    }

    options[key] = next;
    index += 1;
  }

  return { positionals, options };
}

function readStringOption(options: ParsedArgs["options"], key: string): string | null {
  const value = options[key];
  return typeof value === "string" ? value : null;
}

function readNumberOption(options: ParsedArgs["options"], key: string, fallback: number): number {
  const value = readStringOption(options, key);
  if (!value) {
    return fallback;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function printHelp(): void {
  console.log(`Usage:
  bun run start ynab plans
  bun run start ynab accounts [--plan-id last-used]
  bun run start ynab categories [--plan-id last-used]
  bun run start amazon sync --profile primary [--pages 5]
  bun run start amazon open --profile <name> --order <order-number> [--close]
  bun run start learn [--history-days 365]
  bun run start analyze [--days 90] [--history-days 365] [--unapproved-only]
  bun run start reconcile analyze [--days 90] [--history-days 365] [--unapproved-only]
  bun run start reconcile apply [--file data/reconcile-latest.json] [--only-decided] [--write]
  bun run start match [--days 90] [--json]
  bun run start review [--days 90] [--only all|matched|unmatched|ambiguous] [--limit 25]
  bun run start decide --transaction-id <id> --category <name-or-id> [--file data/analysis-latest.json]
  bun run start remember --transaction-id <id> --category <name-or-id> --scope item|fingerprint|both [--file data/analysis-latest.json]
  bun run start split --transaction-id <id> --splits '<json>' [--file data/analysis-latest.json]
  bun run start split --transaction-id <id> --clear [--file data/analysis-latest.json]
  bun run start apply [--file data/analysis-latest.json] [--only-decided] [--write]
  bun run start memo backfill [--days 45] [--write] [--overwrite]
  bun run start memo apply [--file data/analysis-latest.json] [--min-confidence strong|medium] [--transaction-id <id>] [--limit N] [--write]

Environment:
  YNAB_ACCESS_TOKEN   required for YNAB commands
  YNAB_PLAN_ID        defaults to last-used
  YNAB_ACCOUNT_NAME   recommended, e.g. "Amazon Card"
  YNAB_ACCOUNT_ID     optional exact override
  AMAZON_MARKETPLACE  defaults to https://www.amazon.com

Notes:
  amazon sync refreshes both order history and Your Payments > Transactions.
  apply writes categories/approval and fills an empty memo when a short memo can be generated.
  memo apply writes ONLY the memo (never category or approval) for confidently matched Amazon transactions.
  analyze includes unapproved transactions plus approved ones with no category (--unapproved-only for the old behavior).
  split saves a multi-category split locally; apply sends it to YNAB. --only-decided skips the tool's own auto-apply picks.
`);
}

function readReviewFilter(options: ParsedArgs["options"]): ReviewFilter {
  const value = readStringOption(options, "only");
  if (value === "matched" || value === "unmatched" || value === "ambiguous") {
    return value;
  }

  return "all";
}

function resolveCategory(bundle: AnalysisBundle, value: string): YnabCategory {
  const exact = bundle.categories.find((category) => category.id === value);
  if (exact) {
    return exact;
  }

  const normalized = normalizeText(value);
  const byName = bundle.categories.filter((category) => normalizeText(category.name) === normalized);
  if (byName.length === 1) {
    return byName[0];
  }

  const byContains = bundle.categories.filter((category) => normalizeText(category.name).includes(normalized));
  if (byContains.length === 1) {
    return byContains[0];
  }

  if (byContains.length > 1) {
    throw new Error(`Multiple categories matched "${value}". Use an exact category id or name.`);
  }

  throw new Error(`No category matched "${value}".`);
}

async function run(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const config = await loadConfig();
  const [group, command] = args.positionals;
  const workflowOptions = {
    planId: readStringOption(args.options, "plan-id") ?? config.defaultPlanId,
    accountId: readStringOption(args.options, "account-id") ?? config.defaultAccountId,
    accountName: readStringOption(args.options, "account-name") ?? config.defaultAccountName,
    days: readNumberOption(args.options, "days", 90),
    historyDays: readNumberOption(args.options, "history-days", 365),
    unapprovedOnly: args.options["unapproved-only"] === true,
  };

  if (!group || group === "help" || group === "--help") {
    printHelp();
    return;
  }

  if (group === "ynab" && command === "plans") {
    const client = new YnabClient(config);
    const plans = await client.listPlans();
    for (const plan of plans) {
      console.log(`${plan.id}  ${plan.name}`);
    }
    return;
  }

  if (group === "ynab" && command === "accounts") {
    const client = new YnabClient(config);
    const planId = workflowOptions.planId ?? config.defaultPlanId;
    const accounts = await client.listAccounts(planId);
    for (const account of accounts) {
      console.log(`${account.id}  ${account.name}  ${account.type ?? "unknown"}`);
    }
    return;
  }

  if (group === "ynab" && command === "categories") {
    const client = new YnabClient(config);
    const planId = workflowOptions.planId ?? config.defaultPlanId;
    const categories = await client.listCategories(planId);
    for (const category of categories.filter((item) => !item.deleted)) {
      console.log(`${category.id}  ${category.groupName} / ${category.name}`);
    }
    return;
  }

  if (group === "amazon" && command === "sync") {
    const profile = readStringOption(args.options, "profile");
    if (!profile) {
      throw new Error("amazon sync requires --profile.");
    }

    const pages = readNumberOption(args.options, "pages", 5);
    const marketplace = readStringOption(args.options, "marketplace") ?? config.defaultMarketplace;
    const syncOptions = {
      profile,
      pages,
      marketplace,
    };
    const scrapedOrders = await syncAmazonOrders(config, syncOptions);
    const scrapedPaymentTransactions = await syncAmazonPaymentTransactions(config, syncOptions);
    const summary = await writeProfileOrders(config, profile, marketplace, scrapedOrders);
    const paymentSummary = await writeProfilePaymentTransactions(config, profile, marketplace, scrapedPaymentTransactions);
    console.log(
      `Saved ${scrapedOrders.length} scraped orders and ${scrapedPaymentTransactions.length} payment transactions for ${profile}. Orders cache: ${summary.total} total (${summary.added} new, ${summary.updated} updated). Payments cache: ${paymentSummary.total} total (${paymentSummary.added} new, ${paymentSummary.updated} updated).`,
    );
    return;
  }

  if (group === "amazon" && command === "open") {
    const profile = readStringOption(args.options, "profile");
    const orderNumber = readStringOption(args.options, "order");
    if (!profile || !orderNumber) {
      throw new Error("amazon open requires --profile and --order.");
    }
    if (!/^[0-9A-Za-z-]{5,40}$/.test(orderNumber)) {
      throw new Error("That order number doesn't look right.");
    }

    const marketplace = readStringOption(args.options, "marketplace") ?? config.defaultMarketplace;
    const keepOpen = args.options.close !== true;
    console.log(`Opening order ${orderNumber} in the "${profile}" Amazon login…`);
    const extracted = await openOrderInProfile(config, { profile, marketplace, orderNumber, keepOpen });

    const pricesPath = joinPath(config.dataDir, "amazon-item-prices.json");
    let store: Record<string, unknown> = {};
    try {
      store = JSON.parse(await readFileAsync(pricesPath, "utf8"));
    } catch {
      store = {};
    }
    store[orderNumber] = { profile, ...extracted, scrapedAt: new Date().toISOString() };
    await writeFileAsync(pricesPath, `${JSON.stringify(store, null, 2)}\n`, "utf8");

    const priced = extracted.items.filter((item) => item.unitPriceCents !== null);
    console.log(`Items found: ${extracted.items.length} (with prices: ${priced.length}) [reader: ${extracted.summary.strategy}]`);
    for (const item of extracted.items) {
      const price = item.unitPriceCents === null ? "price not found" : `$${(item.unitPriceCents / 100).toFixed(2)}`;
      console.log(`  ${price}${item.quantity > 1 ? ` x ${item.quantity}` : ""}  ${item.title}`);
    }
    const s = extracted.summary;
    const f = (c: number | null) => (c === null ? "?" : `$${(c / 100).toFixed(2)}`);
    console.log(`Order summary: items ${f(s.subtotalCents)} · shipping ${f(s.shippingCents)} · tax ${f(s.taxCents)} · total ${f(s.totalCents)}`);
    if (!priced.length) {
      console.log("No prices were recognized on this page. A copy was saved to data/debug/last-order-page.html so the reader can be adjusted.");
    }
    return;
  }

  if (group === "learn") {
    const { memory, account } = await learnMemoryFromHistory(config, workflowOptions);
    console.log(`Account: ${account.name}`);
    console.log(`History window: ${memory.source.sinceDate} -> today`);
    console.log(`Categorized history transactions checked: ${memory.source.historyTransactions}`);
    console.log(`History transactions matched to Amazon orders: ${memory.source.matchedTransactions}`);
    console.log(`Learned exact item rules: ${memory.learned.exactItemRules.length}`);
    console.log(`Learned exact fingerprint rules: ${memory.learned.exactFingerprintRules.length}`);
    return;
  }

  if (group === "analyze") {
    const { bundle, path } = await analyzePendingTransactions(config, workflowOptions);
    console.log(`Account: ${bundle.account.name}`);
    console.log(`Pending transactions: ${bundle.source.pendingTransactions}`);
    console.log(`Cached orders: ${bundle.source.cachedOrders}`);
    console.log(`Auto-apply: ${bundle.summary.autoApply}`);
    console.log(`Needs review: ${bundle.summary.needsReview}`);
    console.log(`No match: ${bundle.summary.noMatch}`);
    console.log(`Analysis bundle: ${path}`);
    return;
  }

  if (group === "reconcile" && command === "analyze") {
    const { bundle, path } = await analyzeBudgetTransactions(config, workflowOptions);
    console.log(`Account scope: ${bundle.account.name}`);
    console.log(`Pending transactions: ${bundle.source.pendingTransactions}`);
    console.log(`Pending accounts: ${bundle.source.pendingAccounts ?? 0}`);
    console.log(`Cached Amazon orders: ${bundle.source.cachedOrders}`);
    console.log(`Auto-apply: ${bundle.summary.autoApply}`);
    console.log(`Needs review: ${bundle.summary.needsReview}`);
    console.log(`No match: ${bundle.summary.noMatch}`);
    console.log(`Analysis bundle: ${path}`);
    return;
  }

  if (group === "match") {
    const { account, cachedOrders, matches } = await loadPendingMatchContext(config, workflowOptions);

    if (args.options.json === true) {
      printMatchesAsJson(matches);
      return;
    }

    console.log(`Account: ${account.name}`);
    console.log(`Transactions checked: ${matches.length}`);
    console.log(`Cached orders: ${cachedOrders}`);
    printMatchReport(matches);
    return;
  }

  if (group === "review") {
    const { account, cachedOrders, matches } = await loadPendingMatchContext(config, workflowOptions);
    const filter = readReviewFilter(args.options);
    const limit = readNumberOption(args.options, "limit", 0);

    console.log(`Account: ${account.name}`);
    console.log(`Transactions checked: ${matches.length}`);
    console.log(`Cached orders: ${cachedOrders}`);
    await reviewMatchesInteractive(matches, {
      filter,
      limit: limit > 0 ? limit : undefined,
    });
    return;
  }

  if (group === "decide") {
    const file = readStringOption(args.options, "file");
    const transactionId = readStringOption(args.options, "transaction-id");
    const categoryValue = readStringOption(args.options, "category");

    if (!transactionId || !categoryValue) {
      throw new Error("decide requires --transaction-id and --category.");
    }

    const bundle = await readAnalysisBundle(config, file);
    const category = resolveCategory(bundle, categoryValue);
    const transaction = bundle.transactions.find((item) => item.transactionId === transactionId);

    if (!transaction) {
      throw new Error(`No analysis transaction found with id ${transactionId}.`);
    }

    transaction.decision.selectedCategoryId = category.id;
    transaction.decision.selectedCategoryName = category.name;
    transaction.decision.shouldApprove = true;
    transaction.decision.splits = null;

    await writeAnalysisBundle(config, bundle, file ?? defaultAnalysisPath(config));

    console.log(
      `Saved decision for ${transaction.transactionDate} $${(transaction.amountCents / 100).toFixed(2)} ${transaction.payee} -> ${category.name}`,
    );
    return;
  }

  if (group === "split") {
    const file = readStringOption(args.options, "file");
    const transactionId = readStringOption(args.options, "transaction-id");
    const clear = args.options.clear === true;
    const rawSplits = readStringOption(args.options, "splits");

    if (!transactionId) {
      throw new Error("split requires --transaction-id.");
    }

    const bundle = await readAnalysisBundle(config, file);
    const transaction = bundle.transactions.find((item) => item.transactionId === transactionId);
    if (!transaction) {
      throw new Error(`No analysis transaction found with id ${transactionId}.`);
    }

    const signed = transaction.signedAmountCents ?? transaction.amountCents;
    const label = `${transaction.transactionDate} ${formatSignedCents(signed)} ${transaction.payee}`;

    if (clear) {
      transaction.decision.splits = null;
      if (transaction.decision.selectedCategoryId === null) {
        transaction.decision.shouldApprove = transaction.decision.status === "auto_apply";
      }
      await writeAnalysisBundle(config, bundle, file ?? defaultAnalysisPath(config));
      console.log(`Removed the split for ${label}.`);
      return;
    }

    if (!rawSplits) {
      throw new Error("split requires --splits '<json>' or --clear.");
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawSplits);
    } catch {
      throw new Error("--splits must be valid JSON.");
    }
    if (!Array.isArray(parsed) || parsed.length < 2 || parsed.length > 30) {
      throw new Error("A split needs between 2 and 30 lines.");
    }

    const sign = signed < 0 ? -1 : 1;
    const lines = parsed.map((raw, index) => {
      const line = raw as { category?: unknown; amountCents?: unknown; memo?: unknown };
      const cents = Number(line.amountCents);
      if (!Number.isInteger(cents) || cents <= 0) {
        throw new Error(`Line ${index + 1}: amount must be a positive number of cents.`);
      }
      if (typeof line.category !== "string" || !line.category.trim()) {
        throw new Error(`Line ${index + 1}: category is missing.`);
      }
      const category = resolveCategory(bundle, line.category.trim());
      const memo = typeof line.memo === "string" && line.memo.trim() ? line.memo.trim().slice(0, 100) : null;
      return { categoryId: category.id, categoryName: category.name, amountCents: sign * cents, memo };
    });

    const total = lines.reduce((sum, line) => sum + line.amountCents, 0);
    if (total !== signed) {
      throw new Error(
        `Split lines add up to ${formatSignedCents(total)} but the transaction is ${formatSignedCents(signed)}. They must match exactly.`,
      );
    }

    transaction.decision.splits = lines;
    transaction.decision.selectedCategoryId = null;
    transaction.decision.selectedCategoryName = null;
    transaction.decision.shouldApprove = true;
    await writeAnalysisBundle(config, bundle, file ?? defaultAnalysisPath(config));

    console.log(`Saved a ${lines.length}-way split for ${label}:`);
    for (const line of lines) {
      console.log(`  ${formatSignedCents(line.amountCents)}  ${line.categoryName}${line.memo ? `  [${line.memo}]` : ""}`);
    }
    console.log("Nothing was sent to YNAB. Run apply (with --write) to send it.");
    return;
  }

  if (group === "remember") {
    const file = readStringOption(args.options, "file");
    const transactionId = readStringOption(args.options, "transaction-id");
    const categoryValue = readStringOption(args.options, "category");
    const scope = readStringOption(args.options, "scope") ?? "item";

    if (!transactionId || !categoryValue) {
      throw new Error("remember requires --transaction-id and --category.");
    }

    if (!["item", "fingerprint", "both"].includes(scope)) {
      throw new Error('remember --scope must be one of: item, fingerprint, both.');
    }

    const bundle = await readAnalysisBundle(config, file);
    const category = resolveCategory(bundle, categoryValue);
    const transaction = bundle.transactions.find((item) => item.transactionId === transactionId);

    if (!transaction) {
      throw new Error(`No analysis transaction found with id ${transactionId}.`);
    }

    if (!transaction.bestMatch) {
      throw new Error("This transaction does not have an Amazon match to learn from.");
    }

    let added = 0;

    if (scope === "item" || scope === "both") {
      for (const itemTitle of transaction.bestMatch.order.itemTitles) {
        await addOverrideRule(config, {
          type: "exact_item",
          match: itemTitle,
          categoryId: category.id,
          categoryName: category.name,
          note: `Learned from transaction ${transaction.transactionId}`,
        });
        added += 1;
      }
    }

    if (scope === "fingerprint" || scope === "both") {
      const fingerprint = fingerprintOrder(transaction.bestMatch);
      if (fingerprint) {
        await addOverrideRule(config, {
          type: "exact_fingerprint",
          match: fingerprint,
          categoryId: category.id,
          categoryName: category.name,
          note: `Learned from transaction ${transaction.transactionId}`,
        });
        added += 1;
      }
    }

    console.log(
      `Saved ${added} override rule(s) for ${transaction.transactionDate} $${(transaction.amountCents / 100).toFixed(2)} -> ${category.name}`,
    );
    return;
  }

  if (group === "apply" || (group === "reconcile" && command === "apply")) {
    const file =
      readStringOption(args.options, "file") ??
      (group === "reconcile" ? defaultBudgetAnalysisPath(config) : null);
    const write = args.options.write === true;
    const onlyDecided = args.options["only-decided"] === true;
    const bundle = await readAnalysisBundle(config, file);
    const client = new YnabClient(config);
    const planId = workflowOptions.planId ?? config.defaultPlanId;

    const applicable = bundle.transactions
      .map((transaction) => {
        const categoryId = transaction.decision.selectedCategoryId ?? transaction.decision.proposedCategoryId;
        const categoryName = transaction.decision.selectedCategoryName ?? transaction.decision.proposedCategoryName;
        const signedAmountCents = transaction.signedAmountCents ?? transaction.amountCents;
        const generatedMemo = generateMemoFromMatch(transaction.bestMatch, {
          refund: signedAmountCents > 0,
        });
        const memo = (transaction.memo ?? "").trim() ? transaction.memo : generatedMemo;
        const splits = transaction.decision.splits && transaction.decision.splits.length >= 2 ? transaction.decision.splits : null;
        const chosen = Boolean(transaction.decision.selectedCategoryId) || Boolean(splits);
        const eligible = splits
          ? true
          : Boolean(categoryId) && (chosen || (!onlyDecided && transaction.decision.status === "auto_apply"));

        return {
          transaction,
          categoryId,
          categoryName: splits ? `Split (${splits.length})` : categoryName,
          signedAmountCents,
          memo,
          splits,
          eligible,
        };
      })
      .filter((item) => item.eligible);

    if (applicable.length === 0) {
      console.log("No transactions in the analysis bundle are ready to apply.");
      return;
    }

    console.log(`Analysis file: ${file ?? defaultAnalysisPath(config)}`);
    console.log(`Transactions ready to apply: ${applicable.length}${onlyDecided ? " (only the ones you chose)" : ""}`);

    for (const item of applicable) {
      console.log(
        `${item.transaction.transactionDate}  ${formatSignedCents(item.signedAmountCents)}  ${item.transaction.payee}  ->  ${item.categoryName}${item.memo ? `  [memo: ${item.memo}]` : ""}`,
      );
      for (const line of item.splits ?? []) {
        console.log(`      ${formatSignedCents(line.amountCents)}  ${line.categoryName}${line.memo ? `  [${line.memo}]` : ""}`);
      }
    }

    if (!write) {
      console.log("");
      console.log("Dry run only. Re-run with --write to update YNAB.");
      return;
    }

    let updated = 0;
    for (const item of applicable) {
      if (item.splits) {
        // Re-check live YNAB state: YNAB cannot change an existing split, and the amount must still match.
        const live = await client.getTransactionSplitState(planId, item.transaction.transactionId);
        const label = `${item.transaction.transactionDate} ${formatSignedCents(item.signedAmountCents)} ${item.transaction.payee}`;
        if (live.deleted) {
          console.log(`  skipped (deleted in YNAB): ${label}`);
          continue;
        }
        if (live.subtransactionCount > 0) {
          console.log(`  skipped (already split in YNAB; change it in YNAB itself): ${label}`);
          continue;
        }
        if (live.amountMilliunits !== item.signedAmountCents * 10) {
          console.log(`  skipped (amount changed in YNAB since the analysis; run Analyze again): ${label}`);
          continue;
        }
        await client.updateTransaction(planId, item.transaction.transactionId, {
          approved: item.transaction.decision.shouldApprove,
          memo: (live.memo ?? "").trim() ? undefined : item.memo ?? undefined,
          subtransactions: item.splits.map((line) => ({
            amountMilliunits: line.amountCents * 10,
            categoryId: line.categoryId,
            memo: line.memo,
          })),
        });
        updated += 1;
        continue;
      }

      await client.updateTransaction(planId, item.transaction.transactionId, {
        categoryId: item.categoryId,
        approved: item.transaction.decision.shouldApprove,
        memo: item.memo ?? undefined,
      });
      updated += 1;
    }

    console.log(`YNAB transactions updated: ${updated}.`);
    return;
  }

  // Memo-only pass over the analysis bundle. Never sends category or approval changes.
  // Only writes when the Amazon match is confident, not ambiguous, and the memo is empty.
  if (group === "memo" && command === "apply") {
    const file = readStringOption(args.options, "file");
    const write = args.options.write === true;
    const minConfidence = readStringOption(args.options, "min-confidence") ?? "strong";
    const onlyTransactionId = readStringOption(args.options, "transaction-id");
    const limit = readNumberOption(args.options, "limit", 0);

    if (minConfidence !== "strong" && minConfidence !== "medium") {
      throw new Error('memo apply --min-confidence must be "strong" or "medium".');
    }

    const allowed = minConfidence === "strong" ? ["strong"] : ["strong", "medium"];
    const bundle = await readAnalysisBundle(config, file);
    const planId = workflowOptions.planId ?? config.defaultPlanId;

    const skipped: Array<{ line: string; reason: string }> = [];
    let applicable = bundle.transactions
      .filter((transaction) => !onlyTransactionId || transaction.transactionId === onlyTransactionId)
      .map((transaction) => {
        const signedAmountCents = transaction.signedAmountCents ?? transaction.amountCents;
        const line = `${transaction.transactionDate}  ${formatSignedCents(signedAmountCents)}  ${transaction.payee}`;
        const match = transaction.bestMatch;
        let reason: string | null = null;

        if (!match) {
          reason = "no Amazon match";
        } else if (!allowed.includes(match.confidence)) {
          reason = `match confidence is ${match.confidence}`;
        } else if (transaction.ambiguous) {
          reason = "ambiguous match (another order is a close second)";
        } else if ((transaction.memo ?? "").trim()) {
          reason = "memo already set";
        }

        const memo = reason ? null : generateMemoFromMatch(match, { refund: signedAmountCents > 0 });
        if (!reason && !memo) {
          reason = "could not generate a memo";
        }

        if (reason) {
          skipped.push({ line, reason });
          return null;
        }

        return { transaction, line, memo: memo as string };
      })
      .filter((item): item is { transaction: (typeof bundle.transactions)[number]; line: string; memo: string } => item !== null);

    if (limit > 0) {
      applicable = applicable.slice(0, limit);
    }

    console.log(`Analysis file: ${file ?? defaultAnalysisPath(config)}`);
    console.log(`Minimum match confidence: ${minConfidence}`);
    console.log(`Memo-only updates (category and approval are NOT changed): ${applicable.length}`);
    for (const item of applicable) {
      console.log(`  ${item.line}  ->  ${item.memo}`);
    }
    console.log(`Left alone: ${skipped.length}`);
    for (const item of skipped) {
      console.log(`  ${item.line}  (${item.reason})`);
    }

    if (applicable.length === 0) {
      console.log("Nothing to write.");
      return;
    }

    if (!write) {
      console.log("");
      console.log("Dry run only. Re-run with --write to update these memos in YNAB.");
      return;
    }

    const client = new YnabClient(config);
    let written = 0;
    for (const item of applicable) {
      // Re-check live YNAB state so a memo added since the analysis ran is never overwritten.
      const live = await client.getTransaction(planId, item.transaction.transactionId);
      if (live.deleted) {
        console.log(`  skipped (deleted in YNAB): ${item.line}`);
        continue;
      }
      if ((live.memo ?? "").trim()) {
        console.log(`  skipped (memo now set in YNAB): ${item.line}`);
        continue;
      }

      await client.updateTransaction(planId, item.transaction.transactionId, { memo: item.memo });
      written += 1;
    }

    console.log(`YNAB memos updated: ${written}. Categories and approval were not changed.`);
    return;
  }

  if (group === "memo" && command === "backfill") {
    const write = args.options.write === true;
    const overwrite = args.options.overwrite === true;
    const client = new YnabClient(config);
    const planId = workflowOptions.planId ?? config.defaultPlanId;
    const account = await resolveAccount(client, planId, workflowOptions.accountId, workflowOptions.accountName);
    const sinceDate = addDays(new Date().toISOString().slice(0, 10), -readNumberOption(args.options, "days", 45));
    const transactions = await client.getAccountTransactions(planId, account.id, sinceDate);
    const candidates = transactions.filter((transaction) => {
      if (transaction.deleted || !transaction.approved || transaction.amountCents === 0) {
        return false;
      }

      if (!overwrite && (transaction.memo ?? "").trim()) {
        return false;
      }

      return isAmazonishTransaction(transaction);
    });

    const orders = await readAllOrders(config);
    const paymentTransactions = await readAllPaymentTransactions(config);
    const matches = matchTransactions(candidates, orders, paymentTransactions);
    const applicable = matches
      .map((match) => ({
        match,
        memo: generateMemoFromMatch(match.best, {
          refund: match.transaction.amountCents > 0,
        }),
      }))
      .filter((item) => item.match.best && item.memo);

    if (applicable.length === 0) {
      console.log("No approved Amazon transactions are eligible for memo backfill.");
      return;
    }

    console.log(`Account: ${account.name}`);
    console.log(`Transactions eligible for memo backfill: ${applicable.length}`);

    for (const item of applicable) {
      console.log(
        `${item.match.transaction.date}  ${formatSignedCents(item.match.transaction.amountCents)}  ${item.match.transaction.importPayeeNameOriginal ?? item.match.transaction.payeeName ?? "(no payee)"}  ->  ${item.memo}`,
      );
    }

    if (!write) {
      console.log("");
      console.log("Dry run only. Re-run with --write to update YNAB memos.");
      return;
    }

    for (const item of applicable) {
      await client.updateTransaction(planId, item.match.transaction.id, {
        memo: item.memo,
      });
    }

    console.log("YNAB memos updated successfully.");
    return;
  }

  printHelp();
}

run().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
