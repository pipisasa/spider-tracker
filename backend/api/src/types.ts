import type { ActorContext } from "@repo/core";
import type { schema } from "@repo/db";
import type { Auth } from "./auth";

type SessionData = NonNullable<Awaited<ReturnType<Auth["api"]["getSession"]>>>;

export type AppEnv = {
  Variables: {
    /** Set for browser sessions. */
    user?: SessionData["user"];
    session?: SessionData["session"];
    /** Set for API-key requests: the agent the key belongs to. */
    apiKey?: {
      actor: typeof schema.actors.$inferSelect;
      organization: typeof schema.organizations.$inferSelect;
    };
    /** Set by the org middleware on /v1/orgs/:orgSlug/* routes. */
    actor: ActorContext;
  };
};
