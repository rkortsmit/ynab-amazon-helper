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
  // Set when this is one side of a transfer between two of your accounts.
  transferAccountId?: string | null;
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
  // Best-effort item prices read from the order details page (may be missing if Amazon's layout isn't recognized).
  items?: AmazonOrderItem[];
  costSummary?: AmazonOrderCostSummary;
};

export type AmazonOrderItem = {
  title: string;
  unitPriceCents: number | null;
  quantity: number;
};

export type AmazonOrderCostSummary = {
  subtotalCents: number | null;
  shippingCents: number | null;
  taxCents: number | null;
  totalCents: number | null;
  strategy: string;
};

export type AmazonPaymentTransaction = {
  profile: string;
  marketplace: string;
  transactionDate: string | null;
  transactionStatus: "completed" | "in_progress" | "pending" | "unknown";
  paymentInstrument: string | null;
  paymentLast4: string | null;
  amountCents: number;
  orderNumber: string | null;
  merchant: string | null;
  kind: "charge" | "refund" | "other";
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

export type AmazonPaymentTransactionCache = {
  version: 1;
  profile: string;
  marketplace: string;
  updatedAt: string;
  transactions: AmazonPaymentTransaction[];
};

export type MatchCandidate = {
  order: AmazonOrder;
  score: number;
  confidence: "strong" | "medium" | "weak";
  amountSource: "payment_transaction" | "charge" | "order_total";
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
    | "history_exact_order_number"
    | "learned_exact_item"
    | "learned_exact_fingerprint"
    | "history_exact_payee"
    | "history_exact_account_payee"
    | "history_exact_payee_memo"
    | "history_refund_match"
    | "transfer_like";
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
  accountId: string;
  accountName: string;
  workflow: "amazon" | "generic";
  transactionDate: string;
  signedAmountCents: number;
  amountCents: number;
  payee: string;
  memo: string | null;
  bestMatch: MatchCandidate | null;
  ambiguous: boolean;
  suggestions: CategorySuggestion[];
  // True when YNAB already shows it as approved (it was pulled in because it has no category yet).
  approvedInYnab?: boolean;
  decision: {
    status: AnalysisDecisionStatus;
    shouldApprove: boolean;
    proposedCategoryId: string | null;
    proposedCategoryName: string | null;
    selectedCategoryId: string | null;
    selectedCategoryName: string | null;
    rationale: string[];
    // Set by the "split" command: one line per category. Amounts are signed like the transaction and add up to it.
    splits?: AnalysisSplit[] | null;
  };
};

export type AnalysisSplit = {
  categoryId: string;
  categoryName: string;
  amountCents: number;
  memo: string | null;
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
    pendingAccounts?: number;
  };
  categories: YnabCategory[];
  memory: {
    updatedAt: string;
    exactItemRules: number;
    exactFingerprintRules: number;
    historyExamples: number;
    exactPayeeRules?: number;
    exactAccountPayeeRules?: number;
    exactPayeeMemoRules?: number;
    genericHistoryExamples?: number;
  };
  summary: {
    autoApply: number;
    needsReview: number;
    noMatch: number;
  };
  transactions: AnalysisTransaction[];
};
