import type { AmazonOrder, AmazonPaymentTransaction, MatchCandidate, TransactionMatch, YnabTransaction } from "./types.ts";
import { daysBetween, normalizeText, uniq } from "./utils.ts";

export function isAmazonishTransaction(transaction: YnabTransaction): boolean {
  const haystack = uniq([
    normalizeText(transaction.payeeName),
    normalizeText(transaction.importPayeeName),
    normalizeText(transaction.importPayeeNameOriginal),
    normalizeText(transaction.memo),
  ]).join(" ");

  return haystack.includes("amazon") || haystack.length === 0;
}

function amountCandidates(order: AmazonOrder): Array<{ cents: number; source: "charge" | "order_total" }> {
  const chargeCandidates = order.chargeAmountsCents.map((cents) => ({ cents, source: "charge" as const }));
  const totalCandidate = order.orderTotalCents === null ? [] : [{ cents: order.orderTotalCents, source: "order_total" as const }];
  return [...chargeCandidates, ...totalCandidate];
}

function orderKey(order: AmazonOrder): string {
  return order.orderNumber ?? order.detailUrl;
}

function placeholderOrderFromPayment(transaction: AmazonPaymentTransaction): AmazonOrder {
  const detailUrl = transaction.orderNumber
    ? new URL(`/your-orders/order-details`, transaction.marketplace).toString() + `?orderID=${transaction.orderNumber}`
    : new URL("/cpe/yourpayments/transactions", transaction.marketplace).toString();

  return {
    profile: transaction.profile,
    marketplace: transaction.marketplace,
    detailUrl,
    orderNumber: transaction.orderNumber,
    orderDate: transaction.transactionDate,
    orderTotalCents: Math.abs(transaction.amountCents),
    chargeAmountsCents: transaction.kind === "charge" ? [Math.abs(transaction.amountCents)] : [],
    itemTitles: [],
    paymentLast4: transaction.paymentLast4 ? [transaction.paymentLast4] : [],
    rawPreview: transaction.rawPreview,
    scrapedAt: transaction.scrapedAt,
  };
}

function scoreDate(dayDelta: number | null): number {
  if (dayDelta === null) {
    return 0;
  }

  if (dayDelta === 0) {
    return 40;
  }

  if (dayDelta === 1) {
    return 34;
  }

  if (dayDelta === 2) {
    return 28;
  }

  if (dayDelta <= 4) {
    return 18;
  }

  if (dayDelta <= 7) {
    return 10;
  }

  if (dayDelta <= 14) {
    return 4;
  }

  return 0;
}

function scoreCandidate(transaction: YnabTransaction, order: AmazonOrder): MatchCandidate | null {
  if (transaction.amountCents >= 0) {
    return null;
  }

  const purchaseCents = Math.abs(transaction.amountCents);
  const candidates = amountCandidates(order).filter((candidate) => candidate.cents === purchaseCents);

  if (candidates.length === 0) {
    return null;
  }

  const dayDelta = order.orderDate ? daysBetween(transaction.date, order.orderDate) : null;
  const bestAmountSource = candidates.some((candidate) => candidate.source === "charge") ? "charge" : "order_total";
  let score = bestAmountSource === "charge" ? 120 : 96;
  score += scoreDate(dayDelta);

  const reasons = [
    bestAmountSource === "charge" ? "exact charge amount match" : "exact order total match",
  ];

  if (dayDelta !== null) {
    reasons.push(`date delta ${dayDelta} day${dayDelta === 1 ? "" : "s"}`);
  }

  if (order.itemTitles.length > 0) {
    score += 2;
  }

  const confidence: MatchCandidate["confidence"] =
    score >= 150 ? "strong" : score >= 125 ? "medium" : "weak";

  return {
    order,
    score,
    confidence,
    amountSource: bestAmountSource,
    dayDelta,
    reasons,
  };
}

function scorePaymentCandidate(
  transaction: YnabTransaction,
  payment: AmazonPaymentTransaction,
  orderLookup: Map<string, AmazonOrder>,
): MatchCandidate | null {
  if (payment.amountCents !== transaction.amountCents) {
    return null;
  }

  const transactionKind =
    transaction.amountCents > 0 ? "refund" : transaction.amountCents < 0 ? "charge" : "other";

  if (payment.kind !== transactionKind) {
    return null;
  }

  const order =
    (payment.orderNumber ? orderLookup.get(payment.orderNumber) : null) ?? placeholderOrderFromPayment(payment);
  const dayDelta = payment.transactionDate ? daysBetween(transaction.date, payment.transactionDate) : null;
  let score = 150;
  score += scoreDate(dayDelta);

  const reasons = [
    payment.kind === "refund" ? "exact payments-page refund match" : "exact payments-page transaction match",
  ];

  if (dayDelta !== null) {
    reasons.push(`date delta ${dayDelta} day${dayDelta === 1 ? "" : "s"}`);
  }

  if (payment.orderNumber) {
    reasons.push(`order ${payment.orderNumber}`);
  }

  if (payment.transactionStatus === "pending") {
    reasons.push("Amazon payments entry is pending");
    score -= 6;
  }

  if (order.itemTitles.length > 0) {
    score += 2;
  }

  const confidence: MatchCandidate["confidence"] =
    score >= 165 ? "strong" : score >= 140 ? "medium" : "weak";

  return {
    order,
    score,
    confidence,
    amountSource: "payment_transaction",
    dayDelta,
    reasons,
  };
}

export function matchTransactions(
  transactions: YnabTransaction[],
  orders: AmazonOrder[],
  paymentTransactions: AmazonPaymentTransaction[] = [],
): TransactionMatch[] {
  const orderLookup = new Map(
    orders.filter((order) => Boolean(order.orderNumber)).map((order) => [order.orderNumber as string, order]),
  );

  return transactions.map((transaction) => {
    const candidateMap = new Map<string, MatchCandidate>();

    for (const candidate of orders
      .map((order) => scoreCandidate(transaction, order))
      .filter((item): item is MatchCandidate => item !== null)) {
      const key = `${orderKey(candidate.order)}::${candidate.amountSource}`;
      const existing = candidateMap.get(key);
      if (!existing || candidate.score > existing.score) {
        candidateMap.set(key, candidate);
      }
    }

    for (const candidate of paymentTransactions
      .map((payment) => scorePaymentCandidate(transaction, payment, orderLookup))
      .filter((item): item is MatchCandidate => item !== null)) {
      const key = `${orderKey(candidate.order)}::payment_transaction::${candidate.dayDelta ?? "na"}::${Math.abs(transaction.amountCents)}`;
      const existing = candidateMap.get(key);
      if (!existing || candidate.score > existing.score) {
        candidateMap.set(key, candidate);
      }
    }

    const candidates = [...candidateMap.values()].sort((left, right) => right.score - left.score).slice(0, 5);

    const best = candidates[0] ?? null;
    const second = candidates[1] ?? null;
    const ambiguous = Boolean(best && second && best.score - second.score < 15);

    return {
      transaction,
      candidates,
      best,
      ambiguous,
    };
  });
}

export function amazonishTransactions(transactions: YnabTransaction[]): YnabTransaction[] {
  return transactions.filter((transaction) => {
    if (transaction.deleted || transaction.approved || transaction.amountCents >= 0) {
      return false;
    }
    return isAmazonishTransaction(transaction);
  });
}
