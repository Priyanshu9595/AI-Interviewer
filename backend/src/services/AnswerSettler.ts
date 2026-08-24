/**
 * Holds a finished-looking answer open in case the candidate was only pausing.
 *
 * Deepgram ends a turn on roughly 800ms of silence. People leave longer gaps
 * than that mid-answer — working out how to phrase the rest of a sentence, or
 * recalling a number. Replying into one of those gaps talks over the candidate
 * and files half an answer as the whole of it.
 *
 * So the end of a turn starts a wait rather than a reply. Anything more the
 * candidate says inside the window joins the same answer and starts the wait
 * again; only an uninterrupted stretch of silence ends the turn.
 *
 * Shared by the meeting bot and the browser room because both consume the same
 * Deepgram event stream, and the rule that keeps this correct is easy to get
 * subtly wrong in one of two copies: a turn ending must not extend a wait that
 * is already running. Deepgram announces the end twice — speech_final on its
 * short silence, then utteranceEnd on its longer one — and treating the second
 * as fresh news would push every answer out by another full window.
 */
export interface SettledAnswer {
  text: string;
  confidence: number;
  /**
   * When the candidate was last actually heard.
   *
   * Latency is measured to this rather than to the moment the answer settles,
   * so the time spent waiting on them is not recorded as them hesitating.
   */
  lastHeardAt: number;
}

export class AnswerSettler {
  private text = '';
  private confidenceSum = 0;
  private finalCount = 0;
  private timer: NodeJS.Timeout | null = null;
  private lastHeardAt: number;

  constructor(
    private readonly holdMs: number,
    private readonly onSettled: (answer: SettledAnswer) => void,
    /** Injectable so tests do not have to wait out real time. */
    private readonly now: () => number = Date.now,
  ) {
    this.lastHeardAt = now();
  }

  /** Whether an answer is currently being held open. */
  get waiting(): boolean {
    return this.timer !== null;
  }

  /** When the candidate was last heard, settled or not. */
  get heardAt(): number {
    return this.lastHeardAt;
  }

  /** Settled text from the recogniser. Joins whatever is already buffered. */
  addFinal(text: string, confidence: number): void {
    this.lastHeardAt = this.now();

    const piece = text.trim();
    if (!piece) return;

    this.text = `${this.text} ${piece}`.trim();
    this.confidenceSum += confidence;
    this.finalCount++;

    // Words arriving after the turn looked finished belong to the same answer,
    // and the wait starts over.
    if (this.timer) this.arm();
  }

  /** Partial text — proof they are still going, nothing to buffer yet. */
  addInterim(): void {
    this.lastHeardAt = this.now();
    if (this.timer) this.arm();
  }

  /**
   * The recogniser believes the turn is over.
   *
   * Starts the wait, unless one is already running — see the note above about
   * Deepgram saying this twice.
   */
  endOfTurn(): void {
    if (!this.text) return;
    if (this.timer) return;
    this.arm();
  }

  /** Drop what is buffered and cancel any wait. */
  discard(): void {
    this.cancel();
    this.text = '';
    this.confidenceSum = 0;
    this.finalCount = 0;
  }

  /** Stop any wait but keep what has been heard. */
  cancel(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private arm(): void {
    this.cancel();
    this.timer = setTimeout(() => {
      this.timer = null;
      this.settle();
    }, this.holdMs);
  }

  private settle(): void {
    const text = this.text.trim();
    const confidence = this.finalCount ? this.confidenceSum / this.finalCount : 0.9;

    this.text = '';
    this.confidenceSum = 0;
    this.finalCount = 0;

    if (!text) return;
    this.onSettled({ text, confidence, lastHeardAt: this.lastHeardAt });
  }
}
