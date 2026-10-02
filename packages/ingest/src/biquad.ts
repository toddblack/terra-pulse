/**
 * A second-order Butterworth section (RBJ cookbook form), direct form I.
 *
 * Shared by the picker (high-pass, to strip microseism) and the magnitude
 * estimate (high-pass and low-pass, to turn velocity into the band-limited
 * displacement the Pd scaling was fitted on). Kept as plain numbers rather than
 * arrays: this runs per sample on every channel, all the time.
 */
export class Biquad {
  private readonly b0: number;
  private readonly b1: number;
  private readonly b2: number;
  private readonly a1: number;
  private readonly a2: number;
  private x1 = 0;
  private x2 = 0;
  private y1 = 0;
  private y2 = 0;

  private constructor(kind: 'high' | 'low', cornerHz: number, sampleRateHz: number) {
    const w0 = (2 * Math.PI * cornerHz) / sampleRateHz;
    const cos = Math.cos(w0);
    const alpha = Math.sin(w0) / (2 * Math.SQRT1_2); // Q = 1/sqrt(2): Butterworth
    const a0 = 1 + alpha;
    const edge = kind === 'high' ? (1 + cos) / 2 : (1 - cos) / 2;
    this.b0 = edge / a0;
    this.b1 = (kind === 'high' ? -2 * edge : 2 * edge) / a0;
    this.b2 = edge / a0;
    this.a1 = (-2 * cos) / a0;
    this.a2 = (1 - alpha) / a0;
  }

  static highPass(cornerHz: number, sampleRateHz: number): Biquad {
    return new Biquad('high', cornerHz, sampleRateHz);
  }

  static lowPass(cornerHz: number, sampleRateHz: number): Biquad {
    return new Biquad('low', cornerHz, sampleRateHz);
  }

  /**
   * Starts a high-pass as though the input had been sitting at `x` forever.
   *
   * Starting from zero state instead turns a station's DC offset — often tens
   * of thousands of counts — into a step on the first sample, and a step through
   * a high-pass is a large decaying transient. That transient is exactly the
   * shape of an onset. (Only meaningful for a high-pass, whose steady-state
   * output for a constant input is zero.)
   */
  prime(x: number): void {
    this.x1 = x;
    this.x2 = x;
    this.y1 = 0;
    this.y2 = 0;
  }

  step(x: number): number {
    const y =
      this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1;
    this.x1 = x;
    this.y2 = this.y1;
    this.y1 = y;
    return y;
  }
}
