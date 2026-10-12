import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import postgres from "postgres";

// Integration test: needs TEST_DATABASE_URL. Each migration with a data fix runs, as written, in a
// throwaway schema holding the tables it touches in their shape just before it; the transaction
// is rolled back, so the test database is left as it was.
const url = process.env.TEST_DATABASE_URL;
const run = url ? describe : describe.skip;

const migrations = new URL("../migrations/", import.meta.url);

function statements(prefix: string): string[] {
  const file = readdirSync(migrations).find(
    (f) => f.startsWith(prefix) && f.endsWith(".sql"),
  );
  if (!file) throw new Error(`No migration ${prefix}`);
  return readFileSync(new URL(file, migrations), "utf8").split(
    "--> statement-breakpoint",
  );
}

class Rollback extends Error {}

/** Runs `body` in a transaction with a fresh schema first on the search path, then rolls back. */
async function inScratchSchema(
  body: (tx: postgres.TransactionSql) => Promise<void>,
) {
  const sql = postgres(url ?? "", { max: 1, onnotice: () => {} });
  try {
    await sql.begin(async (tx) => {
      const name = `migration_test_${crypto.randomUUID().replaceAll("-", "")}`;
      await tx.unsafe(`create schema "${name}"`);
      await tx.unsafe(`set local search_path to "${name}"`);
      await body(tx);
      throw new Rollback();
    });
  } catch (err) {
    if (!(err instanceof Rollback)) throw err;
  } finally {
    await sql.end();
  }
}

run("migration data fixes", () => {
  test("0014 renames tags differing only by case and orders relates links", async () => {
    await inScratchSchema(async (tx) => {
      // Shapes from 0006 and 0007, without foreign keys.
      await tx.unsafe(`
        create table "tags" (
          "id" uuid primary key default uuidv7() not null,
          "org_id" uuid not null,
          "name" text not null,
          "color" text,
          "created_at" timestamp with time zone default now() not null,
          constraint "tags_org_name_key" unique("org_id", "name")
        );
        create table "task_relations" (
          "from_task_id" uuid not null,
          "to_task_id" uuid not null,
          "type" text not null,
          "created_by" uuid,
          "created_at" timestamp with time zone default now() not null,
          constraint "task_relations_from_task_id_to_task_id_type_pk" primary key("from_task_id", "to_task_id", "type"),
          constraint "task_relations_not_self" check ("task_relations"."from_task_id" <> "task_relations"."to_task_id")
        );`);

      const [org, other] = [crypto.randomUUID(), crypto.randomUUID()];
      await tx`
        insert into "tags" ("org_id", "name", "created_at") values
          (${org}, 'Bug', '2026-01-01'),
          (${org}, 'bug', '2026-01-02'),
          (${org}, 'BUG', '2026-01-03'),
          (${org}, 'bug (2)', '2026-01-04'),
          (${other}, 'BUG', '2026-01-05')`;

      const id = (n: number) => `00000000-0000-7000-8000-00000000000${n}`;
      const [a, b, c, d] = [id(1), id(2), id(3), id(4)];
      await tx`
        insert into "task_relations" ("from_task_id", "to_task_id", "type") values
          (${b}, ${a}, 'relates'),
          (${a}, ${b}, 'relates'),
          (${d}, ${c}, 'relates'),
          (${b}, ${a}, 'blocks'),
          (${d}, ${c}, 'duplicates')`;

      for (const statement of statements("0014_")) await tx.unsafe(statement);

      const tags = await tx<{ org_id: string; name: string }[]>`
        select "org_id", "name" from "tags" order by "created_at"`;
      expect(
        tags.map((t) => [t.org_id === org ? "org" : "other", t.name]),
      ).toEqual([
        ["org", "Bug"],
        ["org", "bug (3)"],
        ["org", "BUG (4)"],
        ["org", "bug (2)"],
        ["other", "BUG"],
      ]);

      const links = await tx<
        { from_task_id: string; to_task_id: string; type: string }[]
      >`
        select "from_task_id", "to_task_id", "type" from "task_relations" order by "type", "from_task_id", "to_task_id"`;
      expect(links.map((l) => [l.from_task_id, l.to_task_id, l.type])).toEqual([
        [b, a, "blocks"],
        [d, c, "duplicates"],
        [a, b, "relates"],
        [c, d, "relates"],
      ]);

      // The new constraints hold from now on.
      const clash =
        await tx`insert into "tags" ("org_id", "name") values (${org}, 'BUG (3)')`.then(
          () => null,
          (err: unknown) => err,
        );
      expect(clash).toMatchObject({ code: "23505" });
    });
  });
});
