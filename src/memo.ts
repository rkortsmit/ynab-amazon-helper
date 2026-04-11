import type { MatchCandidate } from "./types.ts";

const MEMO_LIMIT = 72;

function cleanWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function stripOuterPunctuation(value: string): string {
  return value.replace(/^[\s,;:.-]+|[\s,;:.-]+$/g, "").trim();
}

function truncateMemo(value: string, limit = MEMO_LIMIT): string {
  const cleaned = cleanWhitespace(value);
  if (cleaned.length <= limit) {
    return cleaned;
  }

  const slice = cleaned.slice(0, Math.max(0, limit - 1));
  const boundary = slice.lastIndexOf(" ");
  const shortened = boundary >= 24 ? slice.slice(0, boundary) : slice;
  return `${stripOuterPunctuation(shortened)}…`;
}

function compactItemTitle(title: string): string {
  let value = cleanWhitespace(title)
    .replace(/[“”]/g, '"')
    .replace(/[’]/g, "'")
    .replace(/\s*\([^)]*\)\s*/g, " ");

  const pipeSplit = value.split("|")[0];
  if (pipeSplit) {
    value = pipeSplit;
  }

  const commaParts = value
    .split(",")
    .map((part) => cleanWhitespace(part))
    .filter(Boolean);

  if (commaParts.length >= 1 && commaParts[0].length >= 16) {
    value = commaParts[0];
  } else if (commaParts.length >= 2) {
    value = `${commaParts[0]} ${commaParts[1]}`;
  }

  value = value
    .replace(/\b(pack of \d+|value pack)\b/gi, "")
    .replace(/\b\d+(\.\d+)?\s?(fl oz|oz|lb|lbs|inch|inches|count|ct|yards?)\b/gi, "")
    .replace(/\bfor (boys|girls|kids|toddlers?)\b/gi, "")
    .replace(/\s+/g, " ");

  return stripOuterPunctuation(value);
}

function uniqueCompactedTitles(itemTitles: string[]): string[] {
  const unique: string[] = [];
  const seen = new Set<string>();

  for (const title of itemTitles) {
    const compacted = compactItemTitle(title);
    const key = compacted.toLowerCase();
    if (!compacted || seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(compacted);
  }

  return unique;
}

export function generateMemoFromMatch(
  candidate: MatchCandidate | null,
  options?: {
    refund?: boolean;
  },
): string | null {
  if (!candidate) {
    return null;
  }

  const compacted = uniqueCompactedTitles(candidate.order.itemTitles);
  const prefix = options?.refund ? "Refund: " : "";

  if (compacted.length === 0) {
    return candidate.order.orderNumber ? truncateMemo(`${prefix}Amazon order ${candidate.order.orderNumber}`) : null;
  }

  if (compacted.length === 1) {
    return truncateMemo(`${prefix}${compacted[0]}`);
  }

  const first = compacted[0];
  const second = compacted[1];
  const remaining = compacted.length - 1;
  const plusMore = `${prefix}${first} + ${remaining} more`;
  const pair = `${prefix}${first}; ${second}`;

  if (remaining >= 2 || plusMore.length <= MEMO_LIMIT) {
    return truncateMemo(plusMore);
  }

  return truncateMemo(pair);
}
