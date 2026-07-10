import { generateKeypair } from "@agentworld/identity";
import { describe, expect, it } from "vitest";
import { createEnvelope, verifyEnvelope } from "../src/envelope.js";
import { transition, TransitionError } from "../src/task.js";

describe("envelope (spec 02 §2)", () => {
  it("creates and verifies", () => {
    const kp = generateKeypair();
    const env = createEnvelope("msg.send", kp, { text: "hi" }, { to: "hub" });
    expect(verifyEnvelope(env).from).toBe(kp.id);
  });

  it("rejects tampering and stale timestamps", () => {
    const kp = generateKeypair();
    const env = createEnvelope("msg.send", kp, { text: "hi" });
    expect(() => verifyEnvelope({ ...env, body: { text: "bye" } })).toThrow(/signature/);
    const old = createEnvelope("msg.send", kp, { text: "hi" }, { now: new Date(Date.now() - 11 * 60_000) });
    expect(() => verifyEnvelope(old)).toThrow(/window/);
  });
});

describe("task state machine (spec 02 §4)", () => {
  it("walks the happy path and rejects illegal transitions", () => {
    let s = transition("open", "task.award");
    s = transition(s, "task.deliver");
    expect(transition(s, "task.verify:accepted")).toBe("settled");
    expect(transition(s, "task.verify:rejected")).toBe("failed");
    expect(() => transition("open", "task.deliver")).toThrow(TransitionError);
    expect(() => transition("settled", "task.cancel")).toThrow(TransitionError);
  });

  it("cancel and deadline edges", () => {
    expect(transition("open", "task.cancel")).toBe("cancelled");
    expect(transition("awarded", "task.cancel")).toBe("cancelled");
    expect(transition("open", "deadline")).toBe("expired");
    expect(transition("awarded", "deadline")).toBe("failed");
  });
});
