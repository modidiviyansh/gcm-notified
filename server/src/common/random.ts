import { randomInt } from 'crypto';

/** Uniform random integer in [min, max] (inclusive). */
export function between(min: number, max: number): number {
  if (max <= min) return Math.max(0, min);
  return randomInt(min, max + 1);
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, Math.max(0, ms)));

/**
 * Spintax: "{Hello|Hi|Namaste} parent" → one option picked at random.
 * Only single-brace groups that contain "|" are treated as spintax, so
 * Handlebars tags like {{name}} are never touched. Nested groups are resolved inside-out.
 */
export function spin(text: string): string {
  const re = /(?<!\{)\{([^{}]*\|[^{}]*)\}(?!\})/;
  let out = text;
  for (let i = 0; i < 100 && re.test(out); i++) {
    out = out.replace(re, (_m, body: string) => {
      const opts = body.split('|');
      return opts[randomInt(0, opts.length)];
    });
  }
  return out;
}
