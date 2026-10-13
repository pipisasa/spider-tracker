import { sql } from "drizzle-orm";
import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { actors, organizations } from "./tenancy";

// OAuth 2.0 device authorization (RFC 8628) for `spider login`. Only a hash of the
// device code is stored; the API key is minted when the approved device polls.
export const deviceCodes = pgTable("device_codes", {
  id: uuid("id")
    .primaryKey()
    .default(sql`uuidv7()`),
  deviceCodeHash: text("device_code_hash").notNull().unique(),
  /** Short code the person types or confirms in the browser, e.g. "WDJB-MJHT". */
  userCode: text("user_code").notNull().unique(),
  /** What the device calls itself, e.g. "MacBook". */
  clientName: text("client_name").notNull(),
  status: text("status", {
    enum: ["pending", "approved", "denied", "consumed"],
  })
    .notNull()
    .default("pending"),
  orgId: uuid("org_id").references(() => organizations.id, {
    onDelete: "cascade",
  }),
  /** The person (actor) who approved or denied it. */
  decidedBy: uuid("decided_by").references(() => actors.id, {
    onDelete: "set null",
  }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  lastPolledAt: timestamp("last_polled_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
