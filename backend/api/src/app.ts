import type { ApiErrorBody, AuthProvidersResponse, MeResponse, MembershipDto } from "@repo/core";
import { DomainError, createOrganization, listMemberships } from "@repo/core";
import type { Db } from "@repo/db";
import { sql } from "drizzle-orm";
import { Hono } from "hono";
import { cors } from "hono/cors";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { enabledAuthProviders, type Auth } from "./auth";
import type { Env } from "./env";

type SessionData = NonNullable<Awaited<ReturnType<Auth["api"]["getSession"]>>>;

type AppEnv = {
  Variables: {
    user: SessionData["user"];
    session: SessionData["session"];
  };
};

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

  // Everything under /v1 requires a signed-in user.
  app.use("/v1/*", async (c, next) => {
    const data = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!data) return c.json(errorBody("unauthorized", "Sign in required"), 401);
    c.set("user", data.user);
    c.set("session", data.session);
    await next();
  });

  app.get("/v1/me", async (c) => {
    const user = c.get("user");
    const rows = await listMemberships(db, user.id);
    const body: MeResponse = {
      user: { id: user.id, name: user.name, email: user.email, image: user.image ?? null },
      memberships: rows.map(toMembership),
    };
    return c.json(body);
  });

  app.post("/v1/organizations", async (c) => {
    const input: unknown = await c.req.json().catch(() => null);
    const created = await createOrganization(db, c.get("user"), input);
    return c.json(toMembership(created), 201);
  });

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

function toMembership(row: Awaited<ReturnType<typeof listMemberships>>[number]): MembershipDto {
  const { organization, actor } = row;
  return {
    organization: { id: organization.id, slug: organization.slug, name: organization.name },
    actor: {
      id: actor.id,
      type: actor.type,
      name: actor.name,
      handle: actor.handle,
      avatarUrl: actor.avatarUrl,
      role: actor.role,
    },
  };
}
