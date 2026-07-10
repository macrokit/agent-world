/**
 * RFC 8785 (JCS) canonicalization.
 *
 * JSON.stringify already emits JCS-conformant primitives in ECMAScript
 * (number serialization and string escaping are the ES rules RFC 8785 adopts);
 * what JCS adds is recursive lexicographic ordering of object members by
 * UTF-16 code units, which is what this implements.
 */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value === "number" || typeof value === "boolean" || typeof value === "string") {
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new Error("JCS: non-finite numbers are not representable");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map((v) => canonicalize(v === undefined ? null : v)).join(",") + "]";
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort();
    return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalize(obj[k])).join(",") + "}";
  }
  throw new Error(`JCS: cannot canonicalize value of type ${typeof value}`);
}

export function canonicalBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(canonicalize(value));
}
