import { defineRailway, github, postgres, preserve, project, service, volume } from "railway/iac";

export default defineRailway(() => {
  const Postgres = postgres("Postgres", { region: "us-west2" });
  Postgres.networking = { privateNetworkEndpoint: "postgres" };
  const postgresVolume = volume("postgres-volume", { alerts: { usage: { "100": {}, "80": {}, "95": {} } }, allowOnlineResize: true, region: "us-west2", sizeMB: 5000 });
  // Deployed by Railway from GitHub on every push to main that touches the API's code.
  // Railway's default builder (Railpack) installs the Bun workspace from the repo root;
  // migrations run once per deploy before the new version takes traffic.
  const api = service("api", {
    source: github("pipisasa/spider-tracker", { branch: "main" }),
    build: {
      builder: "RAILPACK",
      watchPatterns: ["backend/api/**", "packages/**", "package.json", "bun.lock", ".railway/**"],
    },
    start: "bun backend/api/src/index.ts",
    preDeploy: "bun packages/db/src/migrate.ts",
    healthcheck: "/health/ready",
    healthcheckTimeout: 60,
    replicas: { "us-west2": 1 },
    domains: ["tracker-api.batele.plus"],
    env: { API_ORIGIN: preserve(), BATELE_ID_CLIENT_ID: preserve(), BETTER_AUTH_SECRET: preserve(), DATABASE_URL: preserve(), NODE_ENV: preserve(), SIGNUP_ALLOWLIST: preserve(), WEB_ORIGIN: preserve() },
  });

  return project("spider-tracker", {
    resources: [api, Postgres, postgresVolume],
  });
});
