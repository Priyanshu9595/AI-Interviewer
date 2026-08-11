import { z } from 'zod';

/**
 * Field rules shared by the single-candidate form and the spreadsheet import,
 * so a row that a recruiter types and the same row in a CSV are judged
 * identically. Divergence here is the kind of bug that only shows up as "it
 * worked when I typed it".
 */

/**
 * A mobile number, kept as the recruiter wrote it.
 *
 * Deliberately permissive. This number is never dialled by the platform — it
 * exists so a recruiter can reach a candidate who has not turned up — so the
 * cost of rejecting a valid but unusual format is real and the benefit of
 * strictness is nil. Digits are counted rather than the shape being matched,
 * which catches a stray word or a truncated paste without ruling out country
 * codes, extensions or the way any particular country writes its numbers.
 */
export const mobileField = z
  .string()
  .trim()
  .optional()
  .transform((v) => (v && v.length > 0 ? v : undefined))
  .refine((v) => v === undefined || /^[+()\-\s./\d]+$/.test(v), 'A mobile number can only contain digits and + - ( ) . /')
  .refine((v) => {
    if (v === undefined) return true;
    const digits = v.replace(/\D/g, '').length;
    return digits >= 7 && digits <= 15;
  }, 'A mobile number needs between 7 and 15 digits');

/** Trimmed and lowercased, because an email is a key here and casing is not. */
export const emailField = z
  .string()
  .trim()
  .toLowerCase()
  .email('Enter a valid email address');
