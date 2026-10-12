import type { ApiErrorBody, GithubInstallUrlDto, GithubStatusDto } from "@repo/core";
import {
  DomainError,
  GITHUB_WEBHOOK_MAX_BYTES,
  GithubInstallationTakenError,
  assertCanSyncGithubInstallation,
  createGithubInstallState,
  disconnectGithubInstallation,
  handleGithubWebhook,
  listGithubInstallations,
  resolveGithubSetup,
  saveGithubInstallation,
  verifyGithubSignature,
  type ActorContext,
  type GithubWebhookResult,
} from "@repo/core";
import type { Db } from "@repo/db";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { Auth } from "../auth";
import type { Env } from "../env";
import { GithubUnavailableError, logGithubFailure, type GithubApp } from "../github";
import type { AppEnv } from "../types";

// The GitHub App (ST-82): Settings → GitHub's routes under /v1/orgs/:orgSlug/github, and the
// /github/setup callback GitHub sends the person back to after installing. Without the App's
// settings (GITHUB_APP_*) GET /github says `configured: false` and the rest answer 503.

export const notConfigured: ApiErrorBody = { error: { code: "not_configured", message: "GitHub isn't configured on this server" } };

/** GitHub's installation id in a path or query; null when it isn't one. */
function installationIdOf(value: string | undefined): number | null {
  if (!value || !/^\d{1,15}$/.test(value)) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

/** Fetches the installation and its repositories from GitHub and saves them. */
async function connect(db: Db, github: GithubApp, ctx: ActorContext, id: number) {
  const installation = await github.getInstallation(id);
  if (!installation) throw new DomainError("not_found", `GitHub has no installation ${id}; it was uninstalled. Disconnect it here`);
  const repositories = await github.listInstallationRepos(id);
  return saveGithubInstallation(db, ctx, { installation, repositories });
}

/** Mounted at /v1/orgs/:orgSlug/github, after the organization middleware. */
export function githubOrgRoutes(db: Db, github: GithubApp | null, stateSecret: string) {
  const app = new Hono<AppEnv>();

  app.get("/", async (c) => {
    const body: GithubStatusDto = {
      configured: github !== null,
      appSlug: github?.slug ?? null,
      installations: await listGithubInstallations(db, c.get("actor")),
    };
    return c.json(body);
  });

  // A browser flow: only a signed-in person can finish it at /github/setup.
  app.post("/install", async (c) => {
    if (!github) return c.json(notConfigured, 503);
    const user = c.get("user");
    if (!user) throw new DomainError("forbidden", "Only people can connect GitHub, from Settings → GitHub");
    const state = await createGithubInstallState(db, c.get("actor"), { secret: stateSecret, userId: user.id });
    const body: GithubInstallUrlDto = { url: github.installUrl(state) };
    return c.json(body);
  });

  app.post("/installations/:installationId/sync", async (c) => {
    if (!github) return c.json(notConfigured, 503);
    const id = installationIdOf(c.req.param("installationId"));
    if (id === null) throw new DomainError("not_found", "GitHub installation not found");
    // Permission and ownership before asking GitHub anything.
    await assertCanSyncGithubInstallation(db, c.get("actor"), id);
    return c.json(await connect(db, github, c.get("actor"), id));
  });

  app.delete("/installations/:installationId", async (c) => {
    const id = installationIdOf(c.req.param("installationId"));
    if (id === null) throw new DomainError("not_found", "GitHub installation not found");
    await disconnectGithubInstallation(db, c.get("actor"), id);
    return c.body(null, 204);
  });

  return app;
}

/** Why connecting failed, for Settings → GitHub's message (?error=). */
export type GithubSetupError =
  | "missing_installation"
  | "not_verified"
  | "no_access"
  | "not_found"
  | "other_organization"
  | "conflict"
  | "forbidden"
  | "github_unavailable";

/** GET /github/setup: GitHub's "Setup URL" (and the OAuth callback when it asks the person to authorize). */
export function githubSetupRoutes(db: Db, auth: Auth, github: GithubApp | null, env: Pick<Env, "WEB_ORIGIN" | "BETTER_AUTH_SECRET">) {
  const app = new Hono<AppEnv>();

  app.get("/setup", async (c: Context<AppEnv>) => {
    if (!github) return c.json(notConfigured, 503);
    const { state, installation_id: rawId, setup_action: action, code } = c.req.query();
    // Without our state the change was made on GitHub's side (repository access, for example):
    // there is nothing to connect here; webhooks (ST-83) or a sync pick it up.
    if (!state) return c.redirect(env.WEB_ORIGIN);

    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session) return c.text("Sign in to Spider Tracker, then connect GitHub again from Settings → GitHub.", 401);

    let resolved: Awaited<ReturnType<typeof resolveGithubSetup>>;
    try {
      resolved = await resolveGithubSetup(db, { secret: env.BETTER_AUTH_SECRET, state, userId: session.user.id });
    } catch (err) {
      if (!(err instanceof DomainError)) throw err;
      return c.text(err.message, err.code === "validation" ? 400 : 403);
    }
    const back = (query: string) =>
      c.redirect(`${env.WEB_ORIGIN}/${encodeURIComponent(resolved.orgSlug)}/settings/github?${query}`);
    const fail = (reason: GithubSetupError) => back(`error=${reason}`);

    // An organization member without the right to install asked its owners on GitHub.
    if (action === "request") return back("requested=1");
    const id = installationIdOf(rawId);
    if (id === null) return fail("missing_installation");
    // The App must ask the person to authorize it during installation: the code proves who they
    // are on GitHub, and that they can access this installation (anyone can type an id).
    if (!code) return fail("not_verified");

    try {
      if (!(await github.userCanAccessInstallation(code, id))) return fail("no_access");
      const installation = await connect(db, github, resolved.ctx, id);
      return back(`connected=${installation.id}`);
    } catch (err) {
      if (err instanceof GithubUnavailableError) {
        logGithubFailure(err);
        return fail("github_unavailable");
      }
      if (err instanceof DomainError) {
        if (err instanceof GithubInstallationTakenError) return fail("other_organization");
        if (err.code === "conflict") return fail("conflict");
        if (err.code === "not_found") return fail("not_found");
        if (err.code === "forbidden") return fail("forbidden");
      }
      throw err;
    }
  });

  return app;
}

const tooLarge: ApiErrorBody = { error: { code: "payload_too_large", message: "The webhook body is too large" } };

/**
 * POST /webhooks/github (ST-83): the App's webhook. The signature is checked over the raw bytes
 * before anything is parsed; then core handles the delivery once (by X-GitHub-Delivery).
 */
export function githubWebhookRoutes(db: Db, github: GithubApp | null, webhookSecret: string | null) {
  const app = new Hono<AppEnv>();
  if (!github || !webhookSecret) {
    app.post("/github", (c) => c.json(notConfigured, 503));
    return app;
  }
  const secret = webhookSecret;

  app.post(
    "/github",
    bodyLimit({ maxSize: GITHUB_WEBHOOK_MAX_BYTES, onError: (c) => c.json(tooLarge, 413) }),
    async (c) => {
      const body = new Uint8Array(await c.req.arrayBuffer());
      if (body.byteLength > GITHUB_WEBHOOK_MAX_BYTES) return c.json(tooLarge, 413);
      if (!verifyGithubSignature(secret, body, c.req.header("X-Hub-Signature-256"))) {
        return c.json({ error: { code: "unauthorized", message: "Invalid webhook signature" } } satisfies ApiErrorBody, 401);
      }
      const deliveryId = c.req.header("X-GitHub-Delivery") ?? "";
      const event = c.req.header("X-GitHub-Event") ?? "";
      let payload: unknown;
      try {
        payload = JSON.parse(new TextDecoder().decode(body));
      } catch {
        throw new DomainError("validation", "The webhook body isn't JSON");
      }
      const status: GithubWebhookResult = await handleGithubWebhook(db, { deliveryId, event, payload });
      return c.json({ status });
    },
  );

  return app;
}
