/**
 * Minimal semver range check for app-version kill switches (plan T4.6). A range is one or more
 * space-separated comparators, all of which must hold: `1.4.2`, `<1.5.0`, `>=1.2.0 <1.3.0`.
 * Pre-release and build suffixes are ignored.
 */
function parse(version: string): [number, number, number] | null {
  const m = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(version.trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)];
}

function compare(a: [number, number, number], b: [number, number, number]): number {
  for (let i = 0; i < 3; i += 1) if (a[i] !== b[i]) return a[i]! - b[i]!;
  return 0;
}

export function satisfiesRange(version: string, range: string): boolean {
  const v = parse(version);
  if (!v) return false;
  const comparators = range.trim().split(/\s+/).filter(Boolean);
  if (comparators.length === 0) return false;
  return comparators.every((comparator) => {
    const m = /^(<=|>=|[<>=])?(.+)$/.exec(comparator);
    const target = m ? parse(m[2]!) : null;
    if (!m || !target) return false;
    const c = compare(v, target);
    switch (m[1]) {
      case '<': return c < 0;
      case '<=': return c <= 0;
      case '>': return c > 0;
      case '>=': return c >= 0;
      default: return c === 0;
    }
  });
}
