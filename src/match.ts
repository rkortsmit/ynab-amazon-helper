import type { AmazonOrder, AmazonPaymentTransaction, MatchCandidate, TransactionMatch, YnabTransaction } from "./types.ts";
import { daysBetween, normalizeText, uniq } from "./utils.ts";

// How far apart a YNAB charge and an Amazon date may be before it isn't treated as a match.
const MAX_PAYMENT_DAYS = 10; // YNAB date vs. Your Payments entry date
const MAX_DAYS_BEFORE_ORDER = 3; // charge dated before the order (time-zone/posting slack)
const MAX_DAYS_AFTER_ORDER = 45; // backordered or slow-shipping items get charged when they ship
const WEAK_AFTER_DAYS = 14; // still allowed, but only as a weak match you confirm yourself

export function isAmazonishTransaction(transaction: YnabTransaction): boolean {
  // A transfer between your own accounts (e.g. paying the Amazon card) is never an Amazon purchase.
  if (transaction.transferAccountId) {
    return false;
  }

  const haystack = uniq([
    normalizeText(transaction.payeeName),
    normalizeText(transaction.importPayeeName),
    normalizeText(transaction.importPayeeNameOriginal),
    normalizeText(transaction.memo),
  ]).join(" ");

  // "amzn" covers bank-imported names like "AMZN Mktp US*1A2B3" that never spell out "amazon".
  return haystack.includes("amazon") || haystack.includes("amzn") || haystack.length === 0;
}

// Two candidates are the same order only when both carry the same order number. Placeholder
// payments without an order number share a generic URL, so they must never be treated as one order.
function isSameOrder(left: MatchCandidate, right: MatchCandidate): boolean {
  return left.order.orderNumber !== null && left.order.orderNumber === right.order.orderNumber;
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

  // Same amount but the wrong time: a card charge can't come well before the order, and one that
  // lands months later is almost always a different purchase that happens to cost the same.
  if (order.orderDate && dayDelta !== null) {
    const chargedAfterOrder = transaction.date >= order.orderDate;
    if ((!chargedAfterOrder && dayDelta > MAX_DAYS_BEFORE_ORDER) || (chargedAfterOrder && dayDelta > MAX_DAYS_AFTER_ORDER)) {
      return null;
    }
  }

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

  const farApart = dayDelta === null || dayDelta > WEAK_AFTER_DAYS;
  const confidence: MatchCandidate["confidence"] =
    farApart ? "weak" : score >= 150 ? "strong" : score >= 125 ? "medium" : "weak";

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
  // A payments-page entry is dated the day the card was charged, so it should sit within days of YNAB's date.
  if (dayDelta !== null && dayDelta > MAX_PAYMENT_DAYS) {
    return null;
  }
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

  // Index by amount so each transaction only scores the orders/payments that could possibly match,
  // instead of every order and payment. Buckets keep the input order, so results are unchanged.
  const ordersByCents = new Map<number, AmazonOrder[]>();
  for (const order of orders) {
    for (const cents of new Set(amountCandidates(order).map((candidate) => candidate.cents))) {
      const bucket = ordersByCents.get(cents);
      if (bucket) {
        bucket.push(order);
      } else {
        ordersByCents.set(cents, [order]);
      }
    }
  }

  const paymentsByCents = new Map<number, AmazonPaymentTransaction[]>();
  for (const payment of paymentTransactions) {
    const bucket = paymentsByCents.get(payment.amountCents);
    if (bucket) {
      bucket.push(payment);
    } else {
      paymentsByCents.set(payment.amountCents, [payment]);
    }
  }

  return transactions.map((transaction) => {
    const candidateMap = new Map<string, MatchCandidate>();

    for (const order of ordersByCents.get(Math.abs(transaction.amountCents)) ?? []) {
      const candidate = scoreCandidate(transaction, order);
      if (!candidate) {
        continue;
      }
      const key = `${orderKey(candidate.order)}::${candidate.amountSource}`;
      const existing = candidateMap.get(key);
      if (!existing || candidate.score > existing.score) {
        candidateMap.set(key, candidate);
      }
    }

    for (const payment of paymentsByCents.get(transaction.amountCents) ?? []) {
      const candidate = scorePaymentCandidate(transaction, payment, orderLookup);
      if (!candidate) {
        continue;
      }
      const key = `${orderKey(candidate.order)}::payment_transaction::${candidate.dayDelta ?? "na"}::${Math.abs(transaction.amountCents)}`;
      const existing = candidateMap.get(key);
      if (!existing || candidate.score > existing.score) {
        candidateMap.set(key, candidate);
      }
    }

    const sorted = [...candidateMap.values()].sort((left, right) => right.score - left.score);
    const candidates = sorted.slice(0, 5);

    const best = candidates[0] ?? null;
    // Only a different order counts as a rival. Several entries for the same order (e.g. two
    // payments-page rows on neighbouring days) are the same purchase, not an ambiguous match.
    const rival = best ? sorted.find((candidate) => candidate !== best && !isSameOrder(candidate, best)) ?? null : null;
    const ambiguous = Boolean(best && rival && best.score - rival.score < 15);

    return {
      transaction,
      candidates,
      best,
      ambiguous,
    };
  });
}
