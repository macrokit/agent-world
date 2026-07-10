import { describe, expect, it } from "vitest";
import {
  AW_ID_PATTERN,
  base58decode,
  base58encode,
  canonicalize,
  generateKeypair,
  keypairFromPem,
  privateKeyToPem,
  publicKeyFromId,
  sha256hex,
  signed,
  signObject,
  verifyObject,
  verifySigned,
} from "../src/index.js";

describe("JCS canonicalization (RFC 8785)", () => {
  it("sorts object keys recursively, arrays keep order", () => {
    expect(canonicalize({ b: 1, a: { d: [2, { z: 1, y: 2 }], c: "x" } })).toBe(
      '{"a":{"c":"x","d":[2,{"y":2,"z":1}]},"b":1}',
    );
  });
  it("matches RFC 8785 §3.2.3 number/literal expectations", () => {
    expect(canonicalize({ literals: [null, true, false], numbers: [1e30, 4.5, 0.002, 1e-27] })).toBe(
      '{"literals":[null,true,false],"numbers":[1e+30,4.5,0.002,1e-27]}',
    );
  });
  it("drops undefined members, rejects non-finite numbers", () => {
    expect(canonicalize({ a: undefined, b: 1 })).toBe('{"b":1}');
    expect(() => canonicalize({ a: Infinity })).toThrow();
  });
});

describe("base58btc", () => {
  it("round-trips 32-byte keys including leading zeros", () => {
    const bytes = new Uint8Array(32);
    bytes[0] = 0;
    bytes[1] = 0;
    bytes[31] = 7;
    expect(base58decode(base58encode(bytes))).toEqual(bytes);
  });
});

describe("keys and ids", () => {
  it("generates distinct keypairs with conforming ids", () => {
    const a = generateKeypair();
    const b = generateKeypair();
    expect(a.id).toMatch(AW_ID_PATTERN);
    expect(a.id).not.toBe(b.id);
  });

  it("id → public key → id round-trips", () => {
    const kp = generateKeypair();
    const pub = publicKeyFromId(kp.id);
    const spkiA = pub.export({ type: "spki", format: "der" });
    const spkiB = kp.publicKey.export({ type: "spki", format: "der" });
    expect(spkiA.equals(spkiB)).toBe(true);
  });

  it("PEM round-trips and re-derives the same id", () => {
    const kp = generateKeypair();
    expect(keypairFromPem(privateKeyToPem(kp.privateKey)).id).toBe(kp.id);
  });
});

describe("signatures", () => {
  it("signs and verifies by id; key-order does not matter", () => {
    const kp = generateKeypair();
    const sig = signObject({ b: 2, a: 1 }, kp.privateKey);
    expect(verifyObject({ a: 1, b: 2 }, sig, kp.id)).toBe(true);
    expect(verifyObject({ a: 1, b: 3 }, sig, kp.id)).toBe(false);
  });

  it("signed()/verifySigned() convenience pair; replacing sig fails", () => {
    const kp = generateKeypair();
    const other = generateKeypair();
    const obj = signed({ hello: "world" }, kp.privateKey);
    expect(verifySigned(obj, kp.id)).toBe(true);
    expect(verifySigned(obj, other.id)).toBe(false);
    expect(verifySigned({ ...obj, hello: "tampered" }, kp.id)).toBe(false);
  });

  it("signed() strips a pre-existing sig before signing", () => {
    const kp = generateKeypair();
    const once = signed({ x: 1 }, kp.privateKey);
    const twice = signed(once, kp.privateKey);
    expect(twice.sig).toBe(once.sig);
  });
});

describe("sha256hex", () => {
  it("is canonicalization-stable", () => {
    expect(sha256hex({ a: 1, b: 2 })).toBe(sha256hex({ b: 2, a: 1 }));
    expect(sha256hex({ a: 1 })).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});
