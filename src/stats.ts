/**
 * Fallback inference for one gap in Flagsmith's results.
 *
 * Flagsmith only reports chance-to-win when BOTH arms have ≥ 50 identities and
 * ≥ 5 conversions. When a terrible champion converts almost nobody, every
 * challenger is left without a verdict, which is exactly when the answer is
 * most obvious. This module is a line-for-line port of Flagsmith's own
 * `compare_to_control` (api/experimentation/stats.py: delta-method normal
 * approximation of relative lift), applied only to that case. When the control
 * has zero conversions, relative lift is undefined, so absolute rates are
 * compared instead (see compareAbsolute).
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

/** Port of Flagsmith's compare_to_control for an occurrence metric (values are 0/1). */
export function compareToControl(control: ArmStats, treatment: ArmStats): Inference | null {
  const stats = (a: ArmStats) => {
    const mean = a.conversions / a.visitors;
    // sum_squares == sum for 0/1 values
    const variance = Math.max(0, (a.conversions - a.conversions ** 2 / a.visitors) / (a.visitors - 1));
    return { n: a.visitors, mean, variance };
  };
  if (control.visitors < 2 || treatment.visitors < 2) return null;
  const c = stats(control);
  const t = stats(treatment);
  if (c.mean <= 0) return null;

  const lift = (t.mean - c.mean) / c.mean;
  const variance = t.variance / (t.n * c.mean ** 2) + (t.mean ** 2 * c.variance) / (c.n * c.mean ** 4);
  const se = Math.sqrt(variance);
  if (se === 0) {
    const certainty = lift === 0 ? 0.5 : Number(lift > 0);
    return { lift, ciLow: lift, ciHigh: lift, chanceToWin: certainty };
  }
  return { lift, ciLow: lift - Z_95 * se, ciHigh: lift + Z_95 * se, chanceToWin: normalCdf(lift / se) };
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
  if (control.conversions > 0) return compareToControl(control, treatment);
  return compareAbsolute(control, treatment);
}

/**
 * Zero-conversion control: relative lift against 0 is undefined (and against a
 * tiny smoothed rate its variance explodes), so compare absolute rates with the
 * same normal approximation. The control rate uses a Haldane–Anscombe +0.5
 * correction so its variance is not zero. `lift` here is the absolute
 * difference in conversion rate.
 */
export function compareAbsolute(control: ArmStats, treatment: ArmStats): Inference {
  const pc = (control.conversions + 0.5) / (control.visitors + 1);
  const pt = treatment.conversions / treatment.visitors;
  const se = Math.sqrt((pt * (1 - pt)) / treatment.visitors + (pc * (1 - pc)) / control.visitors);
  const diff = pt - pc;
  return { lift: diff, ciLow: diff - Z_95 * se, ciHigh: diff + Z_95 * se, chanceToWin: normalCdf(diff / se) };
}
