import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import type { MatchCandidate, TransactionMatch } from "./types.ts";
import { getTransactionPayee, summarizeCandidate } from "./report.ts";
import { centsToCurrency } from "./utils.ts";

export type ReviewFilter = "all" | "matched" | "unmatched" | "ambiguous";

type ReviewOptions = {
  filter: ReviewFilter;
  limit?: number;
};

type ReviewSummary = {
  total: number;
  matched: number;
  unmatched: number;
  ambiguous: number;
};

function calculateSummary(matches: TransactionMatch[]): ReviewSummary {
  return {
    total: matches.length,
    matched: matches.filter((match) => match.best).length,
    unmatched: matches.filter((match) => !match.best).length,
    ambiguous: matches.filter((match) => match.ambiguous).length,
  };
}

export function filterMatches(matches: TransactionMatch[], options: ReviewOptions): TransactionMatch[] {
  const filtered = matches.filter((match) => {
    if (options.filter === "matched") {
      return Boolean(match.best);
    }

    if (options.filter === "unmatched") {
      return !match.best;
    }

    if (options.filter === "ambiguous") {
      return match.ambiguous;
    }

    return true;
  });

  if (!options.limit || options.limit <= 0) {
    return filtered;
  }

  return filtered.slice(0, options.limit);
}

function formatCandidateLines(candidate: MatchCandidate, label: string): string[] {
  const lines: string[] = [];
  lines.push(`${label}: ${candidate.order.profile}  order ${candidate.order.orderNumber ?? "unknown"}`);
  lines.push(
    `  date ${candidate.order.orderDate ?? "unknown"}  source ${candidate.amountSource}  confidence ${candidate.confidence}  score ${candidate.score}`,
  );

  if (candidate.dayDelta !== null) {
    lines.push(`  date delta ${candidate.dayDelta} day${candidate.dayDelta === 1 ? "" : "s"}`);
  }

  if (candidate.order.orderTotalCents !== null) {
    lines.push(`  order total ${centsToCurrency(candidate.order.orderTotalCents)}`);
  }

  if (candidate.order.chargeAmountsCents.length > 0) {
    lines.push(
      `  charge amounts ${candidate.order.chargeAmountsCents.map((amount) => centsToCurrency(amount)).join(", ")}`,
    );
  }

  if (candidate.order.paymentLast4.length > 0) {
    lines.push(`  payment last4 ${candidate.order.paymentLast4.join(", ")}`);
  }

  if (candidate.order.itemTitles.length > 0) {
    lines.push("  items");
    for (const item of candidate.order.itemTitles.slice(0, 5)) {
      lines.push(`    - ${item}`);
    }
  } else {
    lines.push("  items (none captured)");
  }

  lines.push(`  url ${candidate.order.detailUrl}`);

  return lines;
}

function printReviewScreen(
  matches: TransactionMatch[],
  index: number,
  filter: ReviewFilter,
  summary: ReviewSummary,
  showAllCandidates: boolean,
): void {
  const match = matches[index];
  const amount = centsToCurrency(Math.abs(match.transaction.amountCents));
  const payee = getTransactionPayee(match);
  const best = match.best;
  const lastIndex = matches.length - 1;

  if (output.isTTY) {
    console.clear();
  }

  console.log(`Review ${index + 1}/${matches.length}  filter=${filter}`);
  console.log(
    `Totals: all=${summary.total}  matched=${summary.matched}  unmatched=${summary.unmatched}  ambiguous=${summary.ambiguous}`,
  );
  console.log("");
  console.log("Transaction");
  console.log(`  date ${match.transaction.date}`);
  console.log(`  amount ${amount}`);
  console.log(`  payee ${payee}`);
  console.log(`  cleared ${match.transaction.cleared}`);

  if (match.transaction.memo) {
    console.log(`  memo ${match.transaction.memo}`);
  }

  console.log("");

  if (!best) {
    console.log("No exact Amazon match found in the local cache.");
  } else {
    const primaryLabel = match.ambiguous ? "Possible match" : "Best match";
    for (const line of formatCandidateLines(best, primaryLabel)) {
      console.log(line);
    }
  }

  const alternateCandidates =
    showAllCandidates || match.ambiguous
      ? match.candidates.slice(best ? 1 : 0, showAllCandidates ? undefined : 3)
      : [];

  if (alternateCandidates.length > 0) {
    console.log("");
    console.log("Alternates");
    for (const [candidateIndex, candidate] of alternateCandidates.entries()) {
      const label = `Alt ${candidateIndex + 1}`;
      for (const line of formatCandidateLines(candidate, label)) {
        console.log(line);
      }
      if (candidateIndex < alternateCandidates.length - 1) {
        console.log("");
      }
    }
  }

  console.log("");
  console.log(
    `[Enter] next  [p] previous  [a] ${showAllCandidates ? "hide" : "show"} alternates  [q] quit${
      index === lastIndex ? "  [Enter on last item exits]" : ""
    }`,
  );
}

export async function reviewMatchesInteractive(matches: TransactionMatch[], options: ReviewOptions): Promise<void> {
  if (!input.isTTY || !output.isTTY) {
    throw new Error("Interactive review mode requires a TTY.");
  }

  const filteredMatches = filterMatches(matches, options);
  const summary = calculateSummary(matches);

  if (filteredMatches.length === 0) {
    console.log(`No transactions matched filter "${options.filter}".`);
    return;
  }

  const rl = createInterface({ input, output });
  let index = 0;
  let showAllCandidates = false;

  try {
    while (true) {
      printReviewScreen(filteredMatches, index, options.filter, summary, showAllCandidates);
      const answer = (await rl.question("> ")).trim().toLowerCase();

      if (answer === "q") {
        console.log("Review ended.");
        return;
      }

      if (answer === "p") {
        index = Math.max(0, index - 1);
        continue;
      }

      if (answer === "a") {
        showAllCandidates = !showAllCandidates;
        continue;
      }

      if (answer === "" || answer === "n") {
        if (index >= filteredMatches.length - 1) {
          console.log("Review complete.");
          return;
        }

        index += 1;
        showAllCandidates = false;
        continue;
      }

      if (answer === "s") {
        console.log("");
        console.log("Candidate summary");
        for (const [candidateIndex, candidate] of filteredMatches[index].candidates.entries()) {
          console.log(`  ${candidateIndex + 1}. ${summarizeCandidate(candidate)}`);
        }
        await rl.question("Press Enter to continue.");
        continue;
      }
    }
  } finally {
    rl.close();
  }
}
