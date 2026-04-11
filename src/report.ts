import type { MatchCandidate, TransactionMatch } from "./types.ts";
import { centsToCurrency } from "./utils.ts";

export function getTransactionPayee(match: TransactionMatch): string {
  return (
    match.transaction.importPayeeNameOriginal ??
    match.transaction.importPayeeName ??
    match.transaction.payeeName ??
    "(no payee)"
  );
}

export function summarizeCandidate(candidate: MatchCandidate): string {
  const items = candidate.order.itemTitles.slice(0, 3).join(" | ") || "(no item titles captured)";
  const orderDate = candidate.order.orderDate ?? "unknown";
  const orderNumber = candidate.order.orderNumber ?? "unknown";
  return [
    `profile=${candidate.order.profile}`,
    `order=${orderNumber}`,
    `order_date=${orderDate}`,
    `match=${candidate.amountSource}`,
    `score=${candidate.score}`,
    `items=${items}`,
  ].join("  ");
}

export function printMatchReport(matches: TransactionMatch[]): void {
  if (matches.length === 0) {
    console.log("No candidate transactions found.");
    return;
  }

  for (const match of matches) {
    const amount = centsToCurrency(Math.abs(match.transaction.amountCents));
    const payee = getTransactionPayee(match);
    console.log("");
    console.log(`${match.transaction.date}  ${amount}  ${payee}`);

    if (!match.best) {
      console.log("  No Amazon order match found in the local cache.");
      continue;
    }

    const prefix = match.ambiguous ? "  Possible match" : "  Best match";
    console.log(`${prefix}: ${summarizeCandidate(match.best)}`);

    if (match.ambiguous) {
      const alternates = match.candidates.slice(1, 3);
      for (const alternate of alternates) {
        console.log(`  Alternate: ${summarizeCandidate(alternate)}`);
      }
    }
  }
}

export function printMatchesAsJson(matches: TransactionMatch[]): void {
  console.log(JSON.stringify(matches, null, 2));
}
