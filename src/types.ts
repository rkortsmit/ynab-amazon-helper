export type YnabPlan = {
  id: string;
  name: string;
  lastModifiedOn?: string;
};

export type YnabAccount = {
  id: string;
  name: string;
  type?: string;
  onBudget?: boolean;
  closed?: boolean;
  transferPayeeId?: string | null;
};

export type YnabCategory = {
  id: string;
  name: string;
  groupId: string;
  groupName: string;
  hidden: boolean;
  deleted: boolean;
};

export type YnabTransaction = {
  id: string;
  date: string;
  amountMilliunits: number;
  amountCents: number;
  approved: boolean;
  cleared: string;
  memo: string | null;
  payeeName: string | null;
  importPayeeName: string | null;
  importPayeeNameOriginal: string | null;
  accountId: string;
  accountName: string | null;
  categoryId: string | null;
  categoryName: string | null;
  deleted: boolean;
};

export type AmazonOrder = {
  profile: string;
  marketplace: string;
  detailUrl: string;
  orderNumber: string | null;
  orderDate: string | null;
  orderTotalCents: number | null;
  chargeAmountsCents: number[];
  itemTitles: string[];
  paymentLast4: string[];
  rawPreview: string;
  scrapedAt: string;
};

export type AmazonOrderCache = {
  version: 1;
  profile: string;
  marketplace: string;
  updatedAt: string;
  orders: AmazonOrder[];
};

export type MatchCandidate = {
  order: AmazonOrder;
  score: number;
  confidence: "strong" | "medium" | "weak";
  amountSource: "charge" | "order_total";
  dayDelta: number | null;
  reasons: string[];
};

export type TransactionMatch = {
  transaction: YnabTransaction;
  candidates: MatchCandidate[];
  best: MatchCandidate | null;
  ambiguous: boolean;
};

export type LearnedCategoryCount = {
  categoryId: string;
  categoryName: string;
  count: number;
  lastSeen: string;
};

export type LearnedRule = {
  key: string;
  topCategoryId: string | null;
  topCategoryName: string | null;
  topCount: number;
  totalExamples: number;
  uniqueCategories: number;
  categories: LearnedCategoryCount[];
};

export type ManualOverrideRule = {
  id: string;
  type: "contains_title" | "exact_item" | "exact_fingerprint";
  match: string;
  normalizedMatch: string;
  categoryId: string;
  categoryName: string;
  note: string | null;
  createdAt: string;
};

export type HistoryExample = {
  transactionId: string;
  transactionDate: string;
  amountCents: number;
  categoryId: string;
  categoryName: string;
  matchConfidence: MatchCandidate["confidence"];
  orderNumber: string | null;
  profile: string;
  fingerprint: string | null;
  itemTitles: string[];
};

export type MemoryStore = {
  version: 1;
  updatedAt: string;
  source: {
    sinceDate: string;
    historyTransactions: number;
    matchedTransactions: number;
    cachedOrders: number;
  };
  overrides: {
    containsTitleRules: ManualOverrideRule[];
    exactItemRules: ManualOverrideRule[];
    exactFingerprintRules: ManualOverrideRule[];
  };
  learned: {
    exactItemRules: LearnedRule[];
    exactFingerprintRules: LearnedRule[];
  };
  historyExamples: HistoryExample[];
};

export type SuggestionEvidence = {
  type:
    | "override_contains_title"
    | "override_exact_item"
    | "override_exact_fingerprint"
    | "learned_exact_item"
    | "learned_exact_fingerprint";
  detail: string;
  score: number;
};

export type CategorySuggestion = {
  categoryId: string;
  categoryName: string;
  score: number;
  evidences: SuggestionEvidence[];
};

export type AnalysisDecisionStatus = "auto_apply" | "needs_review" | "no_match";

export type AnalysisTransaction = {
  transactionId: string;
  transactionDate: string;
  amountCents: number;
  payee: string;
  bestMatch: MatchCandidate | null;
  ambiguous: boolean;
  suggestions: CategorySuggestion[];
  decision: {
    status: AnalysisDecisionStatus;
    shouldApprove: boolean;
    proposedCategoryId: string | null;
    proposedCategoryName: string | null;
    selectedCategoryId: string | null;
    selectedCategoryName: string | null;
    rationale: string[];
  };
};

export type AnalysisBundle = {
  version: 1;
  generatedAt: string;
  account: {
    id: string;
    name: string;
  };
  source: {
    pendingSinceDate: string;
    historySinceDate: string;
    pendingTransactions: number;
    cachedOrders: number;
  };
  categories: YnabCategory[];
  memory: {
    updatedAt: string;
    exactItemRules: number;
    exactFingerprintRules: number;
    historyExamples: number;
  };
  summary: {
    autoApply: number;
    needsReview: number;
    noMatch: number;
  };
  transactions: AnalysisTransaction[];
};
