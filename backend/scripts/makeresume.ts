import PDFDocument from 'pdfkit';
import fs from 'fs';
import path from 'path';

const out = path.resolve(__dirname, 'test-resume.pdf');
const doc = new PDFDocument({ margin: 50 });
const stream = fs.createWriteStream(out);
doc.pipe(stream);

doc.fontSize(20).text('Priya Sharma');
doc.fontSize(10).text('Senior Backend Engineer | priya.sharma@example.com | +91 98765 43210');
doc.moveDown();

doc.fontSize(13).text('SUMMARY');
doc
  .fontSize(10)
  .text(
    'Backend engineer with 6 years of experience building high-throughput payment systems in Node.js and TypeScript. Owned the payments platform at FinPay handling 40,000 transactions per day.',
  );
doc.moveDown();

doc.fontSize(13).text('EXPERIENCE');
doc.fontSize(11).text('Senior Backend Engineer, FinPay (2021 - Present)');
doc.fontSize(10).list([
  'Owned the payments service processing 40,000 transactions per day at 99.98 percent uptime.',
  'Migrated a single-table ledger to a double-entry design with zero downtime.',
  'Reduced p95 checkout latency from 2.1s to 180ms by eliminating an N+1 query.',
  'Set up the on-call rotation and wrote the incident runbooks for a team of 6.',
]);
doc.moveDown();

doc.fontSize(11).text('Backend Engineer, ShopStack (2019 - 2021)');
doc.fontSize(10).list([
  'Built internal tooling in Node.js and PostgreSQL.',
  'Implemented an event-driven inventory sync using RabbitMQ.',
]);
doc.moveDown();

doc.fontSize(13).text('PROJECTS');
doc.fontSize(10).list([
  'LedgerCore - a double-entry accounting library in TypeScript with property-based tests.',
  'QueryLens - a Postgres slow-query analyser that suggests missing indexes.',
]);
doc.moveDown();

doc.fontSize(13).text('SKILLS');
doc.fontSize(10).text('Node.js, TypeScript, PostgreSQL, Redis, RabbitMQ, Docker, REST APIs, System Design');
doc.moveDown();

doc.fontSize(13).text('EDUCATION');
doc.fontSize(10).text('B.Tech Computer Science, NIT Patna, 2019');

doc.end();
stream.on('finish', () => console.log('written to', out, fs.statSync(out).size, 'bytes'));
