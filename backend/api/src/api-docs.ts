import { Hono } from "hono";

// Interactive API reference pages over the spec at /openapi.json (ST-24):
// Swagger UI at /swagger and Scalar at /scalar. Both load a pinned build from
// jsDelivr with subresource integrity, so the API has no extra dependencies.

const SPEC_URL = "/openapi.json";

const SWAGGER_UI = "https://cdn.jsdelivr.net/npm/swagger-ui-dist@5.32.15";
const SWAGGER_UI_JS_SRI = "sha384-m7zaGj7MPzU+G4lz2eyy73GxK9bbRDr9bB2CSdj8wodg2wu/Wnt6wsoLP3JD+RS9";
const SWAGGER_UI_CSS_SRI = "sha384-fgyWYkUAamzuI8mJFu/xpRP0JWCJRwkwUwsYDoOYVHUJ8NQE5cENn8ib3ppwFFSX";

const SCALAR_JS = "https://cdn.jsdelivr.net/npm/@scalar/api-reference@1.68.0/dist/browser/standalone.js";
const SCALAR_JS_SRI = "sha384-PhSzhE9ihf7z/cKeRSKAeP+oJMMzotyFv0EjvNYgL798a2ODBQVuJLTP4Klle6IB";

const TITLE = "Spider Tracker API";

export const swaggerHtml = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${TITLE} — Swagger UI</title>
    <link rel="stylesheet" href="${SWAGGER_UI}/swagger-ui.css" integrity="${SWAGGER_UI_CSS_SRI}" crossorigin="anonymous" />
  </head>
  <body>
    <div id="swagger-ui"></div>
    <script src="${SWAGGER_UI}/swagger-ui-bundle.js" integrity="${SWAGGER_UI_JS_SRI}" crossorigin="anonymous"></script>
    <script>
      window.ui = SwaggerUIBundle({ url: "${SPEC_URL}", dom_id: "#swagger-ui", deepLinking: true });
    </script>
  </body>
</html>
`;

export const scalarHtml = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${TITLE} — Reference</title>
  </head>
  <body>
    <div id="app"></div>
    <script src="${SCALAR_JS}" integrity="${SCALAR_JS_SRI}" crossorigin="anonymous"></script>
    <script>
      Scalar.createApiReference("#app", { url: "${SPEC_URL}", withDefaultFonts: false });
    </script>
  </body>
</html>
`;

export function apiDocsRoutes() {
  const docs = new Hono();
  docs.get("/swagger", (c) => c.html(swaggerHtml));
  docs.get("/scalar", (c) => c.html(scalarHtml));
  return docs;
}
