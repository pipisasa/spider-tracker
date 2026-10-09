import type { ApiErrorBody, AuthProvidersResponse, MeResponse, WhoAmIResponse } from "@repo/core";
import { DomainError, authenticateApiKey, createOrganization, listMemberships } from "@repo/core";
import type { Db } from "@repo/db";
import { sql } from "drizzle-orm";
import { Hono } from "hono";
import { cors } from "hono/cors";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { enabledAuthProviders, type Auth } from "./auth";
import { toMembership } from "./dto";
import type { Env } from "./env";
import { orgRoutes } from "./routes/orgs";
import type { AppEnv } from "./types";

const errorStatus: Record<DomainError["code"], ContentfulStatusCode> = {
  validation: 400,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
};

function errorBody(code: string, message: string): ApiErrorBody {
  return { error: { code, message } };
}

export function createApp({ db, auth, env }: { db: Db; auth: Auth; env: Env }) {
  const app = new Hono<AppEnv>();

  app.use(
    "*",
    cors({
      origin: env.WEB_ORIGIN,
      credentials: true,
      allowHeaders: ["Content-Type", "Authorization"],
      allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    }),
  );

  app.get("/health", (c) => c.json({ status: "ok" }));

  app.get("/health/ready", async (c) => {
    await db.execute(sql`select 1`);
    return c.json({ status: "ok" });
  });

  app.get("/auth/providers", (c) => {
    const body: AuthProvidersResponse = { providers: enabledAuthProviders(env) };
    return c.json(body);
  });

  app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw));

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

  app.route("/v1/orgs/:orgSlug", orgRoutes(db));

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
