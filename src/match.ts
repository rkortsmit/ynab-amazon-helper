import type { AmazonOrder, MatchCandidate, TransactionMatch, YnabTransaction } from "./types.ts";
import { daysBetween, normalizeText, uniq } from "./utils.ts";

function amountCandidates(order: AmazonOrder): Array<{ cents: number; source: "charge" | "order_total" }> {
  const chargeCandidates = order.chargeAmountsCents.map((cents) => ({ cents, source: "charge" as const }));
  const totalCandidate = order.orderTotalCents === null ? [] : [{ cents: order.orderTotalCents, source: "order_total" as const }];
  return [...chargeCandidates, ...totalCandidate];
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

export function matchTransactions(transactions: YnabTransaction[], orders: AmazonOrder[]): TransactionMatch[] {
  return transactions.map((transaction) => {
    const candidates = orders
      .map((order) => scoreCandidate(transaction, order))
      .filter((candidate): candidate is MatchCandidate => candidate !== null)
      .sort((left, right) => right.score - left.score)
      .slice(0, 5);

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

    const haystack = uniq([
      normalizeText(transaction.payeeName),
      normalizeText(transaction.importPayeeName),
      normalizeText(transaction.importPayeeNameOriginal),
      normalizeText(transaction.memo),
    ]).join(" ");

    return haystack.includes("amazon") || haystack.length === 0;
  });
}
