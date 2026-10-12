import { rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { MARKETPLACE, PLUGIN_ID, scanClaudeAgents } from "./claude-agents";
import {
  SHARED_MARKETPLACE,
  SHARED_PLUGIN_ID,
  type RunClaude,
} from "./claude-setup";
import {
  configDir,
  listAgents,
  type AgentEntry,
  type Store,
} from "./credentials";

// `spider uninstall`: everything the CLI put on this machine, removed in an order that never
// strands a key — keys first (they need the saved credentials), files last.

type Env = Record<string, string | undefined>;

export interface UninstallPlan {
  /** Saved agents whose keys get revoked (empty with --keep-keys). */
  revoke: AgentEntry[];
  /** Saved agents only forgotten locally (--keep-keys). */
  forget: AgentEntry[];
  plugins: string[];
  marketplaces: string[];
  /** Plugin copies Claude Code leaves in its cache after an uninstall. */
  caches: string[];
  /** Agent files outside the private plugin that point at a Spider agent (older setups). */
  agentFiles: string[];
  config: string | undefined;
  binary: string | undefined;
}

const claudeDir = (env: Env) =>
  env.CLAUDE_CONFIG_DIR ?? (env.HOME ? join(env.HOME, ".claude") : undefined);

export async function uninstallPlan(
  env: Env,
  store: Store,
  options: { keepKeys: boolean; binary: string | undefined },
): Promise<UninstallPlan> {
  const agents = listAgents(store);
  const claude = claudeDir(env);
  const config = configDir(env);
  // Files inside the private plugin go with the config folder; list only the ones elsewhere.
  const outside = (await scanClaudeAgents(env)).filter(
    (file) =>
      file.spider !== undefined && !(config && file.path.startsWith(config)),
  );
  return {
    revoke: options.keepKeys ? [] : agents,
    forget: options.keepKeys ? agents : [],
    plugins: [SHARED_PLUGIN_ID, PLUGIN_ID],
    marketplaces: [SHARED_MARKETPLACE, MARKETPLACE],
    caches: claude
      ? [SHARED_MARKETPLACE, MARKETPLACE].map((name) =>
          join(claude, "plugins", "cache", name),
        )
      : [],
    agentFiles: outside.map((file) => file.path),
    config,
    binary: options.binary,
  };
}

/** What will happen, one line per step, for the confirmation prompt and dry output. */
export function describePlan(plan: UninstallPlan): string {
  const lines = ["spider uninstall will:"];
  if (plan.revoke.length)
    lines.push(
      `  revoke the keys of ${plan.revoke.map((a) => a.ref).join(", ")} on their servers`,
    );
  if (plan.forget.length)
    lines.push(
      `  forget ${plan.forget.map((a) => a.ref).join(", ")} (their keys keep working)`,
    );
  lines.push(
    `  uninstall the Claude Code plugins ${plan.plugins.join(", ")} and remove their marketplaces`,
  );
  if (plan.agentFiles.length)
    lines.push(
      `  delete ${plan.agentFiles.length} Claude Code agent file(s) linked to Spider agents`,
    );
  if (plan.config) lines.push(`  delete ${plan.config}`);
  lines.push(
    plan.binary
      ? `  delete the spider binary ${plan.binary}`
      : "  keep the spider command (running from source)",
  );
  lines.push(
    "The agents themselves stay in the tracker; delete them in Settings → Agents.",
  );
  return lines.join("\n");
}

export interface UninstallResult {
  revoked: string[];
  /** Agents whose key couldn't be revoked (server unreachable, …); the key may still work. */
  revokeFailed: { agent: string; error: string }[];
  plugins: { id: string; removed: boolean }[];
  marketplaces: { name: string; removed: boolean }[];
  claudeMissing: boolean;
  deleted: string[];
}

/** Carries out the plan; never stops half way — each step reports instead of throwing. */
export async function runUninstall(
  plan: UninstallPlan,
  deps: { revoke: (entry: AgentEntry) => Promise<void>; runClaude?: RunClaude },
): Promise<UninstallResult> {
  const result: UninstallResult = {
    revoked: [],
    revokeFailed: [],
    plugins: [],
    marketplaces: [],
    claudeMissing: false,
    deleted: [],
  };
  for (const entry of plan.revoke) {
    try {
      await deps.revoke(entry);
      result.revoked.push(entry.ref);
    } catch (err) {
      result.revokeFailed.push({
        agent: entry.ref,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // A plugin or marketplace that isn't there makes claude exit non-zero; that's fine here.
  const claude = async (args: string[]) => {
    if (!deps.runClaude || result.claudeMissing) return false;
    const ran = await deps.runClaude(args);
    if (!ran) result.claudeMissing = true;
    return ran?.exitCode === 0;
  };
  for (const id of plan.plugins) {
    result.plugins.push({
      id,
      removed: await claude(["plugin", "uninstall", id, "--scope", "user"]),
    });
  }
  for (const name of plan.marketplaces) {
    result.marketplaces.push({
      name,
      removed: await claude(["plugin", "marketplace", "remove", name]),
    });
  }
  if (!deps.runClaude) result.claudeMissing = true;

  for (const path of [
    ...plan.caches,
    ...plan.agentFiles,
    ...(plan.config ? [plan.config] : []),
    ...(plan.binary ? [plan.binary] : []),
  ]) {
    const existed = await stat(path).then(
      () => true,
      () => false,
    );
    if (!existed) continue;
    await rm(path, { recursive: true, force: true });
    result.deleted.push(path);
  }
  return result;
}
