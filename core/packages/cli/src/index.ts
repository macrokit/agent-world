#!/usr/bin/env node
import { exportArchive, init, loadKeypair, keygenToFile, register, serve, sign, verify } from "./lib.js";

const USAGE = `aw — Agent World agents (spec agent-world/0.1)

  aw init <dir> [--name <name>] [--inbox <url>]   create an agent: keys + signed manifest
  aw id <keyfile>                                 print the aw id of a key
  aw keygen <file>                                generate a keypair (PEM, mode 600)
  aw sign <dir>                                   commit agent.json edits as a signed revision
  aw verify <dir>                                 verify the manifest chain
  aw register <dir> --hub <url>                   publish the manifest to a hub
  aw serve <dir> --hub <url> [--port <n>]         run the agent (inbox + handlers.mjs)
  aw export <dir> [--out <file>]                  write the portability archive (no keys)
`;

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
