import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildAmazonAnalysisTransactions, buildAnalysisBundle, buildBundleFromTransactions } from "./analysis.ts";
import type { AppConfig } from "./config.ts";
import { readAllOrders, readAllPaymentTransactions } from "./cache.ts";
import { buildGenericAnalysisTransactions, buildGenericHistory } from "./generic.ts";
import { buildMemoryStore, readMemory, writeMemory } from "./memory.ts";
import { isAmazonishTransaction, matchTransactions } from "./match.ts";
import type { AnalysisBundle, MemoryStore, TransactionMatch, YnabAccount, YnabCategory } from "./types.ts";
import { YnabClient, resolveAccount } from "./ynab.ts";
import { addDays } from "./utils.ts";

type WorkflowOptions = {
  planId?: string | null;
  accountId?: string | null;
  accountName?: string | null;
  days?: number;
  historyDays?: number;
};

export type PendingMatchContext = {
  account: YnabAccount;
  categories: YnabCategory[];
  matches: TransactionMatch[];
  cachedOrders: number;
  pendingSinceDate: string;
};

function analysisPath(config: AppConfig): string {
  return join(config.dataDir, "analysis-latest.json");
}

function budgetAnalysisPath(config: AppConfig): string {
  return join(config.dataDir, "reconcile-latest.json");
}

async function resolvePlanContext(config: AppConfig, options: WorkflowOptions): Promise<{
  client: YnabClient;
  planId: string;
}> {
  const client = new YnabClient(config);
  return {
    client,
    planId: options.planId ?? config.defaultPlanId,
  };
}

async function resolveWorkflowAccount(config: AppConfig, options: WorkflowOptions): Promise<{
  client: YnabClient;
  planId: string;
  account: YnabAccount;
}> {
  const client = new YnabClient(config);
  const planId = options.planId ?? config.defaultPlanId;
  const accountId = options.accountId ?? config.defaultAccountId;
  const accountName = options.accountName ?? config.defaultAccountName;
  const account = await resolveAccount(client, planId, accountId, accountName);

  return {
    client,
    planId,
    account,
  };
}

export async function loadPendingMatchContext(config: AppConfig, options: WorkflowOptions): Promise<PendingMatchContext> {
  const { client, planId, account } = await resolveWorkflowAccount(config, options);
  const days = options.days ?? 90;
  const pendingSinceDate = addDays(new Date().toISOString().slice(0, 10), -days);
  const transactions = await client.getUnapprovedTransactions(planId, pendingSinceDate);
  const accountTransactions = transactions.filter(
    (transaction) =>
      transaction.accountId === account.id &&
      !transaction.deleted &&
      !transaction.approved &&
      transaction.amountCents !== 0 &&
      isAmazonishTransaction(transaction),
  );
  const orders = await readAllOrders(config);
  const paymentTransactions = await readAllPaymentTransactions(config);
  const matches = matchTransactions(accountTransactions, orders, paymentTransactions);
  const categories = await client.listCategories(planId);

  return {
    account,
    categories,
    matches,
    cachedOrders: orders.length,
    pendingSinceDate,
  };
}

export async function learnMemoryFromHistory(
  config: AppConfig,
  options: WorkflowOptions,
): Promise<{ memory: MemoryStore; account: YnabAccount; categories: YnabCategory[] }> {
  const { client, planId, account } = await resolveWorkflowAccount(config, options);
  const historyDays = options.historyDays ?? 365;
  const historySinceDate = addDays(new Date().toISOString().slice(0, 10), -historyDays);
  const historyTransactions = await client.getAccountTransactions(planId, account.id, historySinceDate);
  const categorizedHistory = historyTransactions.filter(
    (transaction) =>
      !transaction.deleted &&
      transaction.approved &&
      transaction.amountCents !== 0 &&
      Boolean(transaction.categoryId) &&
      Boolean(transaction.categoryName) &&
      isAmazonishTransaction(transaction),
  );
  const orders = await readAllOrders(config);
  const paymentTransactions = await readAllPaymentTransactions(config);
  const historyMatches = matchTransactions(categorizedHistory, orders, paymentTransactions);
  const existingMemory = await readMemory(config);
  const memory = buildMemoryStore({
    historyMatches,
    sinceDate: historySinceDate,
    cachedOrders: orders.length,
    existingMemory,
  });

  await writeMemory(config, memory);

  return {
    memory,
    account,
    categories: await client.listCategories(planId),
  };
}

export async function analyzePendingTransactions(
  config: AppConfig,
  options: WorkflowOptions,
): Promise<{ bundle: AnalysisBundle; path: string }> {
  const pending = await loadPendingMatchContext(config, options);
  const learned = await learnMemoryFromHistory(config, options);

  const bundle = buildAnalysisBundle({
    account: pending.account,
    categories: learned.categories,
    memory: learned.memory,
    matches: pending.matches,
    pendingSinceDate: pending.pendingSinceDate,
  });

  const path = analysisPath(config);
  await writeAnalysisBundle(config, bundle, path);

  return { bundle, path };
}

export async function analyzeBudgetTransactions(
  config: AppConfig,
  options: WorkflowOptions,
): Promise<{ bundle: AnalysisBundle; path: string }> {
  const { client, planId } = await resolvePlanContext(config, options);
  const days = options.days ?? 90;
  const historyDays = options.historyDays ?? 365;
  const pendingSinceDate = addDays(new Date().toISOString().slice(0, 10), -days);
  const historySinceDate = addDays(new Date().toISOString().slice(0, 10), -historyDays);
  const [categories, pendingTransactions, historyTransactions, existingMemory] = await Promise.all([
    client.listCategories(planId),
    client.getUnapprovedTransactions(planId, pendingSinceDate),
    client.getTransactions(planId, historySinceDate),
    readMemory(config),
  ]);

  const orders = await readAllOrders(config);
  const paymentTransactions = await readAllPaymentTransactions(config);

  const pendingAmazonTransactions = pendingTransactions.filter(
    (transaction) =>
      !transaction.deleted &&
      !transaction.approved &&
      transaction.amountCents !== 0 &&
      isAmazonishTransaction(transaction),
  );
  const amazonHistoryTransactions = historyTransactions.filter(
    (transaction) =>
      !transaction.deleted &&
      transaction.approved &&
      transaction.amountCents !== 0 &&
      Boolean(transaction.categoryId) &&
      Boolean(transaction.categoryName) &&
      isAmazonishTransaction(transaction),
  );
  const amazonPendingMatches = matchTransactions(pendingAmazonTransactions, orders, paymentTransactions);
  const amazonHistoryMatches = matchTransactions(amazonHistoryTransactions, orders, paymentTransactions);
  const amazonMemory = buildMemoryStore({
    historyMatches: amazonHistoryMatches,
    sinceDate: historySinceDate,
    cachedOrders: orders.length,
    existingMemory,
  });

  await writeMemory(config, amazonMemory);

  const genericPendingTransactions = pendingTransactions.filter(
    (transaction) =>
      !transaction.deleted &&
      !transaction.approved &&
      transaction.amountCents !== 0 &&
      !isAmazonishTransaction(transaction),
  );
  const genericHistory = buildGenericHistory(historyTransactions, historySinceDate);

  const amazonAnalysisTransactions = buildAmazonAnalysisTransactions({
    categories,
    memory: amazonMemory,
    matches: amazonPendingMatches,
  });
  const genericAnalysisTransactions = buildGenericAnalysisTransactions({
    transactions: genericPendingTransactions,
    categories,
    history: genericHistory,
  });
  const transactions = [...amazonAnalysisTransactions, ...genericAnalysisTransactions].sort((left, right) => {
    if (left.transactionDate !== right.transactionDate) {
      return left.transactionDate.localeCompare(right.transactionDate);
    }

    if (left.accountName !== right.accountName) {
      return left.accountName.localeCompare(right.accountName);
    }

    if (left.payee !== right.payee) {
      return left.payee.localeCompare(right.payee);
    }

    return left.transactionId.localeCompare(right.transactionId);
  });

  const bundle = buildBundleFromTransactions({
    account: {
      id: "__budget__",
      name: "All Budget Accounts",
    } satisfies YnabAccount,
    categories,
    pendingSinceDate,
    historySinceDate,
    cachedOrders: orders.length,
    transactions,
    memory: {
      updatedAt: new Date().toISOString(),
      exactItemRules: amazonMemory.learned.exactItemRules.length,
      exactFingerprintRules: amazonMemory.learned.exactFingerprintRules.length,
      historyExamples: amazonMemory.historyExamples.length,
      exactPayeeRules: genericHistory.exactPayeeRules.length,
      exactAccountPayeeRules: genericHistory.exactAccountPayeeRules.length,
      exactPayeeMemoRules: genericHistory.exactPayeeMemoRules.length,
      genericHistoryExamples: genericHistory.historyExamples.length,
    },
    pendingAccounts: new Set(pendingTransactions.map((transaction) => transaction.accountId)).size,
  });

  const path = budgetAnalysisPath(config);
  await writeAnalysisBundle(config, bundle, path);

  return { bundle, path };
}

export async function readAnalysisBundle(config: AppConfig, explicitPath?: string | null): Promise<AnalysisBundle> {
  const path = explicitPath ?? analysisPath(config);
  const contents = await readFile(path, "utf8");
  return JSON.parse(contents) as AnalysisBundle;
}

export async function writeAnalysisBundle(
  _config: AppConfig,
  bundle: AnalysisBundle,
  explicitPath: string,
): Promise<void> {
  await writeFile(explicitPath, `${JSON.stringify(bundle, null, 2)}\n`, "utf8");
}

export function defaultAnalysisPath(config: AppConfig): string {
  return analysisPath(config);
}

export function defaultBudgetAnalysisPath(config: AppConfig): string {
  return budgetAnalysisPath(config);
}
