/**
 * Fallback inference for one gap in Flagsmith's results.
 *
 * Flagsmith only reports chance-to-win when BOTH arms have ≥ 50 identities and
 * ≥ 5 conversions. When a weak champion converts almost nobody, every
 * challenger is left without a verdict, which is exactly when the answer is
 * most obvious. Flagsmith's relative-lift formula (delta method) is undefined
 * at a zero control rate and extremely wide near it, so this fallback compares
 * absolute conversion rates with the standard two-proportion normal
 * approximation. It is used only for that case; everywhere else, Flagsmith's
 * own numbers decide.
 */

export interface ArmStats {
  visitors: number;
  conversions: number;
}

export interface Inference {
  lift: number;
  ciLow: number;
  ciHigh: number;
  chanceToWin: number;
}

const Z_95 = 1.959963984540054;

/** Standard normal CDF via erf (Abramowitz & Stegun 7.1.26, |error| < 1.5e-7). */
export function normalCdf(z: number): number {
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const erf = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return z >= 0 ? 0.5 * (1 + erf) : 0.5 * (1 - erf);
}

const MIN_IDENTITIES = 50;
const MIN_CONVERSIONS = 5;

/**
 * Inference for a challenger Flagsmith left without a verdict, or null when the
 * gap is anything other than "the champion converted too rarely".
 */
export function fallbackInference(control: ArmStats, treatment: ArmStats): Inference | null {
  if (control.visitors < MIN_IDENTITIES || treatment.visitors < MIN_IDENTITIES) return null;
  if (treatment.conversions < MIN_CONVERSIONS) return null;
  if (control.conversions >= MIN_CONVERSIONS) return null; // Flagsmith would have answered
  return compareAbsolute(control, treatment);
}

/**
 * Two-proportion comparison of absolute conversion rates. The control rate uses
 * a Haldane–Anscombe +0.5 correction so its variance is never zero. `lift` here
 * is the absolute difference in conversion rate.
 */
export function compareAbsolute(control: ArmStats, treatment: ArmStats): Inference {
  const pc = (control.conversions + 0.5) / (control.visitors + 1);
  const pt = treatment.conversions / treatment.visitors;
  const se = Math.sqrt((pt * (1 - pt)) / treatment.visitors + (pc * (1 - pc)) / control.visitors);
  const diff = pt - pc;
  return { lift: diff, ciLow: diff - Z_95 * se, ciHigh: diff + Z_95 * se, chanceToWin: normalCdf(diff / se) };
}
