import fs from 'fs';
import path from 'path';
import { ResumeService } from '../src/services/ResumeService';

(async () => {
  const buffer = fs.readFileSync(path.resolve(__dirname, 'test-resume.pdf'));

  console.log('1. Extract text from PDF');
  const extracted = await ResumeService.extractText(buffer, 'test-resume.pdf', 'application/pdf');
  const text = ResumeService.normalise(extracted.text);
  console.log(`   ${text.length} chars, ${extracted.pages} page(s)`);
  console.log(`   first line: ${text.split('\n')[0]}`);

  console.log('\n2. Analyse against a job description');
  const profile = await ResumeService.analyse({
    resumeText: text,
    jobTitle: 'Senior Backend Engineer',
    jobDescription:
      'Own our payments platform. Design high-throughput services in Node.js and TypeScript, model data in PostgreSQL, run Kubernetes in production, and take responsibility for reliability and on-call.',
    requiredSkills: ['Node.js', 'TypeScript', 'PostgreSQL', 'Kubernetes', 'System Design'],
    experienceLevel: 'Senior (5-8 years)',
  });

  console.log(`   name          : ${profile.fullName}`);
  console.log(`   headline      : ${profile.headline}`);
  console.log(`   years         : ${profile.totalYearsExperience}`);
  console.log(`   skills        : ${profile.skills.join(', ')}`);
  console.log(`   roles         : ${profile.roles.map((r) => `${r.title}@${r.company}`).join(' | ')}`);
  console.log(`   projects      : ${profile.projects.map((p) => p.name).join(', ')}`);
  console.log(`   MISSING skills: ${profile.missingJdSkills.join(', ') || '(none)'}`);
  console.log('   claims to probe:');
  profile.claimsToProbe.forEach((c) => console.log(`     - ${c}`));

  console.log('\n3. Generate resume-specific questions');
  const questions = await ResumeService.buildQuestions({
    profile,
    resumeText: text,
    jobTitle: 'Senior Backend Engineer',
    requiredSkills: ['Node.js', 'TypeScript', 'PostgreSQL', 'Kubernetes', 'System Design'],
    experienceLevel: 'Senior (5-8 years)',
    count: 4,
  });

  questions.forEach((q, i) => {
    console.log(`   Q${i + 1}: ${q.text}`);
    if (q.probes) console.log(`       verifies: ${q.probes}`);
  });

  console.log('\n4. Prompt block handed to the live interviewer');
  const block = ResumeService.promptBlock(profile, text);
  console.log(block.split('\n').slice(0, 18).map((l) => `   ${l}`).join('\n'));

  // The interviewer must never be told to quote the document at the candidate.
  const leaks = /your resume says|your cv|it says here/i.test(block);
  console.log(`\n5. Prompt leaks "your resume says"? ${leaks ? 'YES (bug)' : 'no'}`);

  console.log('\nRESUME PIPELINE OK');
})().catch((err) => {
  console.error('RESUME PIPELINE FAILED:', err.message);
  process.exit(1);
});
