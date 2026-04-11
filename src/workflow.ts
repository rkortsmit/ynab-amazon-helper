import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildAnalysisBundle } from "./analysis.ts";
import type { AppConfig } from "./config.ts";
import { readAllOrders } from "./cache.ts";
import { buildMemoryStore, readMemory, writeMemory } from "./memory.ts";
import { matchTransactions } from "./match.ts";
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
      transaction.amountCents < 0,
  );
  const orders = await readAllOrders(config);
  const matches = matchTransactions(accountTransactions, orders);
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
      transaction.amountCents < 0 &&
      transaction.approved &&
      Boolean(transaction.categoryId) &&
      Boolean(transaction.categoryName),
  );
  const orders = await readAllOrders(config);
  const historyMatches = matchTransactions(categorizedHistory, orders);
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
