/**
 * The two halves the overall rating is the mean of.
 *
 * Soft is communication and behavioural; hard is technical and coding. The
 * evaluator computes both and stores them on the report, because the overall
 * is defined as their average — anything that re-derives them from the
 * individual columns risks disagreeing with the headline number, which is
 * exactly how a report once showed 7.5 overall above halves of 2.9 and 6.5.
 *
 * Reports written before the pair was stored fall back to deriving it here on
 * the same rule. Their stored overall came from the older weighting though, so
 * for those it will not be the mean of these two — only a re-evaluation makes
 * all three numbers agree.
 */
export interface ReportHalves {
  soft: number;
  hard: number;
}

interface HalvesSource {
  technicalScore: number;
  communicationScore: number;
  behavioralScore: number;
  codingScore: number | null;
  details?: unknown;
}

export function reportHalves(report: HalvesSource): ReportHalves {
  const stored = (report.details as { halves?: { soft?: unknown; hard?: unknown } } | null | undefined)?.halves;

  if (typeof stored?.soft === 'number' && typeof stored?.hard === 'number') {
    return { soft: stored.soft, hard: stored.hard };
  }

  // An unevaluated partner leaves the other carrying the half alone. Coding
  // says so honestly by being null; technical and behavioural are non-null
  // columns that the evaluator writes an unevaluated score into as 0, so a
  // zero has to be read as "never scored" here. A genuine zero average across
  // five sub-scores is close enough to impossible to be worth the trade.
  const pair = (a: number | null, b: number | null) => {
    const scored = [a, b].filter((n): n is number => n != null);
    return scored.length ? scored.reduce((x, y) => x + y, 0) / scored.length : 0;
  };

  return {
    soft: pair(report.communicationScore || null, report.behavioralScore || null),
    hard: pair(report.technicalScore || null, report.codingScore),
  };
}
