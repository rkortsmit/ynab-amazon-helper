import type {
  AnalysisDecisionStatus,
  AnalysisTransaction,
  CategorySuggestion,
  LearnedCategoryCount,
  LearnedRule,
  SuggestionEvidence,
  YnabCategory,
  YnabTransaction,
} from "./types.ts";
import { isAmazonishTransaction } from "./match.ts";
import { hasRealCategory } from "./ynab.ts";
import { normalizeText, normalizeTitle } from "./utils.ts";

type GenericHistoryExample = {
  transactionId: string;
  transactionDate: string;
  accountId: string;
  accountName: string;
  amountCents: number;
  signedAmountCents: number;
  categoryId: string;
  categoryName: string;
  payee: string;
  payeeKey: string;
  memoKey: string | null;
  payeeMemoKey: string | null;
  accountPayeeKey: string | null;
};

export type GenericHistory = {
  updatedAt: string;
  sinceDate: string;
  historyTransactions: number;
  categorizedTransactions: number;
  exactPayeeRules: LearnedRule[];
  exactAccountPayeeRules: LearnedRule[];
  exactPayeeMemoRules: LearnedRule[];
  historyExamples: GenericHistoryExample[];
};

type CategoryCounter = Map<
  string,
  {
    categoryId: string;
    categoryName: string;
    count: number;
    lastSeen: string;
  }
>;

function transactionPayee(transaction: YnabTransaction): string {
  return (
    transaction.importPayeeNameOriginal ??
    transaction.importPayeeName ??
    transaction.payeeName ??
    "(no payee)"
  );
}

function normalizePayeeKey(transaction: YnabTransaction): string {
  return normalizeTitle(transactionPayee(transaction));
}

function normalizeMemoKey(transaction: YnabTransaction): string | null {
  const normalized = normalizeTitle(transaction.memo);
  return normalized || null;
}

function payeeMemoKey(payeeKey: string, memoKey: string | null): string | null {
  if (!payeeKey || !memoKey) {
    return null;
  }

  return `${payeeKey}::${memoKey}`;
}

function accountPayeeKey(accountId: string, payeeKey: string): string | null {
  if (!accountId || !payeeKey) {
    return null;
  }

  return `${accountId}::${payeeKey}`;
}

function accumulate(
  counterMap: Map<string, CategoryCounter>,
  key: string | null,
  categoryId: string,
  categoryName: string,
  transactionDate: string,
): void {
  if (!key) {
    return;
  }

  let categoryCounts = counterMap.get(key);
  if (!categoryCounts) {
    categoryCounts = new Map();
    counterMap.set(key, categoryCounts);
  }

  const existing = categoryCounts.get(categoryId);
  if (existing) {
    existing.count += 1;
    if (transactionDate > existing.lastSeen) {
      existing.lastSeen = transactionDate;
    }
    return;
  }

  categoryCounts.set(categoryId, {
    categoryId,
    categoryName,
    count: 1,
    lastSeen: transactionDate,
  });
}

function counterMapToRules(counterMap: Map<string, CategoryCounter>): LearnedRule[] {
  return [...counterMap.entries()]
    .map(([key, categoryCounts]) => {
      const categories: LearnedCategoryCount[] = [...categoryCounts.values()].sort((left, right) => {
        if (right.count !== left.count) {
          return right.count - left.count;
        }

        return right.lastSeen.localeCompare(left.lastSeen);
      });

      const top = categories[0] ?? null;
      const totalExamples = categories.reduce((sum, category) => sum + category.count, 0);

      return {
        key,
        topCategoryId: top?.categoryId ?? null,
        topCategoryName: top?.categoryName ?? null,
        topCount: top?.count ?? 0,
        totalExamples,
        uniqueCategories: categories.length,
        categories,
      } satisfies LearnedRule;
    })
    .sort((left, right) => {
      if (right.topCount !== left.topCount) {
        return right.topCount - left.topCount;
      }

      return right.totalExamples - left.totalExamples;
    });
}

function buildHistoryExample(transaction: YnabTransaction): GenericHistoryExample | null {
  if (
    transaction.deleted ||
    !transaction.approved ||
    transaction.amountCents === 0 ||
    !transaction.categoryId ||
    !transaction.categoryName ||
    !hasRealCategory(transaction) ||
    isAmazonishTransaction(transaction)
  ) {
    return null;
  }

  const payee = transactionPayee(transaction);
  const payeeKey = normalizeTitle(payee);
  if (!payeeKey) {
    return null;
  }

  const memoKey = normalizeMemoKey(transaction);
  return {
    transactionId: transaction.id,
    transactionDate: transaction.date,
    accountId: transaction.accountId,
    accountName: transaction.accountName ?? "(unknown account)",
    amountCents: Math.abs(transaction.amountCents),
    signedAmountCents: transaction.amountCents,
    categoryId: transaction.categoryId,
    categoryName: transaction.categoryName,
    payee,
    payeeKey,
    memoKey,
    payeeMemoKey: payeeMemoKey(payeeKey, memoKey),
    accountPayeeKey: accountPayeeKey(transaction.accountId, payeeKey),
  };
}

export function buildGenericHistory(transactions: YnabTransaction[], sinceDate: string): GenericHistory {
  const historyExamples = transactions
    .map((transaction) => buildHistoryExample(transaction))
    .filter((example): example is GenericHistoryExample => example !== null);

  const exactPayeeCounters = new Map<string, CategoryCounter>();
  const exactAccountPayeeCounters = new Map<string, CategoryCounter>();
  const exactPayeeMemoCounters = new Map<string, CategoryCounter>();

  for (const example of historyExamples) {
    accumulate(exactPayeeCounters, example.payeeKey, example.categoryId, example.categoryName, example.transactionDate);
    accumulate(
      exactAccountPayeeCounters,
      example.accountPayeeKey,
      example.categoryId,
      example.categoryName,
      example.transactionDate,
    );
    accumulate(
      exactPayeeMemoCounters,
      example.payeeMemoKey,
      example.categoryId,
      example.categoryName,
      example.transactionDate,
    );
  }

  return {
    updatedAt: new Date().toISOString(),
    sinceDate,
    historyTransactions: transactions.length,
    categorizedTransactions: historyExamples.length,
    exactPayeeRules: counterMapToRules(exactPayeeCounters),
    exactAccountPayeeRules: counterMapToRules(exactAccountPayeeCounters),
    exactPayeeMemoRules: counterMapToRules(exactPayeeMemoCounters),
    historyExamples,
  };
}

function addSuggestion(
  suggestions: Map<string, CategorySuggestion>,
  categoryId: string,
  categoryName: string,
  evidence: SuggestionEvidence,
): void {
  const existing = suggestions.get(categoryId);
  if (existing) {
    existing.score += evidence.score;
    existing.evidences.push(evidence);
    return;
  }

  suggestions.set(categoryId, {
    categoryId,
    categoryName,
    score: evidence.score,
    evidences: [evidence],
  });
}

function ruleForKey(rules: LearnedRule[], key: string | null): LearnedRule | null {
  if (!key) {
    return null;
  }

  return rules.find((rule) => rule.key === key) ?? null;
}

function requiresMemoSpecificity(payeeKey: string): boolean {
  return [
    "venmo",
    "paypal",
    "check",
    "zelle",
    "cash app",
    "cashapp",
    "apple cash",
    "square",
  ].some((pattern) => payeeKey.includes(pattern));
}

export function isTransferLikeTransaction(transaction: YnabTransaction): boolean {
  const haystack = normalizeText(
    [transactionPayee(transaction), transaction.memo, transaction.importPayeeNameOriginal].filter(Boolean).join(" "),
  );

  if (!haystack) {
    return false;
  }

  return [
    "transfer",
    "xfer",
    "autopay",
    "auto pay",
    "payment thank you",
    "online payment",
    "credit card payment",
    "mobile transfer",
    "internal transfer",
    "ach payment",
  ].some((pattern) => haystack.includes(pattern));
}

function applyRuleSuggestions(
  suggestions: Map<string, CategorySuggestion>,
  rule: LearnedRule | null,
  input: {
    type: SuggestionEvidence["type"];
    detailPrefix: string;
    repeatedBase: number;
    singleBase: number;
    perCount: number;
    dampen?: number;
  },
): void {
  if (!rule) {
    return;
  }

  for (const category of rule.categories) {
    const dominance = category.count / rule.totalExamples;
    const base = rule.topCount >= 2 ? input.repeatedBase : input.singleBase;
    const dampen = input.dampen ?? 1;
    const score = Math.round((base * dominance + category.count * input.perCount) * dampen);
    addSuggestion(suggestions, category.categoryId, category.categoryName, {
      type: input.type,
      detail: `${input.detailPrefix} ${category.count}/${rule.totalExamples} time(s) in ${category.categoryName}`,
      score,
    });
  }
}

function applyRefundMatchSuggestions(
  suggestions: Map<string, CategorySuggestion>,
  history: GenericHistory,
  transaction: YnabTransaction,
  payeeKey: string,
): void {
  if (transaction.amountCents <= 0 || !payeeKey) {
    return;
  }

  const matches = history.historyExamples.filter(
    (example) =>
      example.accountId === transaction.accountId &&
      example.payeeKey === payeeKey &&
      example.signedAmountCents < 0 &&
      example.amountCents === transaction.amountCents,
  );

  if (matches.length === 0) {
    return;
  }

  const byCategory = new Map<
    string,
    {
      categoryId: string;
      categoryName: string;
      count: number;
    }
  >();

  for (const match of matches) {
    const existing = byCategory.get(match.categoryId);
    if (existing) {
      existing.count += 1;
      continue;
    }

    byCategory.set(match.categoryId, {
      categoryId: match.categoryId,
      categoryName: match.categoryName,
      count: 1,
    });
  }

  for (const category of byCategory.values()) {
    addSuggestion(suggestions, category.categoryId, category.categoryName, {
      type: "history_refund_match",
      detail: `refund matched ${category.count} prior ${transactionPayee(transaction)} charge(s) with the same amount`,
      score: 780 + category.count * 40,
    });
  }
}

function sortSuggestions(
  suggestions: Map<string, CategorySuggestion>,
  categories: YnabCategory[],
): CategorySuggestion[] {
  const categoryById = new Map(categories.map((category) => [category.id, category]));

  return [...suggestions.values()]
    .filter((suggestion) => {
      const category = categoryById.get(suggestion.categoryId);
      return category ? !category.deleted : true;
    })
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }

      return left.categoryName.localeCompare(right.categoryName);
    })
    .slice(0, 5);
}

function decideGenericAction(input: {
  transaction: YnabTransaction;
  payeeKey: string;
  suggestions: CategorySuggestion[];
}): {
  status: AnalysisDecisionStatus;
  shouldApprove: boolean;
  proposedCategoryId: string | null;
  proposedCategoryName: string | null;
  rationale: string[];
} {
  if (isTransferLikeTransaction(input.transaction)) {
    return {
      status: "needs_review",
      shouldApprove: false,
      proposedCategoryId: null,
      proposedCategoryName: null,
      rationale: ["Transaction looks like a transfer or card payment, so it was not auto-categorized."],
    };
  }

  if (input.suggestions.length === 0) {
    return {
      status: "no_match",
      shouldApprove: false,
      proposedCategoryId: null,
      proposedCategoryName: null,
      rationale: ["No reliable category history was found for this non-Amazon transaction yet."],
    };
  }

  const top = input.suggestions[0];
  const second = input.suggestions[1];
  const gap = top.score - (second?.score ?? 0);
  const payeeNeedsMemo = requiresMemoSpecificity(input.payeeKey);
  const hasRefundMatch = top.evidences.some((evidence) => evidence.type === "history_refund_match" && evidence.score >= 780);
  const hasPayeeMemoRule = top.evidences.some(
    (evidence) => evidence.type === "history_exact_payee_memo" && evidence.score >= 520,
  );
  const hasAccountPayeeRule = top.evidences.some(
    (evidence) => evidence.type === "history_exact_account_payee" && evidence.score >= 500,
  );
  const hasPayeeRule = top.evidences.some((evidence) => evidence.type === "history_exact_payee" && evidence.score >= 520);

  const autoApply =
    (hasRefundMatch && gap >= 160) ||
    (hasPayeeMemoRule && gap >= 160) ||
    (!payeeNeedsMemo && hasAccountPayeeRule && gap >= 180) ||
    (!payeeNeedsMemo && hasPayeeRule && gap >= 220);

  return {
    status: autoApply ? "auto_apply" : "needs_review",
    shouldApprove: autoApply,
    proposedCategoryId: top.categoryId,
    proposedCategoryName: top.categoryName,
    rationale: [
      `Generic payee analysis for ${transactionPayee(input.transaction)}.`,
      ...top.evidences.slice(0, 3).map((evidence) => evidence.detail),
      ...(payeeNeedsMemo ? ["Payee often needs memo-level context, so payee-only matches are treated cautiously."] : []),
    ],
  };
}

export function buildGenericAnalysisTransactions(input: {
  transactions: YnabTransaction[];
  categories: YnabCategory[];
  history: GenericHistory;
}): AnalysisTransaction[] {
  return input.transactions
    .filter((transaction) => !transaction.deleted && transaction.amountCents !== 0)
    .filter((transaction) => !isAmazonishTransaction(transaction))
    .map((transaction) => {
      const payee = transactionPayee(transaction);
      const payeeKey = normalizePayeeKey(transaction);
      const memoKey = normalizeMemoKey(transaction);
      const suggestionsMap = new Map<string, CategorySuggestion>();

      if (!isTransferLikeTransaction(transaction)) {
        if (transaction.amountCents > 0) {
          applyRefundMatchSuggestions(suggestionsMap, input.history, transaction, payeeKey);
        } else {
          const memoSpecific = requiresMemoSpecificity(payeeKey);
          applyRuleSuggestions(suggestionsMap, ruleForKey(input.history.exactPayeeMemoRules, payeeMemoKey(payeeKey, memoKey)), {
            type: "history_exact_payee_memo",
            detailPrefix: "exact payee+memo seen",
            repeatedBase: 520,
            singleBase: 240,
            perCount: 45,
          });
          applyRuleSuggestions(
            suggestionsMap,
            ruleForKey(input.history.exactAccountPayeeRules, accountPayeeKey(transaction.accountId, payeeKey)),
            {
              type: "history_exact_account_payee",
              detailPrefix: "same account payee seen",
              repeatedBase: 420,
              singleBase: 250,
              perCount: 40,
              dampen: memoSpecific ? 0.6 : 1,
            },
          );
          applyRuleSuggestions(suggestionsMap, ruleForKey(input.history.exactPayeeRules, payeeKey), {
            type: "history_exact_payee",
            detailPrefix: "payee seen",
            repeatedBase: 420,
            singleBase: 180,
            perCount: 40,
            dampen: memoSpecific ? 0.35 : 1,
          });
        }
      }

      const suggestions = sortSuggestions(suggestionsMap, input.categories);
      const decision = decideGenericAction({
        transaction,
        payeeKey,
        suggestions,
      });

      return {
        transactionId: transaction.id,
        accountId: transaction.accountId,
        accountName: transaction.accountName ?? "(unknown account)",
        workflow: "generic",
        transactionDate: transaction.date,
        signedAmountCents: transaction.amountCents,
        amountCents: Math.abs(transaction.amountCents),
        payee,
        memo: transaction.memo ?? null,
        bestMatch: null,
        ambiguous: false,
        suggestions,
        decision: {
          status: decision.status,
          shouldApprove: decision.shouldApprove,
          proposedCategoryId: decision.proposedCategoryId,
          proposedCategoryName: decision.proposedCategoryName,
          selectedCategoryId: null,
          selectedCategoryName: null,
          rationale: decision.rationale,
        },
      } satisfies AnalysisTransaction;
    });
}
