import Papa from 'papaparse';
import * as XLSX from 'xlsx';
import { emailField, mobileField } from '../lib/candidateFields';
import { isSupportedMeetingLink } from './meetingBot/platforms';

/**
 * Turns a recruiter's spreadsheet into candidate rows the booking endpoint can
 * accept.
 *
 * The job of this file is to be forgiving about *shape* and strict about
 * *content*. A recruiter exports from whatever system they already use, so the
 * columns arrive named a dozen different ways, in any order, with blank rows
 * and stray whitespace. None of that is the recruiter's mistake to fix by hand.
 * A malformed email is, and it is reported against the row and column it came
 * from rather than failing the whole file.
 */

export interface ImportedRow {
  /** 1-based row number in the recruiter's file, so errors point at what they see. */
  row: number;
  name: string;
  email: string;
  mobile?: string;
  meetLink?: string;
  scheduledAt?: string;
  /**
   * Per-row overrides for what is otherwise set once on the booking form. All
   * optional: a blank cell means "use the form's value", so a file that only
   * lists names and emails still works exactly as before. Kept as the strings
   * the recruiter typed (skills stay comma-separated, duration stays text) so
   * the preview table can show and edit them as-is; they are normalised at
   * booking time.
   */
  jobTitle?: string;
  experienceLevel?: string;
  jobDescription?: string;
  requiredSkills?: string;
  durationMinutes?: string;
  type?: string;
  personality?: string;
  language?: string;
  codingEnabled?: string;
  /** Field name -> what is wrong with it. Empty when the row is usable. */
  errors: Record<string, string>;
}

export interface ImportResult {
  rows: ImportedRow[];
  /** Headers we could not map, kept so the recruiter can see what was ignored. */
  ignoredColumns: string[];
  /** Rows that were entirely blank and silently dropped. */
  blankRowsSkipped: number;
}

/**
 * Column headings we accept, lowest-common-denominator first.
 *
 * Matching is done on a squashed form of the heading (lowercased, everything
 * that is not a letter or digit removed), so "Mobile Number", "mobile_number"
 * and "Mobile-No." all collapse to the same key. Order matters: the first
 * alias that matches wins, which is why the exact names come before the loose
 * ones — "name" must not swallow a column called "Company Name".
 */
const COLUMN_ALIASES: Record<keyof Omit<ImportedRow, 'row' | 'errors'>, string[]> = {
  name: ['candidatename', 'fullname', 'name', 'candidate'],
  email: ['candidateemail', 'emailaddress', 'email', 'mail', 'emailid'],
  mobile: ['mobilenumber', 'phonenumber', 'mobile', 'phone', 'contactnumber', 'contact', 'mobileno', 'phoneno'],
  meetLink: ['meetinglink', 'meetlink', 'meetingurl', 'link', 'meetingroom', 'joinlink', 'url'],
  scheduledAt: [
    'sessiondatetime',
    'datetime',
    'scheduledat',
    'interviewdatetime',
    'sessiondate',
    'interviewdate',
    'date',
  ],
  jobTitle: ['jobtitle', 'jobrole', 'position', 'designation', 'role', 'title'],
  experienceLevel: ['experiencelevel', 'experience', 'seniority', 'level'],
  jobDescription: ['jobdescription', 'roledescription', 'description', 'jd'],
  requiredSkills: ['requiredskills', 'skillset', 'keyskills', 'skills', 'technologies'],
  durationMinutes: ['interviewduration', 'durationminutes', 'duration'],
  type: ['interviewtype', 'roundtype', 'type'],
  personality: ['interviewerpersonality', 'personality', 'tone'],
  language: ['interviewlanguage', 'language'],
  codingEnabled: ['codinground', 'codingenabled', 'codingexercise', 'includecoding', 'coding'],
};

/** A second date column, merged with the first when the file splits them. */
const TIME_ALIASES = ['sessiontime', 'interviewtime', 'time', 'starttime'];

const squash = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Rounds to the nearest minute on the way out of a spreadsheet.
 *
 * Excel keeps a date as a fraction of a day, so a cell holding 11:15 comes back
 * as 11:14:59.999 once the float has been through a division. Nobody schedules
 * an interview to the second, and an invitation that reads 11:14 for a meeting
 * the recruiter typed as 11:15 looks like the system got it wrong.
 */
const toMinute = (d: Date): string => new Date(Math.round(d.getTime() / 60_000) * 60_000).toISOString();

export class CandidateImportService {
  /**
   * Reads a .csv, .xlsx or .xls buffer into rows.
   *
   * Throws only when the file itself is unreadable. A file that parses but is
   * full of bad data comes back as rows carrying their own errors, because
   * that is something the recruiter can fix in the preview without going back
   * to their spreadsheet.
   */
  static parse(buffer: Buffer, filename: string): ImportResult {
    const table = filename.toLowerCase().endsWith('.csv')
      ? this.readCsv(buffer)
      : this.readSpreadsheet(buffer);

    if (table.length === 0) throw new Error('That file has no rows in it.');

    const [header, ...body] = table;
    const { map, timeColumn, ignoredColumns } = this.mapColumns(header);

    if (map.name === undefined || map.email === undefined) {
      throw new Error(
        'The file needs a name column and an email column. Download the template if you are not sure of the headings.',
      );
    }

    const rows: ImportedRow[] = [];
    let blankRowsSkipped = 0;

    body.forEach((cells, i) => {
      if (cells.every((c) => c.trim() === '')) {
        blankRowsSkipped++;
        return;
      }

      const at = (key: keyof typeof map): string => {
        const index = map[key];
        return index === undefined ? '' : (cells[index] ?? '').trim();
      };

      const datePart = at('scheduledAt');
      const timePart = timeColumn === undefined ? '' : (cells[timeColumn] ?? '').trim();

      rows.push(
        this.validate({
          // +2: one for the header, one because spreadsheets start at 1.
          row: i + 2,
          name: at('name'),
          email: at('email'),
          mobile: at('mobile'),
          meetLink: at('meetLink'),
          scheduledAt: this.joinDateAndTime(datePart, timePart),
          jobTitle: at('jobTitle'),
          experienceLevel: at('experienceLevel'),
          jobDescription: at('jobDescription'),
          requiredSkills: at('requiredSkills'),
          durationMinutes: at('durationMinutes'),
          type: at('type'),
          personality: at('personality'),
          language: at('language'),
          codingEnabled: at('codingEnabled'),
        }),
      );
    });

    return { rows, ignoredColumns, blankRowsSkipped };
  }

  /**
   * Checks one row, whether it came from a file or was edited in the preview.
   *
   * `meetLink` and `scheduledAt` are optional here: the booking form carries a
   * link and a time that apply to everyone, and a file that leaves those
   * columns out is a perfectly ordinary way to book one slot for a shortlist.
   * They are only checked when present.
   */
  static validate(input: Omit<ImportedRow, 'errors'>): ImportedRow {
    const errors: Record<string, string> = {};

    const name = input.name.trim();
    if (name.length < 2) errors.name = 'Enter the candidate’s name';

    const email = emailField.safeParse(input.email);
    if (!email.success) errors.email = email.error.issues[0]?.message ?? 'Enter a valid email address';

    const mobile = mobileField.safeParse(input.mobile);
    if (!mobile.success) errors.mobile = mobile.error.issues[0]?.message ?? 'Check this mobile number';

    const meetLink = input.meetLink?.trim();
    if (meetLink && !isSupportedMeetingLink(meetLink)) {
      errors.meetLink = 'Paste a Google Meet, Zoom or Microsoft Teams link';
    }

    const scheduledAt = input.scheduledAt?.trim();
    let isoDate: string | undefined;
    if (scheduledAt) {
      const parsed = this.parseDate(scheduledAt);
      if (!parsed) errors.scheduledAt = 'Use a date and time like 2026-08-14 15:00';
      else isoDate = parsed;
    }

    // The per-row overrides. All optional — a blank cell inherits from the
    // form — so each is only checked when the recruiter actually filled it in.
    // Recognised values are rewritten to their canonical form so the preview
    // shows what will actually be booked; unrecognised ones are kept as typed,
    // with the error printed underneath, so the recruiter sees their own text.
    const jobTitle = input.jobTitle?.trim() || undefined;
    if (jobTitle && jobTitle.length < 2) errors.jobTitle = 'Enter the job title';

    const jobDescription = input.jobDescription?.trim() || undefined;
    if (jobDescription && jobDescription.length < 30) {
      errors.jobDescription = 'Needs at least 30 characters to generate useful questions';
    }

    const requiredSkills = input.requiredSkills?.trim() || undefined;

    const experienceLevel = input.experienceLevel?.trim()
      ? this.normalizeExperienceLevel(input.experienceLevel)
      : undefined;

    // Recognised enum values are shown in the preview by their form labels
    // ("Behavioural", not "HR") — they normalise back at booking time.
    let type = input.type?.trim() || undefined;
    if (type) {
      const canonical = this.normalizeType(type);
      if (!canonical) errors.type = 'Use Technical, Behavioural or Mixed';
      else type = { TECHNICAL: 'Technical', HR: 'Behavioural', MIXED: 'Mixed' }[canonical];
    }

    let personality = input.personality?.trim() || undefined;
    if (personality) {
      const canonical = this.normalizePersonality(personality);
      if (!canonical) errors.personality = 'Use Friendly, Neutral, Formal or Challenging';
      else {
        personality = { FRIENDLY: 'Friendly', NEUTRAL: 'Neutral', FORMAL: 'Formal', CHALLENGING: 'Challenging' }[
          canonical
        ];
      }
    }

    let language = input.language?.trim() || undefined;
    if (language) {
      const canonical = this.normalizeLanguage(language);
      if (!canonical) errors.language = 'Use a language like English (US), Hindi, or a code like en-US';
      else language = canonical;
    }

    let durationMinutes = input.durationMinutes?.trim() || undefined;
    if (durationMinutes) {
      const mins = this.parseDurationMinutes(durationMinutes);
      if (mins === undefined) errors.durationMinutes = 'Use a number of minutes from 10 to 180';
      else durationMinutes = String(mins);
    }

    let codingEnabled = input.codingEnabled?.trim() || undefined;
    if (codingEnabled) {
      const parsed = this.parseYesNo(codingEnabled);
      if (parsed === undefined) errors.codingEnabled = 'Use yes or no';
      else codingEnabled = parsed ? 'Yes' : 'No';
    }

    return {
      row: input.row,
      name,
      email: email.success ? email.data : input.email.trim(),
      mobile: mobile.success ? mobile.data : input.mobile?.trim(),
      meetLink: meetLink || undefined,
      scheduledAt: isoDate ?? (scheduledAt || undefined),
      jobTitle,
      experienceLevel,
      jobDescription,
      requiredSkills,
      durationMinutes,
      type,
      personality,
      language,
      codingEnabled,
      errors,
    };
  }

  // -------------------------------------------------------------------------
  // Normalising what recruiters actually type
  //
  // Shared with the booking endpoint, so a value that passed the preview and a
  // value typed straight into the preview table are judged by the same rules.
  // -------------------------------------------------------------------------

  static normalizeType(value: string): 'TECHNICAL' | 'HR' | 'MIXED' | undefined {
    const s = squash(value);
    if (['technical', 'tech'].includes(s)) return 'TECHNICAL';
    if (['hr', 'behavioural', 'behavioral', 'behaviour', 'behavior'].includes(s)) return 'HR';
    if (['mixed', 'both', 'general'].includes(s)) return 'MIXED';
    return undefined;
  }

  static normalizePersonality(value: string): 'FRIENDLY' | 'NEUTRAL' | 'FORMAL' | 'CHALLENGING' | undefined {
    const s = squash(value);
    if (['friendly', 'warm', 'casual'].includes(s)) return 'FRIENDLY';
    if (['neutral', 'balanced'].includes(s)) return 'NEUTRAL';
    if (['formal', 'professional'].includes(s)) return 'FORMAL';
    if (['challenging', 'tough', 'strict'].includes(s)) return 'CHALLENGING';
    return undefined;
  }

  /** "Hindi", "English (US)" and "en-us" all land on the locale code. */
  static normalizeLanguage(value: string): string | undefined {
    const NAMES: Record<string, string> = {
      enus: 'en-US',
      english: 'en-US',
      englishus: 'en-US',
      americanenglish: 'en-US',
      engb: 'en-GB',
      englishuk: 'en-GB',
      britishenglish: 'en-GB',
      enin: 'en-IN',
      englishindia: 'en-IN',
      indianenglish: 'en-IN',
      hiin: 'hi-IN',
      hindi: 'hi-IN',
      eses: 'es-ES',
      spanish: 'es-ES',
      espanol: 'es-ES',
      frfr: 'fr-FR',
      french: 'fr-FR',
      francais: 'fr-FR',
    };
    const named = NAMES[squash(value)];
    if (named) return named;

    // Any well-formed locale code passes through, so a language this map has
    // not heard of is not blocked — the interviewer speaks what the LLM and
    // TTS between them support, not what this list knows.
    const code = value.trim().match(/^([a-z]{2})[-_]([a-z]{2})$/i);
    return code ? `${code[1]!.toLowerCase()}-${code[2]!.toUpperCase()}` : undefined;
  }

  /**
   * Best effort, never fails: the canonical labels exist so the question
   * generator gets a level it recognises, but experience is stored as free
   * text, so "8 years in fintech" is kept rather than rejected.
   */
  static normalizeExperienceLevel(value: string): string {
    const s = squash(value);
    if (/fresher|intern|graduate|entry|01year/.test(s)) return 'Fresher (0-1 years)';
    if (/junior|13year/.test(s)) return 'Junior (1-3 years)';
    if (/mid|35year/.test(s)) return 'Mid-level (3-5 years)';
    if (/senior|58year/.test(s)) return 'Senior (5-8 years)';
    if (/lead|principal|staff|8year|8plus/.test(s)) return 'Lead (8+ years)';
    return value.trim();
  }

  /** "30", "30 mins" and "30 minutes" are all 30. Range-checked like the form. */
  static parseDurationMinutes(value: string): number | undefined {
    const digits = String(value).match(/\d+/);
    if (!digits) return undefined;
    const mins = Number(digits[0]);
    return mins >= 10 && mins <= 180 ? mins : undefined;
  }

  static parseYesNo(value: string): boolean | undefined {
    const s = squash(String(value));
    if (['yes', 'y', 'true', '1', 'enabled', 'include', 'included', 'on'].includes(s)) return true;
    if (['no', 'n', 'false', '0', 'none', 'disabled', 'off'].includes(s)) return false;
    return undefined;
  }

  /** One cell, many skills. Semicolons and pipes too — commas split CSV cells in some exports. */
  static splitSkills(value: string): string[] {
    return value
      .split(/[,;|]/)
      .map((s) => s.trim())
      .filter(Boolean);
  }

  /**
   * The headings the template ships with, and what the parser prefers to see.
   *
   * Only the first three are about the candidate. Everything after is a
   * per-row override of the booking form — a recruiter hiring for one role
   * deletes those columns and sets the role once on the form, a recruiter
   * booking a mixed batch fills them in per row.
   */
  static templateHeader(): string[] {
    return [
      'Candidate Name',
      'Mobile Number',
      'Email Address',
      'Meeting Link',
      'Session Date Time',
      'Job Title',
      'Experience Level',
      'Job Description',
      'Required Skills',
      'Interview Duration',
      'Interview Type',
      'Personality',
      'Language',
      'Coding Round',
    ];
  }

  static templateCsv(): string {
    const example = [
      'Priyanshu Raj',
      '+91 98765 43210',
      'priyanshu@example.com',
      'https://meet.google.com/abc-defg-hij',
      '2026-08-14 15:00',
      'Frontend Developer',
      'Mid-level (3-5 years)',
      'Builds and maintains our React dashboard, owns component quality, and works closely with design and the API team.',
      'React; TypeScript; Node.js',
      '30',
      'Mixed',
      'Friendly',
      'English (US)',
      'No',
    ];
    return Papa.unparse([this.templateHeader(), example]) + '\n';
  }

  // -------------------------------------------------------------------------
  // Reading
  // -------------------------------------------------------------------------

  private static readCsv(buffer: Buffer): string[][] {
    // BOM first: Excel writes one on CSV export, and it otherwise ends up glued
    // to the first heading, where it stops "Candidate Name" from matching.
    const text = buffer.toString('utf8').replace(/^﻿/, '');
    const parsed = Papa.parse<string[]>(text, { skipEmptyLines: 'greedy' });

    if (parsed.errors.length && parsed.data.length === 0) {
      throw new Error(`That CSV could not be read: ${parsed.errors[0]?.message ?? 'unknown error'}`);
    }

    return parsed.data.map((row) => row.map((cell) => String(cell ?? '')));
  }

  private static readSpreadsheet(buffer: Buffer): string[][] {
    let book: XLSX.WorkBook;
    try {
      // cellDates so a real date cell arrives as a Date rather than Excel's
      // serial number, which would otherwise reach the recruiter as "45883".
      book = XLSX.read(buffer, { type: 'buffer', cellDates: true });
    } catch (err) {
      throw new Error(`That spreadsheet could not be read: ${(err as Error).message}`);
    }

    const sheetName = book.SheetNames[0];
    if (!sheetName) throw new Error('That spreadsheet has no sheets in it.');

    const sheet = book.Sheets[sheetName]!;
    if (!sheet['!ref']) return [];
    const range = XLSX.utils.decode_range(sheet['!ref']);

    // Walked by hand rather than via sheet_to_json, because the two kinds of
    // cell want opposite treatment and that helper can only do one.
    //
    // A date cell must be taken raw: asking for its formatted text renders it
    // through its own number format, and Excel's default for a date is
    // date-only — so "20 Aug 11:15" came back as "8/20/26" and every interview
    // in the file was silently booked for midnight.
    //
    // Everything else wants the opposite. A mobile number typed as digits is
    // stored as a number, and its raw value has already lost any leading zero;
    // the formatted text is what the recruiter actually sees in the cell.
    const rows: string[][] = [];

    for (let r = range.s.r; r <= range.e.r; r++) {
      const cells: string[] = [];
      for (let c = range.s.c; c <= range.e.c; c++) {
        const cell = sheet[XLSX.utils.encode_cell({ r, c })] as XLSX.CellObject | undefined;

        if (!cell) cells.push('');
        else if (cell.t === 'd' && cell.v instanceof Date) cells.push(toMinute(cell.v));
        else cells.push(String(cell.w ?? cell.v ?? '').trim());
      }
      rows.push(cells);
    }

    return rows;
  }

  private static mapColumns(header: string[]): {
    map: Partial<Record<keyof typeof COLUMN_ALIASES, number>>;
    timeColumn?: number;
    ignoredColumns: string[];
  } {
    const squashed = header.map(squash);
    const map: Partial<Record<keyof typeof COLUMN_ALIASES, number>> = {};
    const claimed = new Set<number>();

    for (const [field, aliases] of Object.entries(COLUMN_ALIASES) as Array<
      [keyof typeof COLUMN_ALIASES, string[]]
    >) {
      for (const alias of aliases) {
        const index = squashed.findIndex((h, i) => h === alias && !claimed.has(i));
        if (index !== -1) {
          map[field] = index;
          claimed.add(index);
          break;
        }
      }
    }

    const timeIndex = squashed.findIndex((h, i) => TIME_ALIASES.includes(h) && !claimed.has(i));
    if (timeIndex !== -1) claimed.add(timeIndex);

    const ignoredColumns = header.filter((h, i) => !claimed.has(i) && h.trim() !== '');

    return { map, timeColumn: timeIndex === -1 ? undefined : timeIndex, ignoredColumns };
  }

  /** "2026-08-14" + "15:00" -> "2026-08-14 15:00". Either half may be missing. */
  private static joinDateAndTime(date: string, time: string): string {
    if (!date) return time;
    if (!time) return date;
    // A date cell that already carries a time wins; appending a second one
    // would produce nonsense like "2026-08-14T09:00:00Z 15:00".
    if (/\d{1,2}:\d{2}/.test(date)) return date;
    return `${date} ${time}`;
  }

  /**
   * Reads the date formats a spreadsheet actually produces.
   *
   * `new Date(string)` alone is not enough and is worse than useless where it
   * is wrong: it reads "14/08/2026" as an invalid date in some runtimes and as
   * a US month/day in others. Day-first and month-first cannot be told apart
   * from the text, so the unambiguous forms are handled explicitly and the
   * ambiguous one is read day-first, matching the template and the locale this
   * is used in.
   */
  private static parseDate(input: string): string | undefined {
    const text = input.trim();

    const dmy = text.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})(?:[ T]+(\d{1,2}):(\d{2}))?/);
    if (dmy) {
      const [, a, b, y, hh = '0', mm = '0'] = dmy;
      const day = Number(a);
      const month = Number(b);
      // 13+ in the first position can only be a day, so month-first files still
      // land correctly; anything else follows the template's day-first order.
      const [d, m] = month > 12 ? [month, day] : [day, month];
      const date = new Date(Number(y), m - 1, d, Number(hh), Number(mm));
      return Number.isNaN(date.getTime()) || date.getMonth() !== m - 1 ? undefined : date.toISOString();
    }

    // ISO and "2026-08-14 15:00" both go through Date directly, which reads
    // them the same way everywhere.
    const iso = new Date(text.includes('T') || !text.includes(' ') ? text : text.replace(' ', 'T'));
    return Number.isNaN(iso.getTime()) ? undefined : iso.toISOString();
  }
}
