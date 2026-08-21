/**
 * The two halves the overall rating is the mean of.
 *
 * Soft is communication and behavioural; hard is technical and coding. The
 * evaluator computes both and stores them on the report, because the overall
 * is defined as their average — anything that re-derives them from the
 * individual columns risks disagreeing with the headline number, which is
 * exactly how a report once showed 7.5 overall above halves of 2.9 and 6.5.
 *
 * Reports written before the pair was stored fall back to deriving it here.
 * That fallback cannot be exact: it has no way to tell a coding round the
 * candidate skipped from one that was never configured, so it keeps the older
 * reading rather than restating history.
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

  return {
    soft: (report.communicationScore + report.behavioralScore) / 2,
    hard:
      report.codingScore != null
        ? (report.technicalScore + report.codingScore) / 2
        : report.technicalScore,
  };
}
