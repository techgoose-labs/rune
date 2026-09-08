/**
 * Swagger docs UI. Access is a POLICY question now, answered once by the app's
 * composition (D-11): keep's unit declares `/docs/*` open in dev and
 * `authenticated` otherwise, bedrock resolves it, and the page below is never
 * reached by a caller the app rejected. So there is no token to seed, stash in
 * localStorage, or attach here — a browser that can load the page already
 * carries whatever credential the auth unit wanted, and sends it on the
 * same-origin spec fetch by itself.
 */

const SWAGGER_UI_VERSION = "5";

export interface DocsJsonHandlerOptions {
  /** The serialized OpenAPI document to serve. */
  specJson: string;
}

/** Builds the handler for the open `/docs/<module>/json` endpoint. */
export function createDocsJsonHandler(
  opts: DocsJsonHandlerOptions,
): () => Promise<Response> {
  const json = () =>
    new Response(opts.specJson, {
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  return () => Promise.resolve(json());
}

/** Kept as the no-op it now is so the doc pages compose the same way. */
export function injectDocsScript(html: string): string {
  return html;
}

/**
 * A self-contained Swagger UI page that loads the spec from `<currentPath>/json` with the
 * stored token, and shows a clear message (and clears the token) on a `401`.
 */
export function swaggerShellHtml(title: string): string {
  const cssHref =
    `https://unpkg.com/swagger-ui-dist@${SWAGGER_UI_VERSION}/swagger-ui.css`;
  const bundleSrc =
    `https://unpkg.com/swagger-ui-dist@${SWAGGER_UI_VERSION}/swagger-ui-bundle.js`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<link rel="stylesheet" href="${cssHref}">
<style>body{margin:0}#danet-docs-message{font-family:system-ui,sans-serif;padding:2rem;color:#b91c1c}</style>
</head>
<body>
<div id="swagger-ui"></div>
<div id="danet-docs-message" hidden></div>
<script src="${bundleSrc}" crossorigin></script>
<script>
window.addEventListener("load", function(){
  var p = window.location.pathname;
  if (p.charAt(p.length - 1) === "/") p = p.slice(0, -1);
  // The Swagger UI page is served at /docs/<module>/swagger; its spec lives at /docs/<module>/json.
  var jsonUrl = p.replace(/\\/swagger$/, "") + "/json";
  window.ui = SwaggerUIBundle({
    url: jsonUrl,
    dom_id: "#swagger-ui",
    deepLinking: true,
    // Same-origin: the browser sends whatever credential the auth unit issued.
    responseInterceptor: function(res){
      if (res.status === 401 || res.status === 403){
        var m = document.getElementById("danet-docs-message");
        document.getElementById("swagger-ui").innerHTML = "";
        m.hidden = false;
        m.textContent = "Access denied — sign in and reload this page.";
      }
      return res;
    }
  });
});
</script>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (
      ch,
    ) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    }[ch]!),
  );
}
