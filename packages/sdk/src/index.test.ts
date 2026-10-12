import { describe, expect, test } from "bun:test";
import { SpiderApiError, createClient } from "./index";

function recorder(response: () => Response) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetch = (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return response();
  };
  return { calls, fetch };
}

describe("createClient", () => {
  test("sends Bearer auth, the declared source and a JSON body", async () => {
    const { calls, fetch } = recorder(() => Response.json({ key: "SPI-1" }, { status: 201 }));
    const client = createClient({ baseUrl: "https://api.test/", token: "spt_x", source: "cli", fetch });

    expect(await client.tasks.create("acme", "SPI", { title: "Hi" })).toMatchObject({ key: "SPI-1" });
    const [call] = calls;
    expect(call?.url).toBe("https://api.test/v1/orgs/acme/projects/SPI/tasks");
    expect(call?.init.method).toBe("POST");
    expect(call?.init.body).toBe(JSON.stringify({ title: "Hi" }));
    expect(call?.init.credentials).toBeUndefined();
    const headers = new Headers(call?.init.headers);
    expect(headers.get("Authorization")).toBe("Bearer spt_x");
    expect(headers.get("X-Spider-Source")).toBe("cli");
    expect(headers.get("Content-Type")).toBe("application/json");
  });

  test("uses the session cookie without a token", async () => {
    const { calls, fetch } = recorder(() => Response.json({ items: [] }));
    await createClient({ baseUrl: "https://api.test", fetch }).projects.list("acme");
    expect(calls[0]?.init.credentials).toBe("include");
    expect(new Headers(calls[0]?.init.headers).has("Authorization")).toBe(false);
  });

  test("returns undefined for 204", async () => {
    const { fetch } = recorder(() => new Response(null, { status: 204 }));
    expect(await createClient({ baseUrl: "https://api.test", fetch }).tasks.delete("acme", "SPI-1")).toBeUndefined();
  });

  test("throws SpiderApiError with the API's code and message", async () => {
    const { fetch } = recorder(() =>
      Response.json({ error: { code: "not_found", message: "Task not found" } }, { status: 404 }),
    );
    const error = await createClient({ baseUrl: "https://api.test", fetch })
      .tasks.get("acme", "SPI-9")
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SpiderApiError);
    expect(error).toMatchObject({ status: 404, code: "not_found", message: "Task not found" });
  });

  test("non-JSON errors name the request and the status, even without status text (HTTP/2)", async () => {
    const fail = async (res: Response) =>
      createClient({ baseUrl: "https://api.test", fetch: recorder(() => res).fetch })
        .whoami()
        .catch((e: unknown) => e);
    expect(await fail(new Response("oops", { status: 502, statusText: "Bad Gateway" }))).toMatchObject({
      status: 502,
      code: "unknown",
      message: "GET /v1/whoami failed with HTTP 502 Bad Gateway",
    });
    expect(await fail(new Response("<html></html>", { status: 403 }))).toMatchObject({
      status: 403,
      message: "GET /v1/whoami failed with HTTP 403",
    });
  });
});
