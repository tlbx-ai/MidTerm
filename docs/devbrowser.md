# Web Preview Dev Browser — Proxy Design

The web preview reverse proxy (`/webpreview/*`) intercepts browser requests and forwards them to an upstream target. HTTP requests are straightforward (strip prefix, forward, return response). WebSocket connections are relayed without content modification.

## URL Space Design

The proxy uses a **write-only interception** strategy. The injected `UrlRewriteScript` patches outgoing APIs to add `/webpreview` to URLs before they leave JavaScript:

- `fetch`, `XMLHttpRequest.open` — HTTP requests
- `WebSocket`, `EventSource` — connection constructors
- `history.pushState`, `history.replaceState` — navigation
- `location.assign`, `location.replace` — redirects
- Element `.src`, `.href`, `.action` setters — DOM properties
- `setAttribute` — attribute writes

Read-side APIs (`location.href`, `location.pathname`, `document.URL`, `document.baseURI`) are **not spoofed**. The page sees its real URL including `/webpreview/`.

| Layer | URL the code sees | Example |
|-------|-------------------|---------|
| **Browser** | `https://proxy:2000/webpreview/page` | Real browser URL |
| **JavaScript** | `https://proxy:2000/webpreview/page` | `location.pathname` = `/webpreview/page` |
| **Upstream** | `https://upstream.example.com/page` | What the real server knows |

The `<base href="/webpreview/">` tag is injected into every HTML response, so:
- `document.baseURI` = `https://proxy:2000/webpreview/` (from `<base>` tag)
- `location.href` = `https://proxy:2000/webpreview/page` (real browser URL)
- Both are consistent — frameworks see the app mounted at `/webpreview/`

### Navigation Notifications

Each docked or detached preview now gets a registered preview identity (`sessionId`, `previewId`, `previewToken`) from `POST /api/browser/preview-client`. The parent writes that identity into `iframe.name` before loading the proxied page, and the injected script uses it for all bridge traffic.

The injected script sends `postMessage({type: "mt-navigation", url: location.href, upstreamUrl: ..., targetOrigin: window.__mtTargetOrigin, previewId, previewToken})` to the parent window whenever in-iframe navigation occurs:

- `history.pushState` / `history.replaceState` — SPA navigation
- `popstate` / `hashchange` events — back/forward navigation
- Initial page load (`setTimeout(ntfy, 0)`) — captures redirects

The parent `webPanel.ts` / detached popup listener accepts these messages only when the preview identity matches the current iframe. It prefers the injected `upstreamUrl` field, so redirects and `_ext` navigations no longer need to be reverse-engineered from the iframe URL bar.

### Why No Read-Side Spoofing?

Chrome's `Location.prototype` properties have `configurable: false`. `Object.defineProperty(location, "href", ...)` silently fails. But `document.baseURI` and `document.URL` *can* be overridden. This inconsistency is fatal for frameworks like Blazor that compare `location.href` against `document.baseURI` — they see mismatched URL spaces and fail to route.

## WebSocket Relay (No Content Rewriting)

WebSocket messages are relayed **untouched** between client and upstream. No URL rewriting, no binary manipulation, no protocol-specific handling.

This works because:
- **Frameworks use relative paths for routing.** Blazor's `NavigationManager` computes routes as `currentUri` minus `baseUri`. If both are proxy URLs (`https://proxy:2000/webpreview/...`), the relative path is identical to what it would be with upstream URLs.
- **Server state comes from the client.** Blazor's `StartCircuit` receives `baseUri` and `currentUri` from the client. The server stores these and uses them for all subsequent URL operations. Since the client sends proxy URLs, the server's `NavigationManager` operates in the proxy URL space.
- **Server echoes client-provided URLs.** When the server sends URLs back (e.g., `OnLocationChanged`), they're already proxy URLs. No rewriting needed.
- **No message corruption risk.** Previous approaches rewrote URL strings inside JSON and MessagePack binary frames, which required: text `string.Replace`, MessagePack string header adjustment, SignalR VarInt length prefix re-encoding. Each layer was a source of bugs.

### What About Server-Generated URLs?

If the upstream server independently generates URLs using its own origin (not from client state), those URLs would point to the upstream directly. The client's `fetch`/`XHR` interceptors would route them through the `/_ext` external proxy. This is functional, though slightly less efficient than direct `/webpreview/` routing.

In practice, Blazor and most SPA frameworks derive all URLs from client-provided state, so this edge case rarely occurs.

## Cookie Bridge

Upstream cookies are stored in MidTerm's server-side `CookieContainer`. The browser bridge under `/webpreview/_cookies` intentionally exposes only **script-visible** cookies:

- `HttpOnly` cookies stay server-only and are still forwarded upstream on HTTP/WebSocket requests
- `document.cookie` inside the proxied page sees only non-`HttpOnly` cookies
- `document.cookie = ...` writes also behave like a browser: `HttpOnly` is ignored on writes from page JavaScript

The proxied page no longer calls `/webpreview/_cookies` directly. Instead, the injected script posts `mt-cookie-request` messages to its parent window, and the parent performs the authenticated fetch on the page's behalf. This removes the last iframe dependency on `contentWindow`/same-origin access and keeps the cookie bridge working once the iframe is sandboxed.

The bridge resolves cookies against the current upstream page URL either from the explicit `?u=` query parameter supplied by the parent or, as a fallback, the iframe referer.

## Browser Bridge Targeting

Browser automation is now scoped per preview client instead of "whichever iframe connected last":

- `/ws/browser` accepts preview-scoped connections with `previewId` / `token`
- `BrowserCommandService` keeps one command listener per connected preview client
- only one browser bridge connection is accepted per preview id; later duplicates are rejected
- commands without `--session` only run when exactly one preview is connected
- commands with `--session` route only to that session's preview
- docked UI screenshot capture sends the active docked `previewId`, so nested previews under the same terminal session do not collide

The injected browser bridge now connects immediately from the server-injected head script, before upstream page scripts run. This lets MidTerm claim the preview's browser-control channel before page JavaScript can open its own `/ws/browser` socket. The injected screenshot command also loads `html2canvas` via a blob URL created from the native fetch response, so proxy URL rewriting no longer breaks `mtbrowser screenshot`.

## Dev-Mode Sandbox

In dev-mode and local-dev runs, the docked preview iframe and detached popup iframe opt into a real sandbox:

- `sandbox="allow-scripts allow-forms allow-popups allow-modals allow-downloads"`
- no `allow-same-origin`, so the proxied page runs with an opaque origin
- MidTerm's own `localStorage`, `CacheStorage`, and service-worker scope are no longer shared with the previewed app

Because opaque-origin sandboxed frames become cross-site from the browser's perspective, MidTerm relaxes the auth cookie to `SameSite=None` only for dev-mode/local-dev runs. Production/stable-style runs keep `SameSite=Lax`.

## Dedicated Preview Origin

When MidTerm can reserve `port + 1`, preview clients now receive a dedicated frame origin on that secondary listener:

- the main app stays on `https://host:port`
- the iframe loads proxied content from `https://host:port+1`
- preview client registration returns that origin to the docked panel and detached popup

The preview listener blocks normal MidTerm app pages and non-browser WebSockets on the secondary port, so leaked navigations do not fall back into the MidTerm application on the preview origin. If the extra port is unavailable, MidTerm falls back to the primary origin and keeps the sandbox protections from step 3.

## MidTerm-In-MidTerm

Self-preview is supported only when the dedicated preview origin is active:

- target the main app origin (`https://host:port`), not the preview origin (`port + 1`)
- the preview-origin listener itself is still rejected as a web-preview target, so the proxy never points at its own isolated frame host
- proxied requests to MidTerm itself mirror the current `mm-session` auth cookie from the browser request into the in-memory proxy cookie jar before each upstream HTTP/WebSocket hop
- that mirrored auth cookie is deliberately excluded from cookie-disk persistence, so nested MidTerm stays authenticated without writing MidTerm session tokens into the preview cookie files

This is what keeps nested MidTerm from falling into `/login.html` once its own `/api/*` and `/ws/*` traffic starts flowing through the dev browser.

## Canonical Host Adoption

MidTerm only auto-updates the stored preview target when a **document/iframe HTML navigation** lands on a different authority:

- asset redirects no longer rewrite the preview target
- same-host/different-port URLs are treated as different authorities
- host canonicalization preserves the current preview base path for normal `/webpreview/*` navigations
- `/_ext` HTML navigations switch the stored target to the new authority root so refresh/detach continue from the external site instead of the previous host

## Proxy Log

`GET /api/webpreview/proxylog?limit=N` returns the last N proxy requests (default 100) with full details:

- Request/response headers, cookies
- Upstream URL, status code, duration
- WebSocket sub-protocols, negotiated protocol
- Error messages on failure

CLI: `mt_proxylog [limit]` / `Mt-ProxyLog [-Limit N]`

Use this as the **first diagnostic step** when a site doesn't work through the proxy.

## Debugging Checklist

When a website doesn't load through the web preview:

1. **`mt_proxylog`** — Check if requests reach upstream and what status codes come back
2. **`mt_log error`** — Check browser console for JS errors
3. **`mt_outline`** — Check if the page has any rendered content
4. **WebSocket entries in proxylog** — Check `statusCode` (101 = connected, 502 = failed), `subProtocols`, `error`
5. **`mt_exec` to inspect framework state** — e.g., `Blazor._internal.navigationManager` for baseUri/currentUri

### Common Failures

| Symptom | Likely Cause |
|---------|-------------|
| WS status 502 | Upstream rejected connection (wrong Origin, missing cookies, SSL error) |
| WS 101 but page empty | Framework routing issue — check NavigationManager or router state |
| Page renders but navigation broken | URL inconsistency between location.href and document.baseURI |
| CSS/JS 404s | Root-relative URLs claimed by `IsMidTermPath` — only MidTerm's own pages/assets should be listed there |
| Login redirect loops | Cookies not forwarding — check `requestCookies`/`responseCookies` in proxylog |
| All assets return HTML | Host redirect (e.g. `foo.com` → `www.foo.com`) drops the path — proxy auto-updates target on first redirect |

## Implementation Files

| File | Role |
|------|------|
| `WebPreviewProxyMiddleware.cs` | Core proxy: HTTP forwarding, WebSocket relay, injected JS |
| `WebPreviewService.cs` | State: target URL, cookie jar, HTTP client, proxy log ring buffer |
| `WebPreviewEndpoints.cs` | REST API: target CRUD, cookie management, proxy log, snapshots |
| `MtcliScriptWriter.cs` | CLI helpers: `mt_proxylog`, `mt_navigate`, etc. |

## Key Design Decisions

**No read-side spoofing.** Chrome blocks overriding `Location.prototype` properties. Partial spoofing creates fatal inconsistencies. Let all URLs consistently include `/webpreview/`.

**No WebSocket content rewriting.** Frameworks use relative paths for routing. The absolute origin in URLs doesn't matter as long as `baseUri` and `currentUri` share the same origin. Relaying messages untouched eliminates an entire class of bugs (JSON corruption, MessagePack header mismatch, VarInt framing errors).

**Write-side interception is sufficient.** Outgoing APIs (fetch, XHR, WebSocket, history, element setters) are patched to add `/webpreview` before requests leave JS. This ensures all requests route through the proxy middleware.
