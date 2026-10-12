#!/usr/bin/env bun
// Moves the phases of docs/roadmap.md into Spider Tracker (ST-96): one milestone per phase in
// project ST, with the existing tasks put in them (sub-tasks inherit). Run it once against prod,
// as a person's or agent's saved key that can write in ST. Running it again changes nothing that
// is already in place, and it never moves a task someone put in another milestone.
//
//   bun scripts/roadmap-import.ts --as st-developer --dry-run   show what it would do
//   bun scripts/roadmap-import.ts --as st-developer             create the milestones, assign the tasks
//
// Options: --as <agent> (a saved agent, as for spider --as; default: SPIDER_TOKEN with
// SPIDER_API_URL, else the default saved agent), --project <KEY> (default ST), --dry-run.
// The phases and their tasks are listed in backend/cli/src/roadmap-import.ts.

import { defaultAgent, findAgent, readStore } from "../backend/cli/src/credentials";
import { createClient, importReportLines, importRoadmap } from "../backend/cli/src/roadmap-import";

const args = process.argv.slice(2);
const option = (name: string) => {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const value = args[i + 1];
  if (!value || value.startsWith("-")) {
    console.error(`${name} needs a value`);
    process.exit(2);
  }
  return value;
};
const dryRun = args.includes("--dry-run");
const project = (option("--project") ?? "ST").toUpperCase();
const as = option("--as");

async function credentials(): Promise<{ token: string; baseUrl: string; label: string }> {
  const env = process.env;
  const store = await readStore(env);
  if (as) {
    const entry = findAgent(store, as);
    return { token: entry.saved.token, baseUrl: entry.serverUrl, label: entry.ref };
  }
  const token = env.SPIDER_TOKEN?.trim();
  if (token) return { token, baseUrl: env.SPIDER_API_URL?.trim() || "https://tracker-api.batele.plus", label: "SPIDER_TOKEN" };
  const entry = defaultAgent(store);
  if (!entry) throw new Error("No key: pass --as <agent>, or set SPIDER_TOKEN");
  return { token: entry.saved.token, baseUrl: entry.serverUrl, label: entry.ref };
}

try {
  const { token, baseUrl, label } = await credentials();
  const client = createClient({ baseUrl, token, source: "cli" });
  const who = await client.whoami();
  console.info(`${dryRun ? "Dry run as" : "Importing as"} @${who.actor.handle} (${label}) into ${who.organization.slug}/${project} on ${baseUrl}`);
  const report = await importRoadmap(client, who.organization.slug, { project, dryRun });
  console.info(importReportLines(report));
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
