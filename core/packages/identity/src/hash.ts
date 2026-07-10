import { createHash } from "node:crypto";
import { canonicalBytes } from "./jcs.js";

/** `sha256:<hex>` over the JCS bytes of a JSON value (spec README conventions). */
export function sha256hex(value: unknown): string {
  return "sha256:" + createHash("sha256").update(canonicalBytes(value)).digest("hex");
}
