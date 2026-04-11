import { loadConfig } from "./config.ts";
import { writeProfileOrders } from "./cache.ts";
import { syncAmazonOrders } from "./amazon.ts";
import { addOverrideRule, fingerprintOrder } from "./memory.ts";
import { printMatchReport, printMatchesAsJson } from "./report.ts";
import { reviewMatchesInteractive, type ReviewFilter } from "./review.ts";
import {
  analyzePendingTransactions,
  defaultAnalysisPath,
  learnMemoryFromHistory,
  loadPendingMatchContext,
  readAnalysisBundle,
  writeAnalysisBundle,
} from "./workflow.ts";
import { YnabClient } from "./ynab.ts";
import { normalizeText } from "./utils.ts";
import type { AnalysisBundle, YnabCategory } from "./types.ts";

type ParsedArgs = {
  positionals: string[];
  options: Record<string, string | boolean>;
};

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
  bun run start learn [--history-days 365]
  bun run start analyze [--days 90] [--history-days 365]
  bun run start match [--days 90] [--json]
  bun run start review [--days 90] [--only all|matched|unmatched|ambiguous] [--limit 25]
  bun run start decide --transaction-id <id> --category <name-or-id> [--file data/analysis-latest.json]
  bun run start remember --transaction-id <id> --category <name-or-id> --scope item|fingerprint|both [--file data/analysis-latest.json]
  bun run start apply [--file data/analysis-latest.json] [--write]

Environment:
  YNAB_ACCESS_TOKEN   required for YNAB commands
  YNAB_PLAN_ID        defaults to last-used
  YNAB_ACCOUNT_NAME   recommended, e.g. "Amazon Card"
  YNAB_ACCOUNT_ID     optional exact override
  AMAZON_MARKETPLACE  defaults to https://www.amazon.com
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
    const scrapedOrders = await syncAmazonOrders(config, {
      profile,
      pages,
      marketplace,
    });
    const summary = await writeProfileOrders(config, profile, marketplace, scrapedOrders);
    console.log(
      `Saved ${scrapedOrders.length} scraped orders for ${profile}. Cache now has ${summary.total} orders (${summary.added} new, ${summary.updated} updated).`,
    );
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

    await writeAnalysisBundle(config, bundle, file ?? defaultAnalysisPath(config));

    console.log(
      `Saved decision for ${transaction.transactionDate} $${(transaction.amountCents / 100).toFixed(2)} ${transaction.payee} -> ${category.name}`,
    );
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

  if (group === "apply") {
    const file = readStringOption(args.options, "file");
    const write = args.options.write === true;
    const bundle = await readAnalysisBundle(config, file);
    const client = new YnabClient(config);
    const planId = workflowOptions.planId ?? config.defaultPlanId;

    const applicable = bundle.transactions
      .map((transaction) => {
        const categoryId = transaction.decision.selectedCategoryId ?? transaction.decision.proposedCategoryId;
        const categoryName = transaction.decision.selectedCategoryName ?? transaction.decision.proposedCategoryName;
        const eligible =
          Boolean(categoryId) &&
          (transaction.decision.status === "auto_apply" || Boolean(transaction.decision.selectedCategoryId));

        return {
          transaction,
          categoryId,
          categoryName,
          eligible,
        };
      })
      .filter((item) => item.eligible);

    if (applicable.length === 0) {
      console.log("No transactions in the analysis bundle are ready to apply.");
      return;
    }

    console.log(`Analysis file: ${file ?? defaultAnalysisPath(config)}`);
    console.log(`Transactions ready to apply: ${applicable.length}`);

    for (const item of applicable) {
      console.log(
        `${item.transaction.transactionDate}  $${(item.transaction.amountCents / 100).toFixed(2)}  ${item.transaction.payee}  ->  ${item.categoryName}`,
      );
    }

    if (!write) {
      console.log("");
      console.log("Dry run only. Re-run with --write to update YNAB.");
      return;
    }

    for (const item of applicable) {
      await client.updateTransaction(planId, item.transaction.transactionId, {
        categoryId: item.categoryId,
        approved: item.transaction.decision.shouldApprove,
      });
    }

    console.log("YNAB transactions updated successfully.");
    return;
  }

  printHelp();
}

run().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
