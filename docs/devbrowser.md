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

The injected script sends `postMessage({type: "mt-navigation", url: location.href})` to the parent window whenever in-iframe navigation occurs:

- `history.pushState` / `history.replaceState` — SPA navigation
- `popstate` / `hashchange` events — back/forward navigation
- Initial page load (`setTimeout(ntfy, 0)`) — captures redirects

The parent `webPanel.ts` listens for these messages and updates the URL bar, stripping the `/webpreview` prefix and reconstructing the upstream URL.

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
| CSS/JS 404s | Root-relative URLs not caught by `IsMidTermPath` catch-all |
| Login redirect loops | Cookies not forwarding — check `requestCookies`/`responseCookies` in proxylog |

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
