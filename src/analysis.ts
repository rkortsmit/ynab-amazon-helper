import type {
  AnalysisBundle,
  AnalysisDecisionStatus,
  AnalysisTransaction,
  CategorySuggestion,
  ManualOverrideRule,
  MemoryStore,
  SuggestionEvidence,
  TransactionMatch,
  YnabAccount,
  YnabCategory,
} from "./types.ts";
import { fingerprintOrder } from "./memory.ts";
import { normalizeTitle } from "./utils.ts";

function transactionPayee(match: TransactionMatch): string {
  return (
    match.transaction.importPayeeNameOriginal ??
    match.transaction.importPayeeName ??
    match.transaction.payeeName ??
    "(no payee)"
  );
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

function exactOverrideScore(type: ManualOverrideRule["type"]): number {
  switch (type) {
    case "exact_fingerprint":
      return 1000;
    case "exact_item":
      return 700;
    case "contains_title":
      return 420;
  }
}

function applyOverrides(
  suggestions: Map<string, CategorySuggestion>,
  memory: MemoryStore,
  normalizedItems: string[],
  fingerprint: string | null,
): void {
  if (fingerprint) {
    for (const rule of memory.overrides.exactFingerprintRules) {
      if (rule.normalizedMatch === fingerprint) {
        addSuggestion(suggestions, rule.categoryId, rule.categoryName, {
          type: "override_exact_fingerprint",
          detail: `manual fingerprint override: ${rule.match}`,
          score: exactOverrideScore(rule.type),
        });
      }
    }
  }

  for (const item of normalizedItems) {
    for (const rule of memory.overrides.exactItemRules) {
      if (rule.normalizedMatch === item) {
        addSuggestion(suggestions, rule.categoryId, rule.categoryName, {
          type: "override_exact_item",
          detail: `manual item override: ${rule.match}`,
          score: exactOverrideScore(rule.type),
        });
      }
    }

    for (const rule of memory.overrides.containsTitleRules) {
      if (item.includes(rule.normalizedMatch)) {
        addSuggestion(suggestions, rule.categoryId, rule.categoryName, {
          type: "override_contains_title",
          detail: `manual title contains override: ${rule.match}`,
          score: exactOverrideScore(rule.type),
        });
      }
    }
  }
}

function applyLearnedFingerprintRule(
  suggestions: Map<string, CategorySuggestion>,
  memory: MemoryStore,
  fingerprint: string | null,
): void {
  if (!fingerprint) {
    return;
  }

  const rule = memory.learned.exactFingerprintRules.find((candidate) => candidate.key === fingerprint);
  if (!rule) {
    return;
  }

  for (const category of rule.categories) {
    const dominance = category.count / rule.totalExamples;
    const repeatedUnique = rule.uniqueCategories === 1 && rule.totalExamples >= 2;
    const score = repeatedUnique
      ? Math.round(320 * dominance + category.count * 30)
      : Math.round((rule.uniqueCategories === 1 ? 200 : 150) * dominance + category.count * 20);
    addSuggestion(suggestions, category.categoryId, category.categoryName, {
      type: "learned_exact_fingerprint",
      detail: `exact order seen ${category.count}/${rule.totalExamples} time(s) in ${category.categoryName}`,
      score,
    });
  }
}

function applyLearnedItemRules(
  suggestions: Map<string, CategorySuggestion>,
  memory: MemoryStore,
  normalizedItems: string[],
): void {
  for (const item of normalizedItems) {
    const rule = memory.learned.exactItemRules.find((candidate) => candidate.key === item);
    if (!rule) {
      continue;
    }

    for (const category of rule.categories) {
      const dominance = category.count / rule.totalExamples;
      const score = Math.round((rule.topCount >= 2 ? 150 : 70) * dominance + category.count * 18);
      addSuggestion(suggestions, category.categoryId, category.categoryName, {
        type: "learned_exact_item",
        detail: `item seen ${category.count}/${rule.totalExamples} time(s) in ${category.categoryName}: ${item}`,
        score,
      });
    }
  }
}

function applyHistoryOrderNumberRule(
  suggestions: Map<string, CategorySuggestion>,
  memory: MemoryStore,
  orderNumber: string | null,
): void {
  if (!orderNumber) {
    return;
  }

  const matchingExamples = memory.historyExamples.filter((example) => example.orderNumber === orderNumber);
  if (matchingExamples.length === 0) {
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

  for (const example of matchingExamples) {
    const existing = byCategory.get(example.categoryId);
    if (existing) {
      existing.count += 1;
      continue;
    }

    byCategory.set(example.categoryId, {
      categoryId: example.categoryId,
      categoryName: example.categoryName,
      count: 1,
    });
  }

  for (const category of byCategory.values()) {
    addSuggestion(suggestions, category.categoryId, category.categoryName, {
      type: "history_exact_order_number",
      detail: `order ${orderNumber} previously categorized ${category.count} time(s) as ${category.categoryName}`,
      score: 520 + category.count * 25,
    });
  }
}

function sortSuggestions(
  suggestions: Map<string, CategorySuggestion>,
  categoryById: Map<string, YnabCategory>,
): CategorySuggestion[] {
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

function decideAction(match: TransactionMatch, suggestions: CategorySuggestion[]): {
  status: AnalysisDecisionStatus;
  shouldApprove: boolean;
  proposedCategoryId: string | null;
  proposedCategoryName: string | null;
  rationale: string[];
} {
  if (!match.best) {
    return {
      status: "no_match",
      shouldApprove: false,
      proposedCategoryId: null,
      proposedCategoryName: null,
      rationale: ["No Amazon order match was found in the local cache."],
    };
  }

  if (suggestions.length === 0) {
    return {
      status: "needs_review",
      shouldApprove: false,
      proposedCategoryId: null,
      proposedCategoryName: null,
      rationale: ["Amazon order matched, but no learned category evidence was found yet."],
    };
  }

  const top = suggestions[0];
  const second = suggestions[1];
  const gap = top.score - (second?.score ?? 0);
  const hasManualOverride = top.evidences.some((evidence) => evidence.type.startsWith("override_"));
  const hasExactOrderHistory = top.evidences.some(
    (evidence) => evidence.type === "history_exact_order_number" && evidence.score >= 520,
  );
  const hasStrongFingerprintHistory = top.evidences.some(
    (evidence) => evidence.type === "learned_exact_fingerprint" && evidence.score >= 320,
  );
  const multipleSupportingEvidences = top.evidences.length >= 2;
  const matchReliable = !match.ambiguous && match.best.confidence !== "weak";

  const rationale = [
    `Amazon match confidence ${match.best.confidence} via ${match.best.amountSource}.`,
    ...match.best.reasons,
    ...top.evidences.slice(0, 3).map((evidence) => evidence.detail),
  ];

  const autoApply =
    matchReliable &&
    gap >= 140 &&
    (hasManualOverride ||
      hasExactOrderHistory ||
      hasStrongFingerprintHistory ||
      (multipleSupportingEvidences && top.score >= 420));

  return {
    status: autoApply ? "auto_apply" : "needs_review",
    shouldApprove: autoApply,
    proposedCategoryId: top.categoryId,
    proposedCategoryName: top.categoryName,
    rationale,
  };
}

export function buildAnalysisBundle(input: {
  account: YnabAccount;
  categories: YnabCategory[];
  memory: MemoryStore;
  matches: TransactionMatch[];
  pendingSinceDate: string;
}): AnalysisBundle {
  const categoryById = new Map(input.categories.map((category) => [category.id, category]));

  const transactions: AnalysisTransaction[] = input.matches.map((match) => {
    const fingerprint = fingerprintOrder(match.best);
    const normalizedItems = match.best
      ? match.best.order.itemTitles.map((item) => normalizeTitle(item)).filter(Boolean)
      : [];
    const suggestionsMap = new Map<string, CategorySuggestion>();

    if (match.best) {
      applyOverrides(suggestionsMap, input.memory, normalizedItems, fingerprint);
      applyHistoryOrderNumberRule(suggestionsMap, input.memory, match.best.order.orderNumber);
      applyLearnedFingerprintRule(suggestionsMap, input.memory, fingerprint);
      applyLearnedItemRules(suggestionsMap, input.memory, normalizedItems);
    }

    const suggestions = sortSuggestions(suggestionsMap, categoryById);
    const decision = decideAction(match, suggestions);

    return {
      transactionId: match.transaction.id,
      transactionDate: match.transaction.date,
      signedAmountCents: match.transaction.amountCents,
      amountCents: Math.abs(match.transaction.amountCents),
      payee: transactionPayee(match),
      memo: match.transaction.memo ?? null,
      bestMatch: match.best,
      ambiguous: match.ambiguous,
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
    };
  });

  const summary = {
    autoApply: transactions.filter((transaction) => transaction.decision.status === "auto_apply").length,
    needsReview: transactions.filter((transaction) => transaction.decision.status === "needs_review").length,
    noMatch: transactions.filter((transaction) => transaction.decision.status === "no_match").length,
  };

  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    account: {
      id: input.account.id,
      name: input.account.name,
    },
    source: {
      pendingSinceDate: input.pendingSinceDate,
      historySinceDate: input.memory.source.sinceDate,
      pendingTransactions: transactions.length,
      cachedOrders: input.memory.source.cachedOrders,
    },
    categories: input.categories.filter((category) => !category.deleted),
    memory: {
      updatedAt: input.memory.updatedAt,
      exactItemRules: input.memory.learned.exactItemRules.length,
      exactFingerprintRules: input.memory.learned.exactFingerprintRules.length,
      historyExamples: input.memory.historyExamples.length,
    },
    summary,
    transactions,
  };
}
