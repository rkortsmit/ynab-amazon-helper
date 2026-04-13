import type { AppConfig } from "./config.ts";
import type { YnabAccount, YnabCategory, YnabPlan, YnabTransaction } from "./types.ts";
import { milliunitsToCents, normalizeText } from "./utils.ts";

type YnabEnvelope<T> = { data: T };

export class YnabClient {
  constructor(private readonly config: AppConfig) {
    if (!config.ynabAccessToken) {
      throw new Error("YNAB_ACCESS_TOKEN is not set. Add it to .env or your shell before running YNAB commands.");
    }
  }

  private async request<T>(path: string): Promise<T> {
    const response = await fetch(`https://api.ynab.com/v1${path}`, {
      headers: {
        Authorization: `Bearer ${this.config.ynabAccessToken}`,
        Accept: "application/json",
      },
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`YNAB request failed (${response.status}): ${body}`);
    }

    return (await response.json()) as T;
  }

  async listPlans(): Promise<YnabPlan[]> {
    const response = await this.request<YnabEnvelope<{ plans: Array<{ id: string; name: string; last_modified_on?: string }> }>>(
      "/plans",
    );

    return response.data.plans.map((plan) => ({
      id: plan.id,
      name: plan.name,
      lastModifiedOn: plan.last_modified_on,
    }));
  }

  async listAccounts(planId: string): Promise<YnabAccount[]> {
    const response = await this.request<
      YnabEnvelope<{
        accounts: Array<{
          id: string;
          name: string;
          type?: string;
          on_budget?: boolean;
          closed?: boolean;
          transfer_payee_id?: string | null;
        }>;
      }>
    >(`/plans/${planId}/accounts`);

    return response.data.accounts.map((account) => ({
      id: account.id,
      name: account.name,
      type: account.type,
      onBudget: account.on_budget,
      closed: account.closed,
      transferPayeeId: account.transfer_payee_id ?? null,
    }));
  }

  async listCategories(planId: string): Promise<YnabCategory[]> {
    const response = await this.request<
      YnabEnvelope<{
        category_groups: Array<{
          id: string;
          name: string;
          categories: Array<{
            id: string;
            name: string;
            category_group_id: string;
            category_group_name: string;
            hidden: boolean;
            deleted: boolean;
          }>;
        }>;
      }>
    >(`/plans/${planId}/categories`);

    return response.data.category_groups.flatMap((group) =>
      group.categories.map((category) => ({
        id: category.id,
        name: category.name,
        groupId: category.category_group_id,
        groupName: category.category_group_name ?? group.name,
        hidden: category.hidden,
        deleted: category.deleted,
      })),
    );
  }

  async getUnapprovedTransactions(planId: string, sinceDate: string): Promise<YnabTransaction[]> {
    const params = new URLSearchParams({
      since_date: sinceDate,
      type: "unapproved",
    });

    const response = await this.request<YnabEnvelope<{ transactions: YnabApiTransaction[] }>>(
      `/plans/${planId}/transactions?${params.toString()}`,
    );

    return response.data.transactions.map(parseTransaction);
  }

  async getTransactions(planId: string, sinceDate: string): Promise<YnabTransaction[]> {
    const params = new URLSearchParams({
      since_date: sinceDate,
    });

    const response = await this.request<YnabEnvelope<{ transactions: YnabApiTransaction[] }>>(
      `/plans/${planId}/transactions?${params.toString()}`,
    );

    return response.data.transactions.map(parseTransaction);
  }

  async getAccountTransactions(planId: string, accountId: string, sinceDate: string): Promise<YnabTransaction[]> {
    const params = new URLSearchParams({
      since_date: sinceDate,
    });

    const response = await this.request<YnabEnvelope<{ transactions: YnabApiTransaction[] }>>(
      `/plans/${planId}/accounts/${accountId}/transactions?${params.toString()}`,
    );

    return response.data.transactions.map(parseTransaction);
  }

  async updateTransaction(
    planId: string,
    transactionId: string,
    updates: {
      categoryId?: string | null;
      approved?: boolean;
      memo?: string | null;
    },
  ): Promise<YnabTransaction> {
    const response = await fetch(`https://api.ynab.com/v1/plans/${planId}/transactions/${transactionId}`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${this.config.ynabAccessToken}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        transaction: {
          category_id: updates.categoryId,
          approved: updates.approved,
          memo: updates.memo,
        },
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`YNAB update failed (${response.status}): ${body}`);
    }

    const parsed = (await response.json()) as YnabEnvelope<{ transaction: YnabApiTransaction }>;
    return parseTransaction(parsed.data.transaction);
  }
}

type YnabApiTransaction = {
  id: string;
  date: string;
  amount: number;
  approved: boolean;
  cleared: string;
  memo?: string | null;
  payee_name?: string | null;
  import_payee_name?: string | null;
  import_payee_name_original?: string | null;
  account_id: string;
  account_name?: string | null;
  category_id?: string | null;
  category_name?: string | null;
  deleted: boolean;
};

function parseTransaction(transaction: YnabApiTransaction): YnabTransaction {
  return {
    id: transaction.id,
    date: transaction.date,
    amountMilliunits: transaction.amount,
    amountCents: milliunitsToCents(transaction.amount),
    approved: transaction.approved,
    cleared: transaction.cleared,
    memo: transaction.memo ?? null,
    payeeName: transaction.payee_name ?? null,
    importPayeeName: transaction.import_payee_name ?? null,
    importPayeeNameOriginal: transaction.import_payee_name_original ?? null,
    accountId: transaction.account_id,
    accountName: transaction.account_name ?? null,
    categoryId: transaction.category_id ?? null,
    categoryName: transaction.category_name ?? null,
    deleted: transaction.deleted,
  };
}

export async function resolveAccount(client: YnabClient, planId: string, accountId?: string | null, accountName?: string | null) {
  const accounts = await client.listAccounts(planId);

  if (accountId) {
    const matched = accounts.find((account) => account.id === accountId);
    if (!matched) {
      throw new Error(`No YNAB account found with id ${accountId}.`);
    }
    return matched;
  }

  if (!accountName) {
    throw new Error("No account selected. Set YNAB_ACCOUNT_NAME or pass --account-name.");
  }

  const normalized = normalizeText(accountName);
  const exact = accounts.find((account) => normalizeText(account.name) === normalized);
  if (exact) {
    return exact;
  }

  const partial = accounts.filter((account) => normalizeText(account.name).includes(normalized));
  if (partial.length === 1) {
    return partial[0];
  }

  if (partial.length > 1) {
    throw new Error(`Multiple YNAB accounts matched "${accountName}". Use --account-id instead.`);
  }

  throw new Error(`No YNAB account matched "${accountName}".`);
}
