import type { DeviceCodeResponse, DeviceTokenResponse } from "@repo/core";
import {
  DEVICE_CODE_TTL_SECONDS,
  DEVICE_POLL_INTERVAL_SECONDS,
  DomainError,
  decideDevice,
  getDeviceRequest,
  pollDeviceToken,
  startDeviceAuthorization,
} from "@repo/core";
import type { Db } from "@repo/db";
import { Hono, type Context } from "hono";
import { toActorDto } from "../dto";
import type { Env } from "../env";
import type { AppEnv } from "../types";

/** RFC 8628 clients may send JSON or form-encoded bodies. */
async function readBody(c: Context): Promise<Record<string, unknown>> {
  const type = c.req.header("Content-Type") ?? "";
  if (type.includes("application/x-www-form-urlencoded"))
    return Object.fromEntries(new URLSearchParams(await c.req.text()));
  return (
    ((await c.req.json().catch(() => null)) as Record<
      string,
      unknown
    > | null) ?? {}
  );
}

/** Public device endpoints used by `spider login` (POST /device/code, POST /device/token). */
export function deviceRoutes(db: Db, env: Env) {
  const app = new Hono<AppEnv>();

  app.post("/code", async (c) => {
    const { deviceCode, userCode } = await startDeviceAuthorization(
      db,
      await readBody(c),
    );
    const verification = `${env.WEB_ORIGIN}/device`;
    const body: DeviceCodeResponse = {
      device_code: deviceCode,
      user_code: userCode,
      verification_uri: verification,
      verification_uri_complete: `${verification}?code=${encodeURIComponent(userCode)}`,
      expires_in: DEVICE_CODE_TTL_SECONDS,
      interval: DEVICE_POLL_INTERVAL_SECONDS,
    };
    return c.json(body);
  });

  app.post("/token", async (c) => {
    const deviceCode = (await readBody(c)).device_code;
    if (typeof deviceCode !== "string")
      return c.json({ error: "invalid_request" }, 400);
    const result = await pollDeviceToken(db, deviceCode);
    // Errors use the OAuth shape ({ "error": "authorization_pending" }), as device clients expect.
    if (result.status !== "approved")
      return c.json({ error: result.status }, 400);
    const body: DeviceTokenResponse = {
      access_token: result.secret,
      token_type: "Bearer",
      actor: toActorDto(result.actor, result.ownerId),
      organization: {
        id: result.organization.id,
        slug: result.organization.slug,
        name: result.organization.name,
      },
    };
    return c.json(body);
  });

  return app;
}

/** Signed-in routes for the approval page (mounted at /v1/device). */
export function deviceApprovalRoutes(db: Db) {
  const app = new Hono<AppEnv>();

  const userId = (c: Context<AppEnv>) => {
    const user = c.get("user");
    if (!user)
      throw new DomainError("forbidden", "Only people can approve devices");
    return user.id;
  };

  app.get("/:userCode", async (c) => {
    userId(c);
    return c.json(await getDeviceRequest(db, c.req.param("userCode")));
  });

  app.post("/:userCode/approve", async (c) => {
    const body = (await c.req.json().catch(() => null)) as {
      orgSlug?: unknown;
    } | null;
    if (typeof body?.orgSlug !== "string")
      throw new DomainError("validation", "orgSlug is required");
    await decideDevice(db, userId(c), c.req.param("userCode"), {
      approve: true,
      orgSlug: body.orgSlug,
    });
    return c.body(null, 204);
  });

  app.post("/:userCode/deny", async (c) => {
    await decideDevice(db, userId(c), c.req.param("userCode"), {
      approve: false,
    });
    return c.body(null, 204);
  });

  return app;
}
