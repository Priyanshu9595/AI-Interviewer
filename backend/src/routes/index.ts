import { Router } from 'express';
import multer from 'multer';
import { requireAuth } from '../lib/auth';
import { asyncHandler } from '../lib/http';

import * as auth from '../controllers/auth.controller';
import * as sessions from '../controllers/session.controller';
import * as candidates from '../controllers/candidate.controller';
import * as interview from '../controllers/interview.controller';
import * as meetInterview from '../controllers/meetInterview.controller';
import * as reports from '../controllers/report.controller';
import * as analytics from '../controllers/analytics.controller';
import * as ats from '../controllers/ats.controller';

const router = Router();

const sheetUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
});

const RESUME_TYPES = [
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/msword',
  'text/plain',
  'text/markdown',
];

const resumeUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ext = file.originalname.split('.').pop()?.toLowerCase() ?? '';
    cb(null, RESUME_TYPES.includes(file.mimetype) || ['pdf', 'docx', 'doc', 'txt', 'md'].includes(ext));
  },
});

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

// Signing up is two steps: a code to the address, then the account.
router.post('/auth/register/start', asyncHandler(auth.registerStart));
router.post('/auth/register/verify', asyncHandler(auth.registerVerify));
router.post('/auth/register/resend', asyncHandler(auth.registerResend));
router.post('/auth/login', asyncHandler(auth.login));
router.post('/auth/refresh', asyncHandler(auth.refresh));
router.post('/auth/logout', asyncHandler(auth.logout));
router.get('/auth/me', requireAuth, asyncHandler(auth.me));

// ---------------------------------------------------------------------------
// Candidate-facing interview room (token-authenticated, no login)
// ---------------------------------------------------------------------------

router.get('/interview/:token', asyncHandler(interview.getInterviewContext));
router.get('/interview/:token/transcript', asyncHandler(interview.getTranscript));
router.get('/interview/:token/coding', asyncHandler(interview.getCodingChallenge));
router.post('/interview/:token/code/run', asyncHandler(interview.runCode));
router.post('/interview/:token/code/hint', asyncHandler(interview.getCodingHint));
router.post('/interview/:token/video-metrics', asyncHandler(interview.postVideoMetrics));
router.get('/interview/:token/resume', asyncHandler(interview.getResumeStatus));
router.post('/interview/:token/resume', resumeUpload.single('resume'), asyncHandler(interview.uploadResume));

// ---------------------------------------------------------------------------
// Everything below requires a recruiter login
// ---------------------------------------------------------------------------

router.use(requireAuth);

// Sessions
router.get('/sessions/config', asyncHandler(sessions.getConfigOptions));
router.get('/sessions/upcoming', asyncHandler(sessions.getUpcoming));
router.post('/sessions/compare', asyncHandler(sessions.compareCandidates));
router.get('/sessions', asyncHandler(sessions.listSessions));
router.post('/sessions', asyncHandler(sessions.createSession));
router.get('/sessions/:id', asyncHandler(sessions.getSession));
router.patch('/sessions/:id', asyncHandler(sessions.updateSession));
router.delete('/sessions/:id', asyncHandler(sessions.deleteSession));
router.post('/sessions/:id/cancel', asyncHandler(sessions.cancelSession));

// Questions
router.post('/sessions/:id/questions/generate', asyncHandler(sessions.generateQuestions));
router.post('/sessions/:id/questions', asyncHandler(sessions.addQuestion));
router.patch('/sessions/:id/questions/:questionId', asyncHandler(sessions.updateQuestion));
router.delete('/sessions/:id/questions/:questionId', asyncHandler(sessions.deleteQuestion));

// Candidates
router.get('/sessions/:id/candidates', asyncHandler(candidates.listSessionCandidates));
router.post('/sessions/:id/candidates', asyncHandler(candidates.addCandidate));
router.post('/sessions/:id/candidates/bulk', sheetUpload.single('file'), asyncHandler(candidates.bulkUploadCandidates));
router.delete('/sessions/:id/candidates/:candidateId', asyncHandler(candidates.removeSessionCandidate));
router.post('/sessions/:id/candidates/:candidateId/resend', asyncHandler(candidates.resendInvite));
router.get('/candidates', asyncHandler(candidates.listAllCandidates));

// Ranking & export
router.get('/sessions/:id/leaderboard', asyncHandler(sessions.getLeaderboard));
router.get('/sessions/:id/shortlist', asyncHandler(sessions.getShortlist));
router.get('/sessions/:id/export.xlsx', asyncHandler(reports.downloadSessionExcel));

// AI interviews run inside a meeting link the recruiter already created.
// Declared before the parameterised routes below so `/interviews` itself is not
// swallowed by a path expecting an id.
router.get('/interviews/queue', asyncHandler(meetInterview.getMeetBotQueue));
router.get('/interviews/import/template', asyncHandler(meetInterview.downloadImportTemplate));
router.post(
  '/interviews/import/preview',
  sheetUpload.single('file'),
  asyncHandler(meetInterview.previewCandidateImport),
);
router.post('/interviews/bulk', asyncHandler(meetInterview.bulkCreateMeetInterviews));
router.get('/interviews', asyncHandler(meetInterview.listMeetInterviews));
router.post('/interviews', asyncHandler(meetInterview.createMeetInterview));
router.get('/interviews/:id', asyncHandler(meetInterview.getMeetInterview));
router.get('/interviews/:id/status', asyncHandler(meetInterview.getMeetInterviewStatus));
router.get('/interviews/:id/transcript', asyncHandler(meetInterview.getMeetInterviewTranscript));
router.post('/interviews/:id/start', asyncHandler(meetInterview.startMeetInterview));
router.post('/interviews/:id/stop', asyncHandler(meetInterview.stopMeetInterview));
router.post('/interviews/:id/report/retry', asyncHandler(meetInterview.retryMeetInterviewReport));

// Live interview inspection & evaluation
router.get('/interviews/:sessionCandidateId/insights', asyncHandler(interview.getLiveInsights));
router.get('/interviews/:sessionCandidateId/evaluation', asyncHandler(interview.getEvaluationStatus));
router.post('/interviews/:sessionCandidateId/evaluate', asyncHandler(interview.evaluateInterview));
router.get('/interviews/:sessionCandidateId/resume', asyncHandler(interview.getCandidateResume));
router.get('/interviews/:sessionCandidateId/resume/file', asyncHandler(interview.downloadResume));
router.post(
  '/interviews/:sessionCandidateId/resume',
  resumeUpload.single('resume'),
  asyncHandler(interview.uploadResumeForCandidate),
);
router.get('/interviews/:sessionCandidateId/report', asyncHandler(reports.getReportByCandidate));

// Reports
router.get('/reports/recent', asyncHandler(reports.listRecentReports));
router.get('/reports/:id', asyncHandler(reports.getReport));
router.get('/reports/:id/export.pdf', asyncHandler(reports.downloadReportPdf));
router.get('/reports/:id/export.xlsx', asyncHandler(reports.downloadReportExcel));
router.post('/reports/:id/feedback-email', asyncHandler(reports.sendFeedbackEmail));
router.patch('/reports/:id/recommendation', asyncHandler(reports.updateRecommendation));
router.post('/reports/:id/ats-sync', asyncHandler(reports.syncReportToAts));

// Analytics
router.get('/analytics/overview', asyncHandler(analytics.getOverview));
router.get('/analytics/skills', asyncHandler(analytics.getSkillAnalytics));
router.get('/analytics/sessions', asyncHandler(analytics.getSessionAnalytics));

// ATS
router.get('/ats/integrations', asyncHandler(ats.listIntegrations));
router.post('/ats/integrations', asyncHandler(ats.createIntegration));
router.delete('/ats/integrations/:id', asyncHandler(ats.deleteIntegration));
router.get('/ats/integrations/:id/logs', asyncHandler(ats.getSyncLogs));
router.post('/ats/integrations/:id/test', asyncHandler(ats.testIntegration));

export const apiRoutes = router;
