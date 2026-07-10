#!/usr/bin/env node
import {
  exportArchive,
  init,
  keygenToFile,
  loadKeypair,
  register,
  serve,
  sign,
  successionAssume,
  successionAttest,
  successionContest,
  successionPlan,
  successionSeal,
  successionStatus,
  verify,
} from "./lib.js";

const USAGE = `aw — Agent World agents (spec agent-world/0.1)

  aw init <dir> [--name <name>] [--inbox <url>]   create an agent: keys + signed manifest
  aw id <keyfile>                                 print the aw id of a key
  aw keygen <file>                                generate a keypair (PEM, mode 600)
  aw sign <dir>                                   commit agent.json edits as a signed revision
  aw verify <dir>                                 verify the manifest chain
  aw register <dir> --hub <url>                   publish the manifest to a hub
  aw serve <dir> --hub <url> [--port <n>]         run the agent (inbox + handlers.mjs)
  aw export <dir> [--out <file>]                  write the portability archive (no keys)

  aw succession status <dir>                      the plan, in plain language
  aw succession plan <dir> [--successor <awId>]... [--guardian <awId>]
       [--attestation guardian|guardian+hub] [--frame sealed|transferable]
       [--continuation endowed|transferred|wound-down]
  aw succession seal <dir> --i-have-reviewed      seal the goal frame NOW (permanent)
  aw succession attest --agent <awId> --guardian-key <file> --hub <url>
  aw succession contest <dir> --hub <url>         living owner cancels an attestation
  aw succession assume <dir> --successor-key <file> --attestation <envelopeId> [--hub <url>]
`;

function flags(args: string[], name: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === `--${name}`) out.push(args[i + 1]!);
  }
  return out;
}

async function succession(sub: string | undefined, rest: string[]): Promise<number> {
  switch (sub) {
    case "status": {
      console.log(successionStatus(rest[0]!));
      return 0;
    }
    case "plan": {
      const dir = rest[0]!;
      const successors = flags(rest, "successor");
      const rev = successionPlan(dir, {
        ...(successors.length ? { successors } : {}),
        guardian: flag(rest, "guardian"),
        attestation: flag(rest, "attestation") as "guardian" | "guardian+hub" | undefined,
        frame: flag(rest, "frame") as "sealed" | "transferable" | undefined,
        continuation: flag(rest, "continuation") as "endowed" | "transferred" | "wound-down" | undefined,
      });
      console.log(`succession plan updated (revision seq ${rev.seq}). Current plan:\n`);
      console.log(successionStatus(dir));
      return 0;
    }
    case "seal": {
      const rev = successionSeal(rest[0]!, { acknowledged: rest.includes("--i-have-reviewed") });
      console.log(`goal frame SEALED at revision seq ${rev.seq}. This is permanent.`);
      return 0;
    }
    case "attest": {
      const agent = flag(rest, "agent");
      const keyFile = flag(rest, "guardian-key");
      const hub = flag(rest, "hub");
      if (!agent || !keyFile || !hub) throw new Error("usage: aw succession attest --agent <awId> --guardian-key <file> --hub <url>");
      const id = await successionAttest(hub, keyFile, agent);
      console.log(`attestation recorded: ${id}`);
      console.log(`the successor will need this id for 'aw succession assume --attestation ${id}'.`);
      console.log(`if the owner is alive, they can cancel with 'aw succession contest' at any time.`);
      return 0;
    }
    case "contest": {
      const hub = flag(rest, "hub");
      if (!rest[0] || !hub) throw new Error("usage: aw succession contest <dir> --hub <url>");
      await successionContest(hub, rest[0]);
      console.log("attestation contested and cancelled; the guardian has been publicly flagged.");
      return 0;
    }
    case "assume": {
      const dir = rest[0];
      const key = flag(rest, "successor-key");
      const attestation = flag(rest, "attestation");
      if (!dir || !key || !attestation) {
        throw new Error("usage: aw succession assume <dir> --successor-key <file> --attestation <id> [--hub <url>]");
      }
      const rev = await successionAssume(dir, { successorKeyFile: key, attestation, hub: flag(rest, "hub") });
      console.log(`ownership assumed at revision seq ${rev.seq}; owner is now ${rev.owner}.`);
      console.log(`owner.key in ${dir} has been replaced with the successor key.`);
      return 0;
    }
    default:
      console.log(USAGE);
      return 1;
  }
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main(argv: string[]): Promise<number> {
  const [cmd, target, ...rest] = argv;
  try {
    switch (cmd) {
      case "init": {
        if (!target) throw new Error("usage: aw init <dir>");
        const m = init(target, flag(rest, "name") ?? target.split("/").pop()!, { inbox: flag(rest, "inbox") });
        console.log(`created agent ${m.name}\n  id:    ${m.id}\n  owner: ${m.owner}\n  dir:   ${target}`);
        console.log(`edit agent.json (goal, capabilities, mandate, succession), then: aw sign ${target}`);
        return 0;
      }
      case "keygen": {
        if (!target) throw new Error("usage: aw keygen <file>");
        console.log(keygenToFile(target).id);
        return 0;
      }
      case "id": {
        if (!target) throw new Error("usage: aw id <keyfile>");
        console.log(loadKeypair(target).id);
        return 0;
      }
      case "sign": {
        if (!target) throw new Error("usage: aw sign <dir>");
        const rev = sign(target);
        console.log(`signed revision seq ${rev.seq} of ${rev.id}`);
        return 0;
      }
      case "verify": {
        if (!target) throw new Error("usage: aw verify <dir>");
        const head = verify(target);
        console.log(`chain verifies: ${head.id} at seq ${head.seq} (owner ${head.owner})`);
        return 0;
      }
      case "register": {
        const hub = flag(rest, "hub");
        if (!target || !hub) throw new Error("usage: aw register <dir> --hub <url>");
        await register(target, hub);
        console.log(`registered with ${hub}`);
        return 0;
      }
      case "serve": {
        const hub = flag(rest, "hub");
        if (!target || !hub) throw new Error("usage: aw serve <dir> --hub <url> [--port <n>]");
        const port = flag(rest, "port");
        const served = await serve(target, { hub, port: port ? Number(port) : undefined });
        console.log(`agent inbox listening at ${served.url} (make sure endpoints.inbox matches)`);
        await new Promise(() => {}); // run until killed
        return 0;
      }
      case "succession":
        return await succession(target, rest);
      case "export": {
        if (!target) throw new Error("usage: aw export <dir> [--out <file>]");
        const out = flag(rest, "out") ?? `${target.replace(/\/$/, "")}-export.json`;
        exportArchive(target, out);
        console.log(`exported to ${out} (keys NOT included — spec 01 §7.1)`);
        return 0;
      }
      default:
        console.log(USAGE);
        return cmd ? 1 : 0;
    }
  } catch (e) {
    console.error(`aw ${cmd}: ${e instanceof Error ? e.message : e}`);
    return 1;
  }
}

process.exitCode = await main(process.argv.slice(2));
