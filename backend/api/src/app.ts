import type { AcceptedAgentInviteDto, ApiErrorBody, AuthProvidersResponse, MeResponse, WhoAmIResponse } from "@repo/core";
import type { InvitationPreviewDto } from "@repo/core";
import {
  DomainError,
  MIN_CLI_HEADER,
  MIN_CLI_VERSION,
  acceptAgentInvite,
  acceptInvitation,
  normalizeAgentInviteCode,
  authenticateApiKey,
  createOrganization,
  listMemberships,
  previewInvitation,
  revokeCurrentApiKey,
} from "@repo/core";
import type { Db } from "@repo/db";
import { sql } from "drizzle-orm";
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { cors } from "hono/cors";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { apiDocsRoutes } from "./api-docs";
import { CLIENT_IP_HEADER, enabledAuthProviders, type Auth } from "./auth";
import { toActorDto, toMembership } from "./dto";
import type { Env } from "./env";
import { mcpRoutes } from "./mcp";
import { openApiDocument } from "./openapi";
import { clientIp, createRateLimiter } from "./rate-limit";
import { deviceApprovalRoutes, deviceRoutes } from "./routes/device";
import { createRealtime } from "./realtime";
import { orgRoutes } from "./routes/orgs";
import type { AppEnv } from "./types";

const errorStatus: Record<DomainError["code"], ContentfulStatusCode> = {
  validation: 400,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  rate_limited: 429,
};

/** An invite code (or link) with the shape of a real one: 8 letters or digits. */
function isWellFormedCode(input: unknown): boolean {
  if (typeof input !== "object" || input === null || !("code" in input) || typeof input.code !== "string") return false;
  return /^[A-Z0-9]{8}$/.test(normalizeAgentInviteCode(input.code));
}

function errorBody(code: string, message: string): ApiErrorBody {
  return { error: { code, message } };
}

export function createApp({ db, auth, env }: { db: Db; auth: Auth; env: Env }) {
  const app = new Hono<AppEnv>();
  const realtime = createRealtime(db);
  const ipOf = (c: Context<AppEnv>) => clientIp(c.req.raw, env.TRUSTED_PROXY, c.env);
  const tooMany = (c: Context<AppEnv>) =>
    c.json(errorBody("rate_limited", "Too many attempts. Try again in a minute"), 429);

  app.use(
    "*",
    cors({
      origin: env.WEB_ORIGIN,
      credentials: true,
      allowHeaders: ["Content-Type", "Authorization", "X-Spider-Source"],
      allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    }),
  );

  app.get("/health", (c) => c.json({ status: "ok", minCliVersion: MIN_CLI_VERSION }));

  // Lets the spider CLI warn when it is older than this server supports.
  const minCli: MiddlewareHandler = async (c, next) => {
    await next();
    c.header(MIN_CLI_HEADER, MIN_CLI_VERSION);
  };
  app.use("/v1/*", minCli);
  app.use("/mcp", minCli);
  app.use("/mcp/*", minCli);

  app.get("/health/ready", async (c) => {
    await db.execute(sql`select 1`);
    return c.json({ status: "ok" });
  });

  app.get("/auth/providers", (c) => {
    const body: AuthProvidersResponse = { providers: enabledAuthProviders(env) };
    return c.json(body);
  });

  const openApi = openApiDocument(env.API_ORIGIN);
  app.get("/openapi.json", (c) => c.json(openApi));
  app.route("/", apiDocsRoutes());

  // Each device code is a database row; rate limited per client IP.
  const deviceCodeRequests = createRateLimiter({ limit: 10, windowMs: 60_000 });
  app.post("/device/code", async (c, next) => {
    if (!deviceCodeRequests.attempt(ipOf(c))) return tooMany(c);
    await next();
  });
  app.route("/device", deviceRoutes(db, env));

  // Better Auth keys its rate limits on CLIENT_IP_HEADER only: set it to the trusted client IP
  // and drop any copy the client sent.
  app.on(["GET", "POST"], "/api/auth/*", (c) => {
    const headers = new Headers(c.req.raw.headers);
    headers.delete(CLIENT_IP_HEADER);
    const ip = ipOf(c);
    if (ip !== "unknown") headers.set(CLIENT_IP_HEADER, ip);
    return auth.handler(new Request(c.req.raw, { headers }));
  });

  // MCP over Streamable HTTP, for agents with an API key (Bearer spt_…).
  app.route("/mcp", mcpRoutes(db, realtime, env.WEB_ORIGIN));

  // Agent invites are accepted without a session: the code is the credential (ST-31).
  // Registered before the /v1 auth middleware; rate limited per client IP, and failed codes from
  // all IPs together are capped so distributed guessing stays bounded.
  const inviteAttempts = createRateLimiter({ limit: 10, windowMs: 60_000 });
  const failedInviteCodes = createRateLimiter({ limit: 100, windowMs: 60 * 60_000 });
  app.post("/v1/agent-invites/accept", async (c) => {
    if (!inviteAttempts.attempt(ipOf(c))) return tooMany(c);
    if (failedInviteCodes.exhausted("all")) {
      return c.json(errorBody("rate_limited", "Too many invalid invite codes. Try again later"), 429);
    }
    const input: unknown = await c.req.json().catch(() => null);
    const source = c.req.header("X-Spider-Source")?.trim().toLowerCase();
    const accepted = await acceptAgentInvite(db, input, source === "cli" || source === "mcp" ? source : "api").catch(
      (err: unknown) => {
        // Only well-formed codes that don't match count: malformed input can't guess anything,
        // and counting it would let one client block onboarding for everyone.
        if (err instanceof DomainError && (err.code === "validation" || err.code === "not_found") && isWellFormedCode(input)) {
          failedInviteCodes.attempt("all");
        }
        throw err;
      },
    );
    const body: AcceptedAgentInviteDto = { ...accepted, actor: toActorDto(accepted.actor, accepted.owner.id) };
    return c.json(body, 201);
  });

  // Joining with an invitation code: per client IP before sign-in is checked, per user below.
  const invitationIpAttempts = createRateLimiter({ limit: 20, windowMs: 60_000 });
  const invitationUserAttempts = createRateLimiter({ limit: 10, windowMs: 60_000 });
  app.use("/v1/invitations/*", async (c, next) => {
    if (!invitationIpAttempts.attempt(ipOf(c))) return tooMany(c);
    await next();
  });

  // Everything under /v1 requires a browser session or an agent API key (Bearer spt_…).
  app.use("/v1/*", async (c, next) => {
    const bearer = c.req.header("Authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
    if (bearer) {
      const key = await authenticateApiKey(db, bearer.trim());
      if (!key) return c.json(errorBody("unauthorized", "Invalid or revoked API key"), 401);
      c.set("apiKey", key);
      return next();
    }
    const data = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!data) return c.json(errorBody("unauthorized", "Sign in required"), 401);
    c.set("user", data.user);
    c.set("session", data.session);
    await next();
  });

  app.get("/v1/whoami", async (c) => {
    const key = c.get("apiKey");
    if (key) {
      const body: WhoAmIResponse = toMembership(key);
      return c.json(body);
    }
    // Browser sessions span organizations; /v1/me lists them.
    return c.json(errorBody("bad_request", "Use /v1/me for browser sessions"), 400);
  });

  app.get("/v1/me", async (c) => {
    const user = c.get("user");
    if (!user) return c.json(errorBody("forbidden", "API keys act inside one organization; use /v1/whoami"), 403);
    const rows = await listMemberships(db, user.id);
    const body: MeResponse = {
      user: { id: user.id, name: user.name, email: user.email, image: user.image ?? null },
      memberships: rows.map(toMembership),
    };
    return c.json(body);
  });

  app.post("/v1/organizations", async (c) => {
    const user = c.get("user");
    if (!user) return c.json(errorBody("forbidden", "Only people can create organizations"), 403);
    const input: unknown = await c.req.json().catch(() => null);
    const created = await createOrganization(db, user, input);
    return c.json(toMembership(created), 201);
  });

  // Joining with an invitation code is for people only; agents are added by an owner.
  app.post("/v1/invitations/preview", async (c) => {
    const user = c.get("user");
    if (!user) return c.json(errorBody("forbidden", "Only people can join organizations"), 403);
    if (!invitationUserAttempts.attempt(user.id)) return tooMany(c);
    const input: unknown = await c.req.json().catch(() => null);
    const body: InvitationPreviewDto = await previewInvitation(db, user.id, input);
    return c.json(body);
  });

  app.post("/v1/invitations/accept", async (c) => {
    const user = c.get("user");
    if (!user) return c.json(errorBody("forbidden", "Only people can join organizations"), 403);
    if (!invitationUserAttempts.attempt(user.id)) return tooMany(c);
    const input: unknown = await c.req.json().catch(() => null);
    const joined = await acceptInvitation(db, user, input);
    return c.json(toMembership(joined), 201);
  });

  app.route("/v1/device", deviceApprovalRoutes(db));

  // `spider logout`: revoke the key this request was made with.
  app.delete("/v1/api-keys/current", async (c) => {
    const key = c.get("apiKey");
    if (!key) return c.json(errorBody("forbidden", "Only API-key requests can revoke their own key"), 403);
    await revokeCurrentApiKey(
      db,
      { orgId: key.organization.id, actorId: key.actor.id, role: key.actor.role, source: "cli" },
      key.keyId,
    );
    return c.body(null, 204);
  });

  app.route("/v1/orgs/:orgSlug", orgRoutes(db, realtime, env.WEB_ORIGIN));

  app.notFound((c) => c.json(errorBody("not_found", "Route not found"), 404));

  app.onError((err, c) => {
    if (err instanceof DomainError) {
      return c.json(errorBody(err.code, err.message), errorStatus[err.code]);
    }
    console.error(err);
    return c.json(errorBody("internal", "Something went wrong"), 500);
  });

  return app;
}
