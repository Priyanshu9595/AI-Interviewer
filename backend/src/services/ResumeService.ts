import { z } from 'zod';
import { completeJson, SMART_MODEL } from '../lib/ai';
import { prisma } from '../lib/prisma';

const profileSchema = z.object({
  fullName: z.string().default(''),
  headline: z.string().default(''),
  totalYearsExperience: z.number().min(0).max(60).default(0),
  skills: z.array(z.string()).default([]),
  roles: z
    .array(
      z.object({
        title: z.string(),
        company: z.string().default(''),
        duration: z.string().default(''),
        highlights: z.array(z.string()).default([]),
      }),
    )
    .default([]),
  projects: z
    .array(z.object({ name: z.string(), description: z.string().default(''), tech: z.array(z.string()).default([]) }))
    .default([]),
  education: z.array(z.string()).default([]),
  certifications: z.array(z.string()).default([]),
  /** Skills the JD asks for that the resume does not evidence. */
  missingJdSkills: z.array(z.string()).default([]),
  /** Claims worth verifying live — the most valuable output for an interviewer. */
  claimsToProbe: z.array(z.string()).default([]),
  /** Unexplained employment gaps worth asking about, phrased neutrally. */
  gaps: z.array(z.string()).default([]),
});

export type ResumeProfile = z.infer<typeof profileSchema>;

const resumeQuestionsSchema = z.object({
  questions: z
    .array(
      z.object({
        text: z.string(),
        focusArea: z.string().default('resume'),
        expectedPoints: z.array(z.string()).default([]),
        /** Which resume claim this question is testing. */
        probes: z.string().default(''),
      }),
    )
    .default([]),
});

export type ResumeQuestion = z.infer<typeof resumeQuestionsSchema>['questions'][number];

/** Extracted text plus how it was obtained, for diagnostics. */
export interface ExtractedResume {
  text: string;
  pages?: number;
}

const MAX_TEXT = 24_000;

export class ResumeService {
  /** Pulls plain text out of a PDF, DOCX or plain-text upload. */
  static async extractText(buffer: Buffer, fileName: string, mimeType: string): Promise<ExtractedResume> {
    const ext = fileName.split('.').pop()?.toLowerCase() ?? '';

    if (ext === 'pdf' || mimeType === 'application/pdf') {
      // pdf-parse v2 exposes a class rather than the v1 callable default, and
      // pulls in pdfjs, so it is imported lazily to keep server boot fast.
      const { PDFParse } = await import('pdf-parse');
      const parser = new PDFParse({ data: new Uint8Array(buffer) });

      try {
        const result = await parser.getText();
        return { text: result.text, pages: result.total };
      } finally {
        // Releases the pdfjs worker; leaking it keeps the process alive.
        await parser.destroy().catch(() => {});
      }
    }

    if (ext === 'docx' || mimeType.includes('officedocument.wordprocessingml')) {
      const mammoth = await import('mammoth');
      const result = await mammoth.extractRawText({ buffer });
      return { text: result.value };
    }

    if (ext === 'txt' || ext === 'md' || mimeType.startsWith('text/')) {
      return { text: buffer.toString('utf-8') };
    }

    throw new Error(`Unsupported resume format ".${ext}". Upload a PDF, DOCX or TXT file.`);
  }

  /** Collapses the whitespace soup that PDF extraction usually produces. */
  static normalise(raw: string): string {
    return raw
      .replace(/\r\n/g, '\n')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .split('\n')
      .map((l) => l.trim())
      .join('\n')
      .trim()
      .slice(0, MAX_TEXT);
  }

  /**
   * Reads the resume against the job description and returns a structured
   * profile. The interesting output is not the skill list — it is
   * `claimsToProbe`, which gives the interviewer specific things to verify.
   */
  static async analyse(args: {
    resumeText: string;
    jobTitle: string;
    jobDescription: string;
    requiredSkills: string[];
    experienceLevel: string;
  }): Promise<ResumeProfile> {
    if (!args.resumeText.trim()) {
      throw new Error('The resume appears to be empty or is a scanned image without selectable text.');
    }

    return completeJson({
      schema: profileSchema,
      model: SMART_MODEL,
      temperature: 0.2,
      maxTokens: 3000,
      messages: [
        {
          role: 'system',
          content:
            'You extract structured facts from resumes. Output JSON only. Never invent experience that is not in the text — an empty list is correct when the resume does not say.',
        },
        {
          role: 'user',
          content: `Read this resume against the role and return the structured profile.

ROLE: ${args.jobTitle}
EXPERIENCE LEVEL SOUGHT: ${args.experienceLevel}
REQUIRED SKILLS: ${args.requiredSkills.join(', ')}
JOB DESCRIPTION:
${args.jobDescription}

RESUME:
${args.resumeText}

RULES
- skills: only technologies the resume actually names. Do not infer.
- totalYearsExperience: compute from the dates present. Use 0 if none are given.
- missingJdSkills: required skills with no supporting evidence anywhere in the resume.
- claimsToProbe: 3 to 6 specific claims worth verifying in conversation. Prefer
  quantified or senior-sounding claims ("scaled to 40k rps", "led a team of 6",
  "architected the platform"). Quote enough of the claim to be recognisable.
- gaps: employment gaps over six months, phrased neutrally as a question topic.
  Empty list if the dates are continuous or absent.

Return JSON: { fullName, headline, totalYearsExperience, skills[], roles[{title,company,duration,highlights[]}], projects[{name,description,tech[]}], education[], certifications[], missingJdSkills[], claimsToProbe[], gaps[] }`,
        },
      ],
    });
  }

  /**
   * Writes questions against this specific candidate's history. The shared
   * question set is generated from the job description alone, so this is what
   * makes the interview genuinely resume-driven rather than generic.
   */
  static async buildQuestions(args: {
    profile: ResumeProfile;
    resumeText: string;
    jobTitle: string;
    requiredSkills: string[];
    experienceLevel: string;
    count: number;
  }): Promise<ResumeQuestion[]> {
    if (args.count <= 0) return [];

    try {
      const result = await completeJson({
        schema: resumeQuestionsSchema,
        model: SMART_MODEL,
        temperature: 0.6,
        maxTokens: 2000,
        messages: [
          {
            role: 'system',
            content:
              'You write interview questions grounded in a specific candidate resume. Output JSON only. Questions are spoken aloud, so no markdown or symbols.',
          },
          {
            role: 'user',
            content: `Write exactly ${args.count} questions for this candidate, for the role of ${args.jobTitle} at ${args.experienceLevel}.

RESUME PROFILE
Skills: ${args.profile.skills.join(', ') || 'none listed'}
Roles: ${args.profile.roles.map((r) => `${r.title} at ${r.company} (${r.duration})`).join('; ') || 'none listed'}
Projects: ${args.profile.projects.map((p) => `${p.name}: ${p.description}`).join('; ') || 'none listed'}
Claims worth verifying: ${args.profile.claimsToProbe.join('; ') || 'none'}
Required skills without resume evidence: ${args.profile.missingJdSkills.join(', ') || 'none'}

RESUME EXCERPT
${args.resumeText.slice(0, 6000)}

RULES
- Name a real project, employer or claim from the resume in each question.
- Make them explain HOW they did something, not whether they did it.
- Prioritise the "claims worth verifying" list.
- If a required skill has no evidence, include one question that establishes their real level in it.
- Never say "your resume says", "your CV", or "it says here". Ask as though you were briefed on their background.
- One question per item, spoken plainly, no markdown.

Return JSON: { "questions": [{ "text", "focusArea", "expectedPoints": [], "probes" }] }`,
          },
        ],
      });

      return result.questions.slice(0, args.count);
    } catch (err) {
      console.error('[ResumeService] question generation failed:', (err as Error).message);
      return [];
    }
  }

  /** Extracts, analyses and stores a resume against one interview. */
  static async attach(args: {
    sessionCandidateId: string;
    buffer: Buffer;
    fileName: string;
    mimeType: string;
  }) {
    const sc = await prisma.sessionCandidate.findUnique({
      where: { id: args.sessionCandidateId },
      include: { interviewSession: true },
    });
    if (!sc) throw new Error('Interview not found');

    const extracted = await this.extractText(args.buffer, args.fileName, args.mimeType);
    const text = this.normalise(extracted.text);

    if (text.length < 120) {
      throw new Error(
        'Could not read enough text from this file. If it is a scanned PDF, upload a text-based PDF or a DOCX instead.',
      );
    }

    // Store the file and its text FIRST. Analysis needs the LLM, and a provider
    // outage must never cost the candidate their upload — they may not be able
    // to re-upload before the interview starts.
    await prisma.sessionCandidate.update({
      where: { id: sc.id },
      data: {
        resumeFileName: args.fileName,
        // Copied into a plain Uint8Array because Prisma's Bytes rejects a
        // Buffer that may be backed by a SharedArrayBuffer.
        resumeFile: new Uint8Array(args.buffer),
        resumeMimeType: args.mimeType,
        resumeSizeBytes: args.buffer.length,
        resumeText: text,
      },
    });

    let profile: ResumeProfile;
    try {
      profile = await this.analyse({
        resumeText: text,
        jobTitle: sc.interviewSession.title,
        jobDescription: sc.interviewSession.jobDescription,
        requiredSkills: sc.interviewSession.skills,
        experienceLevel: sc.interviewSession.experienceLevel,
      });
    } catch (err) {
      // The file and its text are already safe in Postgres. Leaving
      // resumeParsedAt null marks it for the scheduler to analyse later.
      console.warn(
        `[resume] stored ${args.fileName} for ${sc.id} but could not analyse it yet: ${(err as Error).message.slice(0, 160)}`,
      );
      return { profile: null, questions: [], characters: text.length, pages: extracted.pages, analysed: false };
    }

    // Longer interviews can absorb more resume-specific questions.
    const count = sc.interviewSession.durationMinutes >= 45 ? 4 : sc.interviewSession.durationMinutes >= 30 ? 3 : 2;

    const questions = await this.buildQuestions({
      profile,
      resumeText: text,
      jobTitle: sc.interviewSession.title,
      requiredSkills: sc.interviewSession.skills,
      experienceLevel: sc.interviewSession.experienceLevel,
      count,
    });

    await prisma.sessionCandidate.update({
      where: { id: sc.id },
      data: {
        resumeProfile: profile as unknown as object,
        resumeQuestions: questions as unknown as object,
        resumeParsedAt: new Date(),
      },
    });

    return { profile, questions, characters: text.length, pages: extracted.pages, analysed: true };
  }

  /**
   * Analyses resumes that were uploaded while the LLM was unavailable. The file
   * is already stored; this fills in the profile and tailored questions.
   */
  static async analysePending(): Promise<number> {
    const pending = await prisma.sessionCandidate.findFirst({
      where: {
        resumeText: { not: null },
        resumeParsedAt: null,
        status: { in: ['INVITED', 'JOINED', 'IN_PROGRESS'] },
      },
      select: { id: true, resumeFileName: true },
      orderBy: { updatedAt: 'asc' },
    });

    if (!pending) return 0;

    const row = await prisma.sessionCandidate.findUnique({
      where: { id: pending.id },
      select: { resumeText: true, resumeFileName: true, interviewSession: true },
    });
    if (!row?.resumeText) return 0;

    try {
      const profile = await this.analyse({
        resumeText: row.resumeText,
        jobTitle: row.interviewSession.title,
        jobDescription: row.interviewSession.jobDescription,
        requiredSkills: row.interviewSession.skills,
        experienceLevel: row.interviewSession.experienceLevel,
      });

      const count = row.interviewSession.durationMinutes >= 45 ? 4 : row.interviewSession.durationMinutes >= 30 ? 3 : 2;
      const questions = await this.buildQuestions({
        profile,
        resumeText: row.resumeText,
        jobTitle: row.interviewSession.title,
        requiredSkills: row.interviewSession.skills,
        experienceLevel: row.interviewSession.experienceLevel,
        count,
      });

      await prisma.sessionCandidate.update({
        where: { id: pending.id },
        data: {
          resumeProfile: profile as unknown as object,
          resumeQuestions: questions as unknown as object,
          resumeParsedAt: new Date(),
        },
      });

      console.log(`[resume] analysed ${row.resumeFileName} for ${pending.id} on retry`);
      return 1;
    } catch {
      // Still unavailable; the next tick will try again.
      return 0;
    }
  }

  /**
   * Condenses a stored profile into the block that gets injected into question
   * generation and the live interviewer's system prompt.
   */
  static promptBlock(profile: ResumeProfile | null, resumeText?: string | null): string {
    if (!profile) return '';

    const lines: string[] = ['CANDIDATE RESUME SUMMARY'];

    if (profile.headline) lines.push(`Headline: ${profile.headline}`);
    if (profile.totalYearsExperience) lines.push(`Experience: about ${profile.totalYearsExperience} years`);
    if (profile.skills.length) lines.push(`Skills claimed: ${profile.skills.slice(0, 25).join(', ')}`);

    if (profile.roles.length) {
      lines.push('Roles:');
      for (const r of profile.roles.slice(0, 4)) {
        lines.push(`  - ${r.title}${r.company ? ` at ${r.company}` : ''}${r.duration ? ` (${r.duration})` : ''}`);
        for (const h of r.highlights.slice(0, 2)) lines.push(`      ${h}`);
      }
    }

    if (profile.projects.length) {
      lines.push('Projects:');
      for (const p of profile.projects.slice(0, 3)) {
        lines.push(`  - ${p.name}${p.tech.length ? ` [${p.tech.slice(0, 6).join(', ')}]` : ''}: ${p.description}`);
      }
    }

    if (profile.claimsToProbe.length) {
      lines.push('Claims worth verifying in conversation:');
      for (const c of profile.claimsToProbe.slice(0, 6)) lines.push(`  - ${c}`);
    }

    if (profile.missingJdSkills.length) {
      lines.push(`Required skills with no resume evidence: ${profile.missingJdSkills.join(', ')}`);
    }

    if (profile.gaps.length) lines.push(`Employment gaps: ${profile.gaps.join('; ')}`);

    // A trimmed excerpt helps the model quote the resume accurately.
    if (resumeText) lines.push(`\nRESUME EXCERPT:\n${resumeText.slice(0, 4000)}`);

    return lines.join('\n');
  }
}
