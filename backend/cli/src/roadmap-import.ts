import type {
  MilestoneDto,
  StatusCategory,
  TaskDto,
} from "@repo/core/contracts";
import { firstStatusOf } from "@repo/core/statuses";
import { SpiderApiError, type SpiderClient } from "@repo/sdk";

/** For scripts/roadmap-import.ts, which sits outside the workspaces and can't resolve @repo/sdk itself. */
export { createClient } from "@repo/sdk";

// Moves the phases of docs/roadmap.md into Spider Tracker as milestones (ST-96) and puts existing
// tasks in them; scripts/roadmap-import.ts runs it once against prod. Idempotent: a phase whose
// milestone exists ("Phase N: …" in the project) is left as it is, a task already in its milestone
// is left alone, and a task a person put in another milestone is reported, never moved. Sub-tasks
// aren't listed: they inherit their parent's milestone (ST-19's GitHub sub-tasks join Phase 4).

export interface RoadmapPhase {
  number: number;
  /** After "Phase N: ". */
  title: string;
  /** The milestone's status category when it is created: done (✅), in_progress (Active) or todo (Planned). */
  category: Extract<StatusCategory, "todo" | "in_progress" | "done">;
  /** The rest of the phase as it reads in docs/roadmap.md: goal, items, done when, notes (Markdown). */
  body: string;
  /** Top-level task keys that belong to the phase. */
  tasks: string[];
}

/** docs/roadmap.md as of ST-96, phase by phase, with the ST tasks that belong to each. */
export const ROADMAP_PHASES: RoadmapPhase[] = [
  {
    number: 0,
    title: "Foundations and deployment",
    category: "done",
    body: `**Goal:** an empty app, deployed privately, end to end.

- [x] Monorepo: Turborepo + Bun, shared lint and TypeScript configs
- [x] Design docs
- [x] \`packages/db\` (Drizzle schema + migrations), \`packages/core\`
- [x] \`backend/api\` (Hono) with health checks, \`web/app\` (Vite + TanStack Router + Query)
- [x] Auth: Better Auth (magic link, GitHub, Batele ID), organizations with owner actor, onboarding
- [x] Railway: api + Postgres 18 at \`tracker-api.batele.plus\`; no Railway public URL
- [x] Cloudflare Pages at \`tracker.batele.plus\`, DNS for both domains
- [x] Deploys: API from GitHub via Railway on push to \`main\` (\`.railway/railway.ts\`); web with \`bun run deploy:web\`

Cloudflare Access is deferred: it would get in the way of agent access (MCP, CLI). A sign-up allowlist (Phase 3) covers privacy instead.`,
    tasks: [],
  },
  {
    number: 1,
    title: "Core tracker basics",
    category: "done",
    body: `**Goal:** projects and tasks usable in the browser.

- [x] Projects with keys and default statuses
- [x] Tasks (\`SPI-123\`): title, description, status, priority, assignees
- [x] Board (drag and drop) and list views; task page with inline editing
- [x] Activity log written for every change
- [x] Roles: guests read-only, owners/admins manage projects`,
    tasks: [],
  },
  {
    number: 2,
    title: "Agent access",
    category: "in_progress",
    body: `**Goal:** external agents work on tasks.

- [x] Agent actors (shown as members, owned by a person)
- [x] API keys (\`spt_…\`): Bearer auth on the same \`/v1\` routes the web app uses
- [x] Settings page to create agents and keys, and revoke keys
- [x] MCP server at \`tracker-api.batele.plus/mcp\` (agent API keys; comments come with the comments feature)
- [x] First version of the \`spider\` CLI: \`whoami\`, \`projects\`, \`task list/view/create/update/start/done\`, \`--json\` (\`comment\` comes with the comments feature)
- [x] Activity records \`source\` (ui / api / mcp / cli): API-key clients declare it with \`X-Spider-Source\`
- [x] OpenAPI spec (\`/openapi.json\`) and \`packages/sdk\`

**Done when:** Claude Code picks up a task over MCP, comments on progress and moves it to review, and this roadmap lives in Spider Tracker instead of this file.`,
    tasks: ["ST-1", "ST-2", "ST-3", "ST-4", "ST-5", "ST-6", "ST-7", "ST-24"],
  },
  {
    number: 3,
    title: "Tracker features",
    category: "in_progress",
    body: `**Goal:** a complete task tracker, built with agents.

- Tags, sub-tasks, task relations (blocks / relates / duplicates)
- Comments and the activity feed on the task page
- Realtime: LISTEN/NOTIFY → SSE → TanStack Query
- [x] Organization list after sign-in, members page, invitation codes (role, expiry, max uses, revoke)
- Roles management (change roles, deactivate members), email invitations
- Filters and saved views
- Keyboard shortcuts and command palette
- Sign-up allowlist and email delivery for magic links`,
    tasks: [
      "ST-8",
      "ST-9",
      "ST-10",
      "ST-11",
      "ST-12",
      "ST-13",
      "ST-14",
      "ST-15",
      "ST-16",
      "ST-17",
      "ST-18",
      "ST-28",
      "ST-50",
      "ST-59",
      "ST-75",
    ],
  },
  {
    number: 4,
    title: "Git and GitHub",
    category: "in_progress",
    body: `**Goal:** code and tasks stay in sync without manual updates.

- GitHub App, repository linking, repos attached to projects
- Automatic task ↔ branch / commit / pull request linking by task key
- Status automation from pull request events
- Pull request state, checks and reviews shown on the task
- CLI: \`spider start\` creates the branch, \`spider pr\` opens the pull request

**Done when:** opening and merging a pull request moves its task to review and then done, with no manual step.`,
    // ST-19's sub-tasks (GitHub 19a–19g, spider start) inherit it.
    tasks: ["ST-19"],
  },
  {
    number: 5,
    title: "Hosted agents",
    category: "todo",
    body: `**Goal:** agents run inside Spider Tracker, triggered by assignment.

- \`backend/worker\` with a Postgres job queue
- Agent runs via the Claude Agent SDK: triggers, run lifecycle, streamed events in the task
- Chat with a running agent; approval requests as buttons
- Guardrails: scoped permissions, budgets, approval gates, kill switch
- Sandbox for running code (provider to be decided)
- Agents opening pull requests

**Done when:** assigning a task to a hosted agent produces a reviewed pull request linked to the task.`,
    tasks: ["ST-20"],
  },
  {
    number: 6,
    title: "Documents, custom fields and apps",
    category: "todo",
    body: `**Goal:** the flexible parts of the model.

- [x] Markdown/HTML documents with version history; agents read and write them (ST-21; source editor with preview, no rich editor or diffs yet)
- [ ] Custom field definitions (organization and project scope), used in views, filters and agent context
- [ ] File uploads to R2
- [ ] Apps linked to repos and projects

**Done when:** a project can define its own fields and a spec document that an agent uses while working.`,
    tasks: ["ST-21", "ST-22", "ST-100", "ST-101"],
  },
  {
    number: 7,
    title: "Polish and opening up",
    category: "todo",
    body: `**Goal:** ready for people other than the owner.

- OAuth 2.1 / OIDC provider + device flow (CLI login, MCP clients without API keys, third-party apps)
- Cycles, milestones, timeline view
- Notifications, inbox, outbound webhooks
- Claude Code plugin (MCP + skill + channel)
- Optional GitHub Issues sync`,
    tasks: ["ST-23", "ST-25", "ST-26", "ST-89"],
  },
];

export const phaseTitle = (phase: Pick<RoadmapPhase, "number" | "title">) =>
  `Phase ${phase.number}: ${phase.title}`;

/** The milestone's description: the phase as it reads in the doc, and where it came from. */
export const phaseDescription = (phase: RoadmapPhase) =>
  `${phase.body}\n\n_Imported from docs/roadmap.md (ST-96)._`;

export type ImportOutcome =
  | {
      kind: "milestone";
      phase: number;
      key: string | null;
      action: "created" | "exists" | "would create";
    }
  | {
      kind: "task";
      phase: number;
      key: string;
      action:
        | "assigned"
        | "already there"
        | "would assign"
        | "missing"
        | "not a task"
        | "in another milestone";
      detail?: string;
    };

export interface ImportReport {
  dryRun: boolean;
  outcomes: ImportOutcome[];
}

const phaseOf = <T extends Pick<MilestoneDto, "title">>(
  milestones: T[],
  phase: RoadmapPhase,
): T | undefined =>
  milestones.find((m) =>
    new RegExp(`^Phase ${phase.number}\\b`, "i").test(m.title.trim()),
  );

/**
 * Creates each phase's milestone in `project` unless it exists, then puts each listed task in it.
 * With `dryRun`, reads only and says what it would do.
 */
export async function importRoadmap(
  client: SpiderClient,
  org: string,
  {
    project,
    dryRun,
    phases = ROADMAP_PHASES,
  }: { project: string; dryRun: boolean; phases?: RoadmapPhase[] },
): Promise<ImportReport> {
  const detail = await client.projects.get(org, project);
  const existing = (await client.milestones.list(org, detail.key)).items;
  const outcomes: ImportOutcome[] = [];

  for (const phase of phases) {
    let milestone = phaseOf(existing, phase);
    if (milestone) {
      outcomes.push({
        kind: "milestone",
        phase: phase.number,
        key: milestone.key,
        action: "exists",
      });
    } else if (dryRun) {
      outcomes.push({
        kind: "milestone",
        phase: phase.number,
        key: null,
        action: "would create",
      });
    } else {
      const status = firstStatusOf(detail, phase.category, "milestone");
      milestone = await client.milestones.create(org, detail.key, {
        title: phaseTitle(phase),
        description: phaseDescription(phase),
        statusId: status?.id,
      });
      existing.push(milestone);
      outcomes.push({
        kind: "milestone",
        phase: phase.number,
        key: milestone.key,
        action: "created",
      });
    }

    for (const key of phase.tasks) {
      let task: TaskDto;
      try {
        task = await client.tasks.get(org, key);
      } catch (err) {
        if (err instanceof SpiderApiError && err.status === 404) {
          outcomes.push({
            kind: "task",
            phase: phase.number,
            key,
            action: "missing",
          });
          continue;
        }
        throw err;
      }
      if ((task.kind ?? "task") !== "task") {
        outcomes.push({
          kind: "task",
          phase: phase.number,
          key,
          action: "not a task",
          detail: task.kind,
        });
      } else if (milestone && task.milestoneId === milestone.id) {
        outcomes.push({
          kind: "task",
          phase: phase.number,
          key,
          action: "already there",
        });
      } else if (task.milestoneId) {
        outcomes.push({
          kind: "task",
          phase: phase.number,
          key,
          action: "in another milestone",
          detail: task.milestone?.key ?? task.milestoneId,
        });
      } else if (dryRun || !milestone) {
        outcomes.push({
          kind: "task",
          phase: phase.number,
          key,
          action: "would assign",
        });
      } else {
        await client.tasks.update(org, key, { milestoneId: milestone.id });
        outcomes.push({
          kind: "task",
          phase: phase.number,
          key,
          action: "assigned",
        });
      }
    }
  }
  return { dryRun, outcomes };
}

/** The report as lines: one per milestone, then its tasks indented. */
export function importReportLines(report: ImportReport): string {
  const lines = report.outcomes.map((o) =>
    o.kind === "milestone"
      ? `Phase ${o.phase}: ${o.action}${o.key ? ` (${o.key})` : ""}`
      : `  ${o.key}  ${o.action}${o.detail ? ` (${o.detail})` : ""}`,
  );
  const count = (action: string) =>
    report.outcomes.filter((o) => o.action === action).length;
  lines.push(
    report.dryRun
      ? `Dry run: ${count("would create")} milestones to create, ${count("would assign")} tasks to assign. Run again without --dry-run to apply.`
      : `Done: ${count("created")} milestones created, ${count("assigned")} tasks assigned, ${count("exists")} milestones and ${count("already there")} tasks already in place.`,
  );
  const skipped = report.outcomes.filter(
    (o) =>
      o.action === "missing" ||
      o.action === "not a task" ||
      o.action === "in another milestone",
  ).length;
  if (skipped)
    lines.push(
      `${skipped} task${skipped === 1 ? "" : "s"} skipped (missing, not a task, or already in another milestone).`,
    );
  return lines.join("\n");
}
