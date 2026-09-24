/**
 * Canonical JSON: object keys sorted by UTF-16 code unit, no whitespace, standard JSON escaping.
 * Signatures are computed over these bytes, so the same pack always signs and verifies the same
 * way regardless of key order or formatting on disk.
 */
export function canonicalJson(value: unknown): string {
  return serialize(value);
}

function serialize(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) {
        throw new TypeError('Canonical JSON cannot encode non-finite numbers');
      }
      return JSON.stringify(value);
    case 'object': {
      if (Array.isArray(value)) {
        return `[${value.map((item) => serialize(item === undefined ? null : item)).join(',')}]`;
      }
      const record = value as Record<string, unknown>;
      const keys = Object.keys(record)
        .filter((key) => record[key] !== undefined)
        .sort();
      return `{${keys.map((key) => `${JSON.stringify(key)}:${serialize(record[key])}`).join(',')}}`;
    }
    default:
      throw new TypeError(`Canonical JSON cannot encode ${typeof value}`);
  }
}
