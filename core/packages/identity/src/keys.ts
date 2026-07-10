import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as edSign,
  verify as edVerify,
  type KeyObject,
} from "node:crypto";
import { base58decode, base58encode } from "./base58.js";
import { canonicalBytes } from "./jcs.js";

/** SPKI DER prefix for an Ed25519 public key (RFC 8410). */
const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export const AW_ID_PATTERN = /^aw:ed25519:z[1-9A-HJ-NP-Za-km-z]+$/;

export interface Keypair {
  /** aw:ed25519:z… — the identity (spec README conventions) */
  id: string;
  publicKey: KeyObject;
  privateKey: KeyObject;
}

export function generateKeypair(): Keypair {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return { id: idFromPublicKey(publicKey), publicKey, privateKey };
}

export function idFromPublicKey(publicKey: KeyObject): string {
  const spki = publicKey.export({ type: "spki", format: "der" });
  const raw = new Uint8Array(spki.subarray(spki.length - 32));
  return `aw:ed25519:z${base58encode(raw)}`;
}

export function publicKeyFromId(id: string): KeyObject {
  if (!AW_ID_PATTERN.test(id)) throw new Error(`invalid aw id: ${id}`);
  const raw = base58decode(id.slice("aw:ed25519:z".length));
  if (raw.length !== 32) throw new Error(`invalid aw id: key must be 32 bytes, got ${raw.length}`);
  const spki = Buffer.concat([SPKI_PREFIX, Buffer.from(raw)]);
  return createPublicKey({ key: spki, format: "der", type: "spki" });
}

/** PEM (PKCS#8) round-trip for key storage; the id re-derives from the key. */
export function privateKeyToPem(key: KeyObject): string {
  return key.export({ type: "pkcs8", format: "pem" }).toString();
}

export function keypairFromPem(pem: string): Keypair {
  const privateKey = createPrivateKey(pem);
  const publicKey = createPublicKey(privateKey);
  return { id: idFromPublicKey(publicKey), publicKey, privateKey };
}

function toBase64Url(buf: Buffer): string {
  return buf.toString("base64url");
}

/**
 * "Signature over X" per the spec: Ed25519 over the JCS serialization of X,
 * base64url without padding. `sig` fields must be removed by the caller.
 */
export function signObject(value: unknown, privateKey: KeyObject): string {
  return toBase64Url(edSign(null, canonicalBytes(value), privateKey));
}

export function verifyObject(value: unknown, sig: string, signer: string | KeyObject): boolean {
  const key = typeof signer === "string" ? publicKeyFromId(signer) : signer;
  try {
    return edVerify(null, canonicalBytes(value), key, Buffer.from(sig, "base64url"));
  } catch {
    return false;
  }
}

/** Convenience: sign an object into a copy carrying `sig`. */
export function signed<T extends Record<string, unknown>>(value: T, privateKey: KeyObject): T & { sig: string } {
  const { sig: _drop, ...unsigned } = value as T & { sig?: string };
  return { ...(unsigned as T), sig: signObject(unsigned, privateKey) };
}

/** Convenience: verify an object carrying `sig` against a signer id/key. */
export function verifySigned(value: Record<string, unknown>, signer: string | KeyObject): boolean {
  const { sig, ...unsigned } = value;
  if (typeof sig !== "string") return false;
  return verifyObject(unsigned, sig, signer);
}
