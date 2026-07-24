#!/usr/bin/env node
/**
 * CLI contract for the standing-query re-resolution canary in the orchestrator.
 */
import { shouldReResolve } from "./resolve.mjs";

const [kind, pattern, enabled, maxRounds, rounds] = process.argv.slice(2);

const classified = { kind, pattern, args: [] };
const config = {
  enabled: enabled === "false" ? false : enabled,
  maxRounds: maxRounds === "unbounded" ? undefined : Number(maxRounds),
};

process.stdout.write(`${JSON.stringify(shouldReResolve(classified, config, Number(rounds)))}\n`);
