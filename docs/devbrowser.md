# Web Preview Dev Browser — WebSocket Proxy Design

The web preview reverse proxy (`/webpreview/*`) intercepts browser requests and forwards them to an upstream target. This works transparently for HTTP, but WebSocket connections require careful URL rewriting because the proxied page lives under `/webpreview/` while the upstream server doesn't know about that prefix.

## URL Space Design (No Read-Side Spoofing)

The proxy uses a **write-only interception** strategy: the injected `UrlRewriteScript` patches outgoing APIs (`fetch`, `XHR`, `WebSocket`, `history.pushState`, `location.assign`, element `.src`/`.href` setters, `setAttribute`) to add `/webpreview` to URLs before they leave JavaScript. But it does **NOT** spoof read-side APIs (`location.href`, `location.pathname`, `document.URL`, `document.baseURI`).

| Layer | URL the code sees | Example |
|-------|-------------------|---------|
| **Browser (real)** | `https://proxy:2000/webpreview/page` | Kestrel routes through middleware |
| **JavaScript (real)** | `https://proxy:2000/webpreview/page` | `location.pathname` returns `/webpreview/page` |
| **Upstream (actual)** | `https://upstream.example.com/page` | What the real server knows |

The `<base href="/webpreview/">` tag is injected into every HTML response. This means:
- `document.baseURI` = `https://proxy:2000/webpreview/` (from `<base>` tag, real value)
- `location.href` = `https://proxy:2000/webpreview/page` (real browser URL)
- Both are consistent — frameworks see the app mounted at `/webpreview/`

### Why No Read-Side Spoofing?

Chrome's `Location.prototype` properties have `configurable: false`. Attempting `Object.defineProperty(location, "href", ...)` silently fails. This means `location.href` and `location.pathname` **cannot be spoofed** on Chrome. But `document.baseURI`, `document.URL`, and `HTMLBaseElement.href` **can** be overridden. This inconsistency is fatal for frameworks like Blazor that compare `location.href` against `document.baseURI` — they see mismatched URL spaces and fail to route.

The solution: don't spoof anything on the read side. Let all URLs consistently include `/webpreview/`. The write-side interceptors ensure outgoing requests go through the proxy correctly.

## WebSocket URL Rewriting

### Direction: Client → Upstream

JavaScript constructs URLs from `document.baseURI` or `location.href`, both of which include `/webpreview/`. Two-pass replacement strips the proxy prefix:

```
Pass 1: https://proxy:2000/webpreview  →  https://upstream.example.com
Pass 2: https://proxy:2000             →  https://upstream.example.com
```

Pass 1 catches the common case (URLs containing `/webpreview` from the page's URL space). Pass 2 catches edge cases where only the bare origin appears (e.g., a hardcoded origin string).

### Direction: Upstream → Client

The upstream sends its own URLs. These must become proxy URLs **with `/webpreview`** to match the page's URL space:

```
https://upstream.example.com  →  https://proxy:2000/webpreview
```

This ensures that framework state (e.g., Blazor's `NavigationManager.currentUri`) stays consistent with `document.baseURI` and `location.href`.

## SignalR Protocol Variants

### JSON Hub Protocol (Blazor Web / .NET 8+)

- Sub-protocol: none (no `Sec-WebSocket-Protocol` header)
- Messages: text WebSocket frames, JSON with `\x1e` record separator
- URL rewriting: simple `string.Replace()` on the text content
- Example message:
  ```
  {"type":1,"target":"StartCircuit","arguments":["https://proxy:2000/webpreview/","https://proxy:2000/webpreview/?ts"]}\x1e
  ```

### blazorpack (Blazor Server / .NET 7 and earlier)

- Sub-protocol: `blazorpack`
- Messages: binary WebSocket frames
- Framing: `[VarInt: payload_length][MessagePack payload]` (one or more per frame)
- URLs embedded as MessagePack strings with length-prefixed headers:
  - fixstr (`0xa0-0xbf`): up to 31 bytes
  - str8 (`0xd9 XX`): up to 255 bytes
  - str16 (`0xda XX XX`): up to 65535 bytes

**The VarInt bug:** URL replacement changes the MessagePack payload size, but the VarInt length prefix at the start of each message wasn't updated. The upstream read the old VarInt, sliced the wrong number of bytes, and deserialization failed — closing the connection with "Server returned an error on close."

**Fix:** `RewriteSignalRBinaryFrame` parses the VarInt framing, applies `RewriteBinaryUrls` to each individual payload, then re-encodes with the correct VarInt length. Only activates when `SubProtocol == "blazorpack"`.

### Plain WebSocket (non-SignalR)

- Text frames: `string.Replace()` (same as JSON hub)
- Binary frames: `RewriteBinaryUrls` scans for URL byte patterns, adjusts MessagePack string headers
- No VarInt framing — binary bytes are processed directly

## Proxy Log

`GET /api/webpreview/proxylog?limit=N` returns the last N proxy requests (default 100) with full details:

- Request/response headers, cookies
- Upstream URL, status code, duration
- WebSocket sub-protocols, negotiated protocol
- Error messages on failure

CLI: `mt_proxylog [limit]` / `Mt-ProxyLog [-Limit N]`

Use this as the **first diagnostic step** when a site doesn't work through the proxy. The log shows exactly what requests the proxy made, what the upstream returned, and whether WebSocket connections succeeded.

## Debugging Checklist

When a website doesn't load through the web preview:

1. **`mt_proxylog`** — Check if requests reach upstream and what status codes come back
2. **`mt_log error`** — Check browser console for JS errors
3. **`mt_outline`** — Check if the page has any rendered content
4. **WebSocket entries in proxylog** — Check `statusCode` (101 = connected, 502 = failed), `subProtocols`, `negotiatedProtocol`, `error`
5. **`mt_exec` to inspect framework state** — e.g., `Blazor._internal.navigationManager` for baseUri/currentUri mismatch

### Common Failures

| Symptom | Likely Cause |
|---------|-------------|
| WS status 502 | Upstream rejected connection (wrong Origin, missing cookies, SSL error) |
| WS 101 but page empty | URL rewriting mismatch — check NavigationManager or framework router state |
| WS 101 then immediate close (1006) | Binary message corruption — check if VarInt framing applies |
| Page renders but navigation broken | URL inconsistency between location.href and document.baseURI |
| CSS/JS 404s | Root-relative URLs not caught by `IsMidTermPath` catch-all |
| Login redirect loops | Cookies not forwarding — check `requestCookies`/`responseCookies` in proxylog |

## Implementation Files

| File | Role |
|------|------|
| `WebPreviewProxyMiddleware.cs` | Core proxy: HTTP forwarding, WebSocket relay, URL rewriting, injected JS |
| `WebPreviewService.cs` | State: target URL, cookie jar, HTTP client, proxy log ring buffer |
| `WebPreviewEndpoints.cs` | REST API: target CRUD, cookie management, proxy log, snapshots |
| `MtcliScriptWriter.cs` | CLI helpers: `mt_proxylog`, `mt_navigate`, etc. |

## Key Design Decisions

**No read-side spoofing.** Chrome's `Location.prototype` properties are non-configurable, making it impossible to consistently spoof `location.href` and `location.pathname`. Rather than partially spoofing (which creates fatal inconsistencies for frameworks like Blazor), we let all URLs consistently include `/webpreview/`. The `<base href="/webpreview/">` tag makes this work for relative URL resolution.

**Write-side interception is sufficient.** Outgoing APIs (fetch, XHR, WebSocket, history, element setters) are patched to add `/webpreview` before requests leave JS. This ensures all requests route through the proxy middleware. The read-side consistency means framework routers see a coherent URL space.

**Two-pass client→upstream, single-pass upstream→client.** Client messages may contain URLs both with and without `/webpreview` (depending on the API that generated them). The longer match (`/webpreview`) is tried first to avoid partial replacements. Upstream messages consistently use the upstream's own origin, so one pass suffices.

**VarInt framing is protocol-specific.** Only `blazorpack` uses VarInt-prefixed messages within WebSocket frames. Other protocols get raw byte matching. Detecting by `SubProtocol` avoids false-positive framing on arbitrary binary data.

**The proxy log exists because WebSocket debugging is blind.** You can't see WebSocket message contents in browser DevTools when you're inside a proxied iframe. The server-side log captures the HTTP and WebSocket metadata that the proxy generates, which is the only way to diagnose connection failures.
