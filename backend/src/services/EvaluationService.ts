import { HiringRecommendation, Prisma } from '@prisma/client';
import { z } from 'zod';
import { completeJson, SMART_MODEL } from '../lib/ai';
import { env } from '../lib/env';
import { prisma } from '../lib/prisma';
import { extractSignals, scoreCommunication } from './CommunicationAnalyzer';
import { InsightService } from './InsightService';
import { ResumeProfile } from './ResumeService';
import { TranscriptService } from './TranscriptService';
import { VideoAnalysisService } from './VideoAnalysisService';

const evidence = z.object({ point: z.string(), evidence: z.string().default('') });

const llmSchema = z.object({
  technical: z.object({
    knowledge: z.number().min(0).max(10).nullable().default(null),
    problemSolving: z.number().min(0).max(10).nullable().default(null),
    logicalThinking: z.number().min(0).max(10).nullable().default(null),
    projectUnderstanding: z.number().min(0).max(10).nullable().default(null),
    domainExpertise: z.number().min(0).max(10).nullable().default(null),
    notes: z.string().default(''),
  }),
  behavioral: z.object({
    leadership: z.number().min(0).max(10).nullable().default(null),
    teamwork: z.number().min(0).max(10).nullable().default(null),
    adaptability: z.number().min(0).max(10).nullable().default(null),
    ownership: z.number().min(0).max(10).nullable().default(null),
    learningMindset: z.number().min(0).max(10).nullable().default(null),
    notes: z.string().default(''),
  }),
  skillBreakdown: z.array(z.object({ skill: z.string(), score: z.number().min(0).max(10), evidence: z.string().default('') })).default([]),
  strengths: z.array(evidence).default([]),
  weaknesses: z.array(evidence).default([]),
  improvements: z.array(z.string()).default([]),
  redFlags: z.array(z.string()).default([]),
  summary: z.string().default(''),
  recruiterFeedback: z.string().default(''),
  candidateFeedback: z.string().default(''),
});

/**
 * A failure that retrying cannot fix — there is genuinely nothing to score.
 * Distinguished from transient failures (rate limits, database blips) so the
 * retry queue gives up immediately instead of burning attempts for half an hour.
 */
export class PermanentEvaluationError extends Error {
  readonly isPermanent = true;

  constructor(message: string) {
    super(message);
    this.name = 'PermanentEvaluationError';
  }
}

const avg = (nums: number[]) => (nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : 0);
const round1 = (n: number) => Math.round(n * 10) / 10;

/**
 * Maps the weighted overall score onto a hiring recommendation, with hard
 * gates so a strong talker with no technical substance cannot be a Strong Hire.
 */
function recommend(args: {
  overall: number;
  technical: number | null;
  communication: number;
  redFlagCount: number;
  passMark: number;
}): { recommendation: HiringRecommendation; reason: string } {
  const { overall, technical, communication, redFlagCount, passMark } = args;

  if (redFlagCount >= 3) {
    return { recommendation: 'REJECT', reason: `${redFlagCount} red flags were raised during the interview.` };
  }
  if (overall < passMark - 2) {
    return { recommendation: 'REJECT', reason: `Overall ${round1(overall)}/10 is well below the ${passMark}/10 bar for this role.` };
  }
  if (overall < passMark) {
    return { recommendation: 'CONSIDER', reason: `Overall ${round1(overall)}/10 is just under the ${passMark}/10 bar; worth a second opinion.` };
  }
  if (overall >= 8.5 && (technical === null || technical >= 8) && communication >= 7 && redFlagCount === 0) {
    return { recommendation: 'STRONG_HIRE', reason: `Strong across the board — ${technical !== null ? `${round1(technical)}/10 technical and ` : ''}${round1(communication)}/10 communication with no red flags.` };
  }
  if (overall >= passMark + 1 && (technical === null || technical >= passMark)) {
    return { recommendation: 'HIRE', reason: `Clears the bar at ${round1(overall)}/10 overall${technical !== null ? ' with solid technical depth' : ''}.` };
  }
  return { recommendation: 'CONSIDER', reason: `Meets the bar at ${round1(overall)}/10 but with uneven strengths.` };
}

export class EvaluationService {
  /**
   * Produces the full report for one interview: rule-based communication
   * scoring, coding results, video signals, and an LLM judgement of technical
   * and behavioural substance — combined into a single recommendation.
   */
  static async evaluate(sessionCandidateId: string) {
    const sc = await prisma.sessionCandidate.findUnique({
      where: { id: sessionCandidateId },
      include: {
        candidate: true,
        interviewSession: true,
        submissions: { include: { question: true }, orderBy: { createdAt: 'asc' } },
      },
    });
    if (!sc) throw new PermanentEvaluationError('Interview not found');

    const session = sc.interviewSession;
    const resumeProfile = (sc.resumeProfile as unknown as ResumeProfile | null) ?? null;
    const turns = await TranscriptService.getTurns(sessionCandidateId);
    const answers = turns.filter((t) => t.speaker === 'CANDIDATE' && t.text.trim());

    if (answers.length === 0) {
      // Nothing was ever said, so no amount of retrying will help.
      throw new PermanentEvaluationError('This interview has no candidate responses to evaluate.');
    }

    // --- Measured signals -------------------------------------------------
    const signals = extractSignals(turns);
    const communication = scoreCommunication(signals);
    const insights = await InsightService.summarise(sessionCandidateId);
    const video = session.videoAnalysisEnabled ? await VideoAnalysisService.summarise(sessionCandidateId) : null;

    // --- Coding -----------------------------------------------------------
    const codingScores = sc.submissions
      .map((s) => {
        const correctness = s.totalCases ? (s.passedCases / s.totalCases) * 10 : null;
        if (correctness == null) return null;
        return correctness * 0.6 + (s.qualityScore ?? 5) * 0.4;
      })
      .filter((n): n is number => n != null);
    const codingScore = codingScores.length ? round1(avg(codingScores)) : null;

    // --- LLM judgement ----------------------------------------------------
    const qna = TranscriptService.toQnA(turns);
    const transcriptText = qna
      .map((p, i) => `Q${i + 1} [${p.round ?? 'GENERAL'}]: ${p.question}\nA${i + 1}: ${p.answer}`)
      .join('\n\n');

    const codingSummary = sc.submissions.length
      ? sc.submissions
          .map(
            (s) =>
              `- ${s.language}: ${s.passedCases}/${s.totalCases} tests passed, complexity ${s.timeComplexity ?? 'unknown'}, quality ${s.qualityScore ?? 'n/a'}/10`,
          )
          .join('\n')
      : 'No coding submissions.';

    const judgement = await completeJson({
      schema: llmSchema,
      model: SMART_MODEL,
      temperature: 0.2,
      maxTokens: 4000,
      messages: [
        {
          role: 'system',
          content:
            'You are a strict, fair hiring evaluator. Output JSON only. Judge exclusively what appears in the transcript. Never invent evidence. Never reward verbosity — a short precise answer beats a long vague one.',
        },
        {
          role: 'user',
          content: `Evaluate this interview.

ROLE: ${session.title}
JOB DESCRIPTION: ${session.jobDescription}
REQUIRED SKILLS: ${session.skills.join(', ')}
EXPERIENCE LEVEL: ${session.experienceLevel}
INTERVIEW TYPE: ${session.type}
${
  resumeProfile
    ? `
WHAT THE RESUME CLAIMED (for cross-checking only):
Skills: ${resumeProfile.skills.join(', ') || 'none listed'}
Experience: about ${resumeProfile.totalYearsExperience} years
Claims that were meant to be verified: ${resumeProfile.claimsToProbe.join('; ') || 'none'}
Required skills with no resume evidence: ${resumeProfile.missingJdSkills.join(', ') || 'none'}

Judge the INTERVIEW, not the resume. Use the resume only to notice a gap between
what was claimed and what they could actually explain. If a claim went unverified
because it never came up, say so rather than assuming either way. A candidate who
demonstrated more than their resume suggested should be credited for it.
`
    : ''
}

TRANSCRIPT:
${transcriptText || '(no dialogue captured)'}

CODING SUBMISSIONS:
${codingSummary}

ALREADY MEASURED — do not re-estimate these, they are inputs:
- Communication scored ${communication.overall}/10 by acoustic and linguistic analysis.
- Average pause before answering: ${signals.avgLatencyMs}ms across ${signals.answerCount} answers.
- Filler word ratio: ${(signals.fillerRatio * 100).toFixed(1)}%.
- ${insights.negatives} negative real-time signals, ${insights.positives} strong-answer signals.

SCORING RULES
- All sub-scores are 0 to 10.
- 0-3 is below the bar for a ${session.experienceLevel} candidate, 4-6 meets it, 7-8 is strong, 9-10 is exceptional.
- Calibrate to "${session.experienceLevel}", not to an absolute expert.
- Every strength and weakness must quote or reference a specific moment from the transcript. If you cannot point to one, leave the list shorter.
- If a dimension has too little evidence or was not asked about, return null for it. Do not guess and do not default to 5.
- skillBreakdown must cover the required skills that actually came up. Omit skills never discussed.
- redFlags are only for serious concerns: dishonesty, contradiction, hostility, or a total absence of claimed expertise.
- candidateFeedback is written directly to the candidate: constructive, specific and kind. recruiterFeedback is blunt and decision-oriented.

Return JSON: { technical{knowledge,problemSolving,logicalThinking,projectUnderstanding,domainExpertise,notes}, behavioral{leadership,teamwork,adaptability,ownership,learningMindset,notes}, skillBreakdown[{skill,score,evidence}], strengths[{point,evidence}], weaknesses[{point,evidence}], improvements[], redFlags[], summary, recruiterFeedback, candidateFeedback }`,
        },
      ],
    });

    // --- Composite scores -------------------------------------------------
    const technicalScores = [
      judgement.technical.knowledge,
      judgement.technical.problemSolving,
      judgement.technical.logicalThinking,
      judgement.technical.projectUnderstanding,
      judgement.technical.domainExpertise,
    ].filter((s): s is number => s !== null);
    
    const technicalScore = technicalScores.length ? round1(avg(technicalScores)) : null;

    const behavioralScores = [
      judgement.behavioral.leadership,
      judgement.behavioral.teamwork,
      judgement.behavioral.adaptability,
      judgement.behavioral.ownership,
      judgement.behavioral.learningMindset,
    ].filter((s): s is number => s !== null);

    const behavioralScore = behavioralScores.length ? round1(avg(behavioralScores)) : null;

    // Communication blends the measured score with observed composure.
    const communicationScore = round1(communication.overall * 0.8 + insights.composure * 0.2);
    const videoConfidenceScore = video ? round1(video.confidenceScore) : null;

    // Weighting shifts with interview type: an HR round should not be decided
    // by a technical score derived from three questions.
    const weights =
      session.type === 'HR'
        ? { technical: 0.15, communication: 0.4, behavioral: 0.4, coding: 0, video: 0.05 }
        : session.type === 'TECHNICAL'
          ? { technical: 0.2, communication: 0.15, behavioral: 0.1, coding: 0.5, video: 0.05 }
          : { technical: 0.15, communication: 0.2, behavioral: 0.1, coding: 0.5, video: 0.05 };

    // Redistribute weight from any dimension we could not measure.
    let usable = weights.communication;
    if (technicalScore != null) usable += weights.technical;
    if (behavioralScore != null) usable += weights.behavioral;
    if (codingScore != null) usable += weights.coding;
    if (videoConfidenceScore != null) usable += weights.video;

    const weighted =
      (technicalScore != null ? technicalScore * weights.technical : 0) +
      communicationScore * weights.communication +
      (behavioralScore != null ? behavioralScore * weights.behavioral : 0) +
      (codingScore != null ? codingScore * weights.coding : 0) +
      (videoConfidenceScore != null ? videoConfidenceScore * weights.video : 0);

    const overallRating = usable > 0 ? round1(Math.max(0, Math.min(10, weighted / usable))) : 0;

    const { recommendation, reason } = recommend({
      overall: overallRating,
      technical: technicalScore,
      communication: communicationScore,
      redFlagCount: judgement.redFlags.length,
      passMark: session.passMark,
    });

    // --- Persist ----------------------------------------------------------
    const details = {
      communication: {
        ...communication,
        signals,
      },
      technical: judgement.technical,
      behavioral: judgement.behavioral,
      skillBreakdown: judgement.skillBreakdown,
      strengths: judgement.strengths,
      weaknesses: judgement.weaknesses,
      improvements: judgement.improvements,
      redFlags: judgement.redFlags,
      insights,
      video,
      coding: sc.submissions.map((s) => ({
        id: s.id,
        language: s.language,
        questionTitle: (s.question?.meta as { title?: string } | null)?.title ?? 'Coding challenge',
        passedCases: s.passedCases,
        totalCases: s.totalCases,
        timeComplexity: s.timeComplexity,
        spaceComplexity: s.spaceComplexity,
        qualityScore: s.qualityScore,
        feedback: s.reviewFeedback,
      })),
      meta: {
        questionsAsked: qna.length,
        answersGiven: answers.length,
        identityVerified: sc.identityVerified,
        durationMinutes:
          sc.startedAt && sc.completedAt
            ? Math.round((sc.completedAt.getTime() - sc.startedAt.getTime()) / 60_000)
            : null,
        weights,
      },
    };

    const report = await prisma.$transaction(async (tx) => {
      await tx.report.deleteMany({ where: { sessionCandidateId } });

      const created = await tx.report.create({
        data: {
          sessionCandidateId,
          overallRating,
          technicalScore: technicalScore ?? 0,
          communicationScore,
          behavioralScore: behavioralScore ?? 0,
          codingScore,
          videoConfidenceScore,
          hiringRecommendation: recommendation,
          recommendationReason: reason,
          aiFeedback: judgement.recruiterFeedback,
          candidateFeedback: judgement.candidateFeedback,
          summary: judgement.summary,
          details: details as unknown as Prisma.InputJsonValue,
        },
      });

      const scoreRows: Prisma.ScoreCreateManyInput[] = [
        { reportId: created.id, category: 'Overall', label: 'Overall', value: overallRating },
        { reportId: created.id, category: 'Summary', label: 'Communication', value: communicationScore },
        
        // Communication breakdown
        { reportId: created.id, category: 'Communication', label: 'Fluency', value: communication.fluency },
        { reportId: created.id, category: 'Communication', label: 'Confidence', value: communication.confidence },
        { reportId: created.id, category: 'Communication', label: 'Clarity', value: communication.clarity },
        { reportId: created.id, category: 'Communication', label: 'Grammar', value: communication.grammar },
        { reportId: created.id, category: 'Communication', label: 'Vocabulary', value: communication.vocabulary },
        { reportId: created.id, category: 'Communication', label: 'Pace', value: communication.pace },
      ];

      if (technicalScore !== null) {
        scoreRows.push({ reportId: created.id, category: 'Summary', label: 'Technical', value: technicalScore });
      }
      if (behavioralScore !== null) {
        scoreRows.push({ reportId: created.id, category: 'Summary', label: 'Behavioral', value: behavioralScore });
      }

      // Add detailed technical scores if they exist
      const techProps = [
        { label: 'Knowledge', value: judgement.technical.knowledge },
        { label: 'Problem Solving', value: judgement.technical.problemSolving },
        { label: 'Logical Thinking', value: judgement.technical.logicalThinking },
        { label: 'Project Understanding', value: judgement.technical.projectUnderstanding },
        { label: 'Domain Expertise', value: judgement.technical.domainExpertise },
      ];
      techProps.forEach(prop => {
        if (prop.value !== null) {
          scoreRows.push({ reportId: created.id, category: 'Technical', label: prop.label, value: prop.value });
        }
      });

      // Add detailed behavioral scores if they exist
      const behavProps = [
        { label: 'Leadership', value: judgement.behavioral.leadership },
        { label: 'Teamwork', value: judgement.behavioral.teamwork },
        { label: 'Adaptability', value: judgement.behavioral.adaptability },
        { label: 'Ownership', value: judgement.behavioral.ownership },
        { label: 'Learning Mindset', value: judgement.behavioral.learningMindset },
      ];
      behavProps.forEach(prop => {
        if (prop.value !== null) {
          scoreRows.push({ reportId: created.id, category: 'Behavioral', label: prop.label, value: prop.value });
        }
      });

      for (const skill of judgement.skillBreakdown) {
        scoreRows.push({
          reportId: created.id,
          category: 'Skill',
          label: skill.skill,
          value: skill.score,
          evidence: skill.evidence,
        });
      }

      if (codingScore != null) {
        scoreRows.push({ reportId: created.id, category: 'Summary', label: 'Coding', value: codingScore });
      }
      if (videoConfidenceScore != null) {
        scoreRows.push({ reportId: created.id, category: 'Summary', label: 'Video Confidence', value: videoConfidenceScore });
      }

      await tx.score.createMany({ data: scoreRows });

      // A transcript summary makes the recruiter list scannable.
      if (judgement.summary) {
        await tx.interviewTranscript.updateMany({
          where: { sessionCandidateId },
          data: { summary: judgement.summary },
        });
      }

      return created;
    });

    return prisma.report.findUnique({
      where: { id: report.id },
      include: { scores: true },
    });
  }
}
