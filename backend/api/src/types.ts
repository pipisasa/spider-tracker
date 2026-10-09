import type { ActorContext } from "@repo/core";
import type { Auth } from "./auth";

type SessionData = NonNullable<Awaited<ReturnType<Auth["api"]["getSession"]>>>;

export type AppEnv = {
  Variables: {
    user: SessionData["user"];
    session: SessionData["session"];
    /** Set by the org middleware on /v1/orgs/:orgSlug/* routes. */
    actor: ActorContext;
  };
};
