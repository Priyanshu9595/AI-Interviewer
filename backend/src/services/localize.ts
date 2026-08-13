import { complete, SMART_MODEL } from '../lib/ai';
import { languageName } from './personality';

/**
 * Speaks the interview's scripted skeleton in the session's language.
 *
 * The conversational turns come from the LLM, whose system prompt already says
 * "speak Hindi" — but the fixed lines around them (the greeting, "how are you
 * doing today?", the microphone prompts, the hand-offs between rounds, the
 * closing) are written in English in the code. Without this, a Hindi interview
 * opened in English, which is the first thing the candidate hears.
 *
 * Lines are translated one at a time and cached globally by (language, text):
 * the scripted lines repeat across interviews, so each is translated once per
 * language, ever. English sessions never reach the model at all.
 *
 * A failed translation falls back to the English line. An interviewer that
 * momentarily switches to English is a flaw; one that goes silent is a dead
 * interview.
 */

const cache = new Map<string, string>();
/** Translations currently in flight, so concurrent callers share one call. */
const pending = new Map<string, Promise<string | null>>();

export class LineLocalizer {
  /** Longest first, so "Priyanshu Raj" is masked before "Priyanshu" can be. */
  private readonly terms: string[];

  constructor(
    private readonly language: string,
    /**
     * Words that must come out of translation byte-identical — above all the
     * candidate's name. Left to the model, "Priyanshu" came back as a mix of
     * Devanagari and Bengali glyphs; a mangled name in the greeting is the
     * worst possible first impression, so names never enter the model at all.
     */
    protectedTerms: string[] = [],
  ) {
    this.terms = [...new Set(protectedTerms.map((t) => t.trim()).filter((t) => t.length > 1))].sort(
      (a, b) => b.length - a.length,
    );
  }

  /** English sessions pass through untouched. */
  get active(): boolean {
    return !this.language.toLowerCase().startsWith('en');
  }

  async t(text: string): Promise<string> {
    const line = text.trim();
    if (!this.active || !line) return text;

    // Protected terms become placeholders before the model sees the line, and
    // are restored after. Also why the cache key is the masked line: the
    // greeting differs between candidates only by name, so with the name
    // masked every interview shares one cached translation of it.
    const restorations: Array<[token: string, term: string]> = [];
    let masked = line;
    for (const term of this.terms) {
      if (!masked.includes(term)) continue;
      const token = `{{P${restorations.length}}}`;
      restorations.push([token, term]);
      masked = masked.split(term).join(token);
    }

    const restore = (translated: string): string => {
      let out = translated;
      for (const [token, term] of restorations) out = out.split(token).join(term);
      return out;
    };

    const key = `${this.language} ${masked}`;
    const hit = cache.get(key);
    if (hit) return restore(hit);

    // If this exact line is already being translated — the prewarm started it
    // moments before the interview asked for it live — join that call rather
    // than racing it with a duplicate.
    let inFlight = pending.get(key);
    if (!inFlight) {
      inFlight = this.translateMasked(key, masked, restorations.map(([token]) => token));
      pending.set(key, inFlight);
      void inFlight.finally(() => pending.delete(key));
    }

    const translated = await inFlight;
    return translated ? restore(translated) : text;
  }

  /**
   * The actual model round-trip. Returns the translated line still carrying
   * its placeholders (so it can be cached name-independently), or null after
   * two failed attempts — the caller speaks English rather than nothing.
   */
  private async translateMasked(key: string, masked: string, tokens: string[]): Promise<string | null> {
    // Two attempts, because the fallback is an interviewer that suddenly
    // switches to English mid-interview — worth one retry to avoid. The smart
    // model does the translating: each line runs once per language ever (the
    // cache is global), so quality is worth far more than speed here. The fast
    // model demonstrably was not up to it — it turned "the role you have
    // applied for" into the interviewer claiming to have applied.
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const translated = (
          await complete({
            model: SMART_MODEL,
            temperature: 0.2,
            maxTokens: 500,
            messages: [
              {
                role: 'system',
                content: `You translate what an AI job interviewer says out loud to a candidate, into natural spoken ${languageName(this.language)} — the way a professional interviewer in that language actually talks, not stiff textbook prose.

Rules:
- Preserve the meaning and the speaker's perspective exactly. The INTERVIEWER is speaking TO the candidate. Never swap who is doing what: if the line asks the candidate to confirm the role THEY applied for, the translation must not have the interviewer applying for anything.
- Translate the whole line. Do not shorten, drop or add anything.
- Keep people's names, company names, role titles and technical terms exactly as they are, in Latin script.
- Text like {{P0}} or {{P1}} is a placeholder for a name. Keep every placeholder exactly as written, byte for byte.
- If part of the line is already in ${languageName(this.language)}, keep it as is.
- Reply with the translated line only — no quotes, no notes.`,
              },
              { role: 'user', content: masked },
            ],
          })
        )
          // These lines are spoken, and models sneak markdown emphasis into
          // them ("this **role**") — which a voice reads out as noise.
          .replace(/[*_`#]+/g, '')
          .trim();

        // A translation dramatically shorter than the source is a mangled or
        // truncated one, and one missing a placeholder has eaten a name;
        // asking again beats speaking either.
        const suspicious =
          (masked.length > 80 && translated.length < masked.length / 3) ||
          tokens.some((token) => !translated.includes(token));

        if (translated && !suspicious) {
          cache.set(key, translated);
          return translated;
        }
      } catch (err) {
        console.warn(`[localize] translation attempt ${attempt + 1} failed: ${(err as Error).message}`);
      }

      // A beat before retrying: an immediate second call into a rate limit
      // fails identically. The skeleton is translated ahead of time while the
      // interview waits for its candidate, so this pause costs nobody.
      if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 2_500));
    }

    console.warn('[localize] speaking one line in English after two failed translations');
    return null;
  }

  /**
   * Translates lines ahead of time, concurrently, without blocking anything.
   *
   * Called while the interview is still being set up, so that by the time the
   * greeting is actually spoken the whole skeleton is a cache hit — no
   * per-turn latency, and no first-line English fallback because a cold start
   * happened to coincide with a provider blip.
   */
  warm(lines: string[]): void {
    if (!this.active) return;
    // One at a time, not all at once: a burst of concurrent translation calls
    // is exactly the shape that trips a provider's rate limiter, and there is
    // no hurry — this runs while the interview waits for its candidate.
    void (async () => {
      for (const line of lines) await this.t(line);
    })();
  }
}
