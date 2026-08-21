/**
 * The two halves the overall rating is the mean of.
 *
 * Soft is communication and behavioural; hard is technical and coding. The
 * evaluator computes both and stores them on the report, because the overall
 * is defined as their average — anything that re-derives them from the
 * individual columns risks disagreeing with the headline number, which is
 * exactly how a report once showed 7.5 overall above halves of 2.9 and 6.5.
 *
 * Reports written before the rule have no stored pair, and deriving one for
 * them would recreate that same disagreement: their overall came from the old
 * weighting and is not the mean of anything shown beside it. So they get null,
 * and the reader shows nothing rather than a contradiction. Re-running the
 * evaluation is what gives a report real halves.
 */
export interface ReportHalves {
  soft: number;
  hard: number;
}

interface HalvesSource {
  details?: unknown;
}

export function reportHalves(report: HalvesSource): ReportHalves | null {
  const stored = (report.details as { halves?: { soft?: unknown; hard?: unknown } } | null | undefined)?.halves;

  if (typeof stored?.soft === 'number' && typeof stored?.hard === 'number') {
    return { soft: stored.soft, hard: stored.hard };
  }

  return null;
}
