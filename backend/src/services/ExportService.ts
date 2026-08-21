import { Response } from 'express';
import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';
import { prisma } from '../lib/prisma';
import { reportHalves } from '../lib/reportScores';
import { RankingService } from './RankingService';

const INK = '#0f172a';
const MUTED = '#64748b';
const ACCENT = '#4f46e5';
const RULE = '#e2e8f0';

type Details = {
  communication?: { fluency: number; confidence: number; clarity: number; grammar: number; vocabulary: number; pace: number; notes?: string[] };
  technical?: Record<string, number | string>;
  behavioral?: Record<string, number | string>;
  skillBreakdown?: Array<{ skill: string; score: number; evidence?: string }>;
  strengths?: Array<{ point: string; evidence?: string }>;
  weaknesses?: Array<{ point: string; evidence?: string }>;
  improvements?: string[];
  redFlags?: string[];
  coding?: Array<{ questionTitle: string; language: string; passedCases: number; totalCases: number; timeComplexity?: string | null; qualityScore?: number | null }>;
  video?: { avgFacePresence: number; avgGazeStability: number; dominantExpression: string; observations: string[] } | null;
  meta?: { durationMinutes?: number | null; questionsAsked?: number; identityVerified?: boolean };
};

const RECOMMENDATION_LABEL: Record<string, string> = {
  STRONG_HIRE: 'Strong Hire',
  HIRE: 'Hire',
  CONSIDER: 'Consider',
  REJECT: 'Reject',
};

export class ExportService {
  private static async loadReport(reportId: string) {
    const report = await prisma.report.findUnique({
      where: { id: reportId },
      include: {
        scores: true,
        sessionCandidate: {
          include: {
            candidate: true,
            interviewSession: true,
            transcript: { include: { turns: { orderBy: { timestamp: 'asc' } } } },
          },
        },
      },
    });
    if (!report) throw new Error('Report not found');
    return report;
  }

  // -------------------------------------------------------------------------
  // PDF
  // -------------------------------------------------------------------------

  static async reportPdf(reportId: string, res: Response) {
    const report = await this.loadReport(reportId);
    const sc = report.sessionCandidate;
    const details = (report.details ?? {}) as Details;

    const safeName = sc.candidate.name.replace(/[^a-zA-Z0-9]/g, '_');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="Interview_Report_${safeName}.pdf"`);

    const doc = new PDFDocument({ margin: 48, size: 'A4' });
    doc.pipe(res);

    const width = doc.page.width - 96;

    const rule = () => {
      doc.moveDown(0.6);
      doc.strokeColor(RULE).lineWidth(1).moveTo(48, doc.y).lineTo(48 + width, doc.y).stroke();
      doc.moveDown(0.8);
    };

    const heading = (text: string) => {
      if (doc.y > doc.page.height - 140) doc.addPage();
      doc.fillColor(INK).fontSize(13).font('Helvetica-Bold').text(text);
      doc.moveDown(0.4);
    };

    const bullet = (text: string, sub?: string) => {
      if (doc.y > doc.page.height - 90) doc.addPage();
      doc.fillColor(INK).fontSize(10).font('Helvetica').text(`•  ${text}`, { width });
      if (sub) {
        doc.fillColor(MUTED).fontSize(9).font('Helvetica-Oblique').text(`    ${sub}`, { width });
      }
      doc.moveDown(0.3);
    };

    // --- Header
    doc.fillColor(ACCENT).fontSize(9).font('Helvetica-Bold').text('AI INTERVIEW PLATFORM', { characterSpacing: 1 });
    doc.moveDown(0.3);
    doc.fillColor(INK).fontSize(22).font('Helvetica-Bold').text('Candidate Evaluation Report');
    doc.moveDown(0.6);

    doc.fontSize(15).font('Helvetica-Bold').fillColor(INK).text(sc.candidate.name);
    doc.fontSize(10).font('Helvetica').fillColor(MUTED).text(sc.candidate.email + (sc.candidate.mobile ? `  ·  ${sc.candidate.mobile}` : ''));
    rule();

    // --- Facts
    const facts: Array<[string, string]> = [
      ['Role', sc.interviewSession.title],
      ['Interview type', sc.interviewSession.type],
      ['Experience level', sc.interviewSession.experienceLevel],
      ['Interview date', sc.completedAt ? sc.completedAt.toLocaleString() : sc.interviewSession.scheduledAt.toLocaleString()],
      ['Duration', details.meta?.durationMinutes ? `${details.meta.durationMinutes} minutes` : `${sc.interviewSession.durationMinutes} minutes (scheduled)`],
      ['Questions asked', String(details.meta?.questionsAsked ?? '—')],
      ['Identity verified', details.meta?.identityVerified ? 'Yes' : 'Not confirmed'],
    ];

    doc.fontSize(10);
    for (const [label, value] of facts) {
      const y = doc.y;
      doc.font('Helvetica').fillColor(MUTED).text(label, 48, y, { width: 140 });
      doc.font('Helvetica-Bold').fillColor(INK).text(value, 188, y, { width: width - 140 });
      doc.moveDown(0.25);
    }
    rule();

    // --- Recommendation banner
    doc.fontSize(9).font('Helvetica').fillColor(MUTED).text('HIRING RECOMMENDATION', { characterSpacing: 0.6 });
    doc.moveDown(0.2);
    doc.fontSize(20).font('Helvetica-Bold').fillColor(ACCENT).text(RECOMMENDATION_LABEL[report.hiringRecommendation] ?? report.hiringRecommendation);
    if (report.recommendationReason) {
      doc.moveDown(0.2);
      doc.fontSize(10).font('Helvetica').fillColor(MUTED).text(report.recommendationReason, { width });
    }
    rule();

    // --- Scores
    heading('Scores');
    // The verdict in two halves — soft skills and hard skills — above the
    // individual dimensions they average. The evaluator works these out and
    // stores them, because the overall is their mean; deriving them again here
    // is how this page once came to disagree with the number above it. Older
    // reports predate the stored pair, so they still get the local fallback.
    const { soft: softAvg, hard: hardAvg } = reportHalves(report);

    const scoreRows: Array<[string, number | null]> = [
      ['Overall rating', report.overallRating],
      ['Communication & behavioural', softAvg],
      ['Technical & coding', hardAvg],
      ['Technical', report.technicalScore],
      ['Communication', report.communicationScore],
      ['Behavioral', report.behavioralScore],
      ['Coding', report.codingScore],
      ['Video confidence', report.videoConfidenceScore],
    ];

    for (const [label, value] of scoreRows) {
      if (value == null) continue;
      const y = doc.y;
      doc.font('Helvetica').fontSize(10).fillColor(INK).text(label, 48, y, { width: 160 });

      // Score bar
      const barX = 212;
      const barW = 220;
      doc.roundedRect(barX, y + 2, barW, 8, 4).fillColor(RULE).fill();
      doc.roundedRect(barX, y + 2, Math.max(2, (value / 10) * barW), 8, 4).fillColor(ACCENT).fill();

      doc.font('Helvetica-Bold').fontSize(10).fillColor(INK).text(`${value.toFixed(1)} / 10`, barX + barW + 12, y, { width: 80 });
      doc.moveDown(0.45);
    }

    if (details.communication) {
      doc.moveDown(0.4);
      const c = details.communication;
      doc.font('Helvetica').fontSize(9).fillColor(MUTED).text(
        `Communication breakdown — fluency ${c.fluency}, confidence ${c.confidence}, clarity ${c.clarity}, grammar ${c.grammar}, vocabulary ${c.vocabulary}, pace ${c.pace}`,
        { width },
      );
    }
    rule();

    // --- Summary
    if (report.summary) {
      heading('Summary');
      doc.font('Helvetica').fontSize(10).fillColor(INK).text(report.summary, { width, align: 'left' });
      rule();
    }

    // --- Strengths / weaknesses
    if (details.strengths?.length) {
      heading('Strengths');
      details.strengths.forEach((s) => bullet(s.point, s.evidence));
      doc.moveDown(0.4);
    }

    if (details.weaknesses?.length) {
      heading('Weaknesses');
      details.weaknesses.forEach((w) => bullet(w.point, w.evidence));
      doc.moveDown(0.4);
    }

    if (details.improvements?.length) {
      heading('Areas for improvement');
      details.improvements.forEach((i) => bullet(i));
      doc.moveDown(0.4);
    }

    if (details.redFlags?.length) {
      heading('Red flags');
      details.redFlags.forEach((f) => bullet(f));
      doc.moveDown(0.4);
    }

    // --- Skills
    if (details.skillBreakdown?.length) {
      heading('Skill assessment');
      details.skillBreakdown.forEach((s) => bullet(`${s.skill} — ${s.score.toFixed(1)}/10`, s.evidence));
      doc.moveDown(0.4);
    }

    // --- Coding
    if (details.coding?.length) {
      heading('Coding assessment');
      details.coding.forEach((c) =>
        bullet(
          `${c.questionTitle} (${c.language}) — ${c.passedCases}/${c.totalCases} test cases passed`,
          `Complexity ${c.timeComplexity ?? 'unknown'} · quality ${c.qualityScore ?? '—'}/10`,
        ),
      );
      doc.moveDown(0.4);
    }

    // --- Video
    if (details.video) {
      heading('On-camera presence');
      doc.font('Helvetica').fontSize(10).fillColor(INK).text(
        `Face visible ${Math.round(details.video.avgFacePresence * 100)}% of the time · eye-contact stability ${Math.round(details.video.avgGazeStability * 100)}% · dominant expression ${details.video.dominantExpression.toLowerCase()}`,
        { width },
      );
      doc.moveDown(0.3);
      details.video.observations.forEach((o) => bullet(o));
      doc.moveDown(0.4);
    }

    // --- AI feedback
    if (report.aiFeedback) {
      heading('AI feedback for the hiring team');
      doc.font('Helvetica').fontSize(10).fillColor(INK).text(report.aiFeedback, { width });
      rule();
    }

    // --- Transcript
    const turns = sc.transcript?.turns ?? [];
    if (turns.length) {
      doc.addPage();
      doc.fillColor(INK).fontSize(16).font('Helvetica-Bold').text('Interview transcript');
      doc.moveDown(0.8);

      for (const turn of turns) {
        if (turn.speaker === 'SYSTEM') continue;
        if (doc.y > doc.page.height - 100) doc.addPage();

        const isAi = turn.speaker === 'AI';
        doc.font('Helvetica-Bold').fontSize(9).fillColor(isAi ? ACCENT : INK).text(isAi ? 'INTERVIEWER' : 'CANDIDATE');
        doc.font('Helvetica').fontSize(10).fillColor(INK).text(turn.text, { width });
        doc.moveDown(0.5);
      }
    }

    doc.end();
  }

  // -------------------------------------------------------------------------
  // Excel
  // -------------------------------------------------------------------------

  private static styleHeader(row: ExcelJS.Row) {
    row.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
    row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4F46E5' } };
    row.alignment = { vertical: 'middle' };
    row.height = 22;
  }

  static async reportExcel(reportId: string, res: Response) {
    const report = await this.loadReport(reportId);
    const sc = report.sessionCandidate;
    const details = (report.details ?? {}) as Details;

    const wb = new ExcelJS.Workbook();
    wb.creator = 'AI Interview Platform';

    // --- Overview
    const overview = wb.addWorksheet('Overview');
    overview.columns = [
      { header: 'Field', key: 'field', width: 28 },
      { header: 'Value', key: 'value', width: 60 },
    ];
    this.styleHeader(overview.getRow(1));

    [
      ['Candidate', sc.candidate.name],
      ['Email', sc.candidate.email],
      ['Mobile', sc.candidate.mobile ?? '—'],
      ['Role', sc.interviewSession.title],
      ['Interview type', sc.interviewSession.type],
      ['Experience level', sc.interviewSession.experienceLevel],
      ['Interview date', sc.completedAt?.toLocaleString() ?? '—'],
      ['Duration (minutes)', details.meta?.durationMinutes ?? '—'],
      ['Questions asked', details.meta?.questionsAsked ?? '—'],
      ['Identity verified', details.meta?.identityVerified ? 'Yes' : 'No'],
      ['Recommendation', RECOMMENDATION_LABEL[report.hiringRecommendation] ?? report.hiringRecommendation],
      ['Reason', report.recommendationReason ?? '—'],
      ['Summary', report.summary ?? '—'],
    ].forEach(([field, value]) => overview.addRow({ field, value }));

    // --- Scores
    const scores = wb.addWorksheet('Scores');
    scores.columns = [
      { header: 'Category', key: 'category', width: 20 },
      { header: 'Metric', key: 'label', width: 28 },
      { header: 'Score', key: 'value', width: 12 },
      { header: 'Out of', key: 'max', width: 10 },
      { header: 'Evidence', key: 'evidence', width: 70 },
    ];
    this.styleHeader(scores.getRow(1));

    for (const s of report.scores) {
      scores.addRow({ category: s.category, label: s.label, value: s.value, max: s.maxValue, evidence: s.evidence ?? '' });
    }

    // --- Feedback
    const feedback = wb.addWorksheet('Feedback');
    feedback.columns = [
      { header: 'Type', key: 'type', width: 22 },
      { header: 'Point', key: 'point', width: 52 },
      { header: 'Evidence', key: 'evidence', width: 70 },
    ];
    this.styleHeader(feedback.getRow(1));

    details.strengths?.forEach((s) => feedback.addRow({ type: 'Strength', point: s.point, evidence: s.evidence ?? '' }));
    details.weaknesses?.forEach((w) => feedback.addRow({ type: 'Weakness', point: w.point, evidence: w.evidence ?? '' }));
    details.improvements?.forEach((i) => feedback.addRow({ type: 'Improvement', point: i, evidence: '' }));
    details.redFlags?.forEach((f) => feedback.addRow({ type: 'Red flag', point: f, evidence: '' }));

    // --- Coding
    if (details.coding?.length) {
      const coding = wb.addWorksheet('Coding');
      coding.columns = [
        { header: 'Problem', key: 'title', width: 34 },
        { header: 'Language', key: 'language', width: 14 },
        { header: 'Passed', key: 'passed', width: 10 },
        { header: 'Total', key: 'total', width: 10 },
        { header: 'Time complexity', key: 'time', width: 20 },
        { header: 'Quality', key: 'quality', width: 12 },
      ];
      this.styleHeader(coding.getRow(1));

      details.coding.forEach((c) =>
        coding.addRow({
          title: c.questionTitle,
          language: c.language,
          passed: c.passedCases,
          total: c.totalCases,
          time: c.timeComplexity ?? '—',
          quality: c.qualityScore ?? '—',
        }),
      );
    }

    // --- Transcript
    const transcript = wb.addWorksheet('Transcript');
    transcript.columns = [
      { header: 'Time', key: 'time', width: 22 },
      { header: 'Speaker', key: 'speaker', width: 14 },
      { header: 'Round', key: 'round', width: 16 },
      { header: 'Text', key: 'text', width: 100 },
    ];
    this.styleHeader(transcript.getRow(1));

    for (const turn of sc.transcript?.turns ?? []) {
      transcript.addRow({
        time: turn.timestamp.toLocaleTimeString(),
        speaker: turn.speaker,
        round: turn.round ?? '',
        text: turn.text,
      });
    }
    transcript.getColumn('text').alignment = { wrapText: true, vertical: 'top' };

    const safeName = sc.candidate.name.replace(/[^a-zA-Z0-9]/g, '_');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="Interview_Report_${safeName}.xlsx"`);
    await wb.xlsx.write(res);
    res.end();
  }

  /** Whole-session comparison workbook for the recruiter. */
  static async sessionExcel(sessionId: string, res: Response) {
    const session = await prisma.interviewSession.findUnique({ where: { id: sessionId } });
    if (!session) throw new Error('Session not found');

    const ranked = await RankingService.rankSession(sessionId);

    const wb = new ExcelJS.Workbook();
    wb.creator = 'AI Interview Platform';

    const info = wb.addWorksheet('Session');
    info.columns = [
      { header: 'Field', key: 'field', width: 26 },
      { header: 'Value', key: 'value', width: 70 },
    ];
    this.styleHeader(info.getRow(1));

    [
      ['Title', session.title],
      ['Type', session.type],
      ['Experience level', session.experienceLevel],
      ['Skills', session.skills.join(', ')],
      ['Scheduled at', session.scheduledAt.toLocaleString()],
      ['Duration (minutes)', session.durationMinutes],
      ['Status', session.status],
      ['Candidates', ranked.length],
      ['Evaluated', ranked.filter((r) => r.reportId).length],
      ['Job description', session.jobDescription],
    ].forEach(([field, value]) => info.addRow({ field, value }));

    const sheet = wb.addWorksheet('Candidates');
    sheet.columns = [
      { header: 'Rank', key: 'rank', width: 8 },
      { header: 'Name', key: 'name', width: 26 },
      { header: 'Email', key: 'email', width: 30 },
      { header: 'Mobile', key: 'mobile', width: 18 },
      { header: 'Status', key: 'status', width: 14 },
      { header: 'Overall', key: 'overall', width: 10 },
      { header: 'Technical', key: 'technical', width: 11 },
      { header: 'Communication', key: 'communication', width: 15 },
      { header: 'Behavioral', key: 'behavioral', width: 12 },
      { header: 'Coding', key: 'coding', width: 10 },
      { header: 'Recommendation', key: 'recommendation', width: 18 },
      { header: 'Top strength', key: 'strength', width: 46 },
      { header: 'Top weakness', key: 'weakness', width: 46 },
    ];
    this.styleHeader(sheet.getRow(1));

    for (const r of ranked) {
      sheet.addRow({
        rank: r.rank || '—',
        name: r.name,
        email: r.email,
        mobile: r.mobile ?? '',
        status: r.status,
        overall: r.reportId ? r.overall : '',
        technical: r.reportId ? r.technical : '',
        communication: r.reportId ? r.communication : '',
        behavioral: r.reportId ? r.behavioral : '',
        coding: r.coding ?? '',
        recommendation: r.recommendation ? RECOMMENDATION_LABEL[r.recommendation] : 'Not evaluated',
        strength: r.strengths[0] ?? '',
        weakness: r.weaknesses[0] ?? '',
      });
    }

    // Colour-code the recommendation column so the sheet is scannable.
    const palette: Record<string, string> = {
      'Strong Hire': 'FFDCFCE7',
      Hire: 'FFE0E7FF',
      Consider: 'FFFEF3C7',
      Reject: 'FFFEE2E2',
    };
    sheet.eachRow((row, i) => {
      if (i === 1) return;
      const cell = row.getCell('recommendation');
      const fill = palette[String(cell.value)];
      if (fill) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fill } };
    });

    const safeTitle = session.title.replace(/[^a-zA-Z0-9]/g, '_');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="Session_${safeTitle}.xlsx"`);
    await wb.xlsx.write(res);
    res.end();
  }
}
