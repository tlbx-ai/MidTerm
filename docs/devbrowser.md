# Web Preview Dev Browser — WebSocket Proxy Design

The web preview reverse proxy (`/webpreview/*`) intercepts browser requests and forwards them to an upstream target. This works transparently for HTTP, but WebSocket connections require careful URL rewriting because the proxied page's JavaScript environment sees a **spoofed** location that differs from the actual browser URL.

## The Two-World Problem

The proxy maintains two parallel realities:

| Layer | URL the code sees | Example |
|-------|-------------------|---------|
| **Browser (real)** | `https://proxy:2000/webpreview/page` | Kestrel routes through middleware |
| **JavaScript (spoofed)** | `https://proxy:2000/page` | `location.pathname` returns `/page` |
| **Upstream (actual)** | `https://upstream.example.com/page` | What the real server knows |

The injected `UrlRewriteScript` patches `location.*`, `document.URL`, `document.baseURI`, `fetch`, `XHR`, `WebSocket`, `history.*`, etc. — all stripping `/webpreview` on read and adding it on write. This means **JavaScript frameworks never see `/webpreview`** in any URL.

HTTP requests are straightforward: the middleware strips `/webpreview`, forwards to upstream, and returns the response. But WebSocket messages carry URLs as **data** — inside JSON payloads, MessagePack binary, SignalR invocations — and these must be rewritten to maintain consistency.

## WebSocket URL Rewriting

### Direction: Client → Upstream

The browser's JS sends URLs using the **spoofed origin** (no `/webpreview`). The upstream expects its **own origin**. Two-pass replacement handles both cases:

```
Pass 1: https://proxy:2000/webpreview  →  https://upstream.example.com
Pass 2: https://proxy:2000             →  https://upstream.example.com
```

Pass 1 catches URLs that leaked through without spoofing (e.g., from `getAttribute("href")` on a rewritten element). Pass 2 catches the common case where frameworks construct URLs from the spoofed `location`/`document.baseURI`.

### Direction: Upstream → Client

The upstream sends its own URLs. These must become the **spoofed proxy origin** (bare, no `/webpreview`):

```
https://upstream.example.com  →  https://proxy:2000
```

**NOT** `https://proxy:2000/webpreview` — that would be inconsistent with what JS sees. The fetch/XHR/WebSocket interceptors will add `/webpreview` when the client actually makes requests.

### Why Not `/webpreview` in Upstream→Client?

This was the Blazor rendering bug. Blazor's `NavigationManager` compares `baseUri` (from `document.baseURI`, spoofed to `https://proxy:2000/`) against `currentUri` (from a server-sent WebSocket message). If `currentUri` was rewritten to `https://proxy:2000/webpreview/?query`, the relative path becomes `webpreview/?query` — a route that doesn't exist. Nothing renders.

## SignalR Protocol Variants

### JSON Hub Protocol (Blazor Web / .NET 8+)

- Sub-protocol: none (no `Sec-WebSocket-Protocol` header)
- Messages: text WebSocket frames, JSON with `\x1e` record separator
- URL rewriting: simple `string.Replace()` on the text content
- Example message:
  ```
  {"type":1,"target":"StartCircuit","arguments":["https://proxy:2000/","https://proxy:2000/?ts"]}\x1e
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
| Page renders but navigation broken | Upstream→client rewriting putting `/webpreview` in URLs that JS reads |
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

**Location spoofing is all-or-nothing.** Once we override `location.pathname` to strip `/webpreview`, every layer must be consistent. HTTP requests go through fetch/XHR interceptors that add the prefix back. WebSocket messages must use the bare origin. Any leak of `/webpreview` into JS-visible URLs breaks framework routers.

**Two-pass client→upstream, single-pass upstream→client.** Client messages may contain URLs both with and without `/webpreview` (depending on whether they came from a DOM attribute vs. `location.href`). Upstream messages are consistent — always the upstream's own origin — so one pass suffices.

**VarInt framing is protocol-specific.** Only `blazorpack` uses VarInt-prefixed messages within WebSocket frames. Other protocols get raw byte matching. Detecting by `SubProtocol` avoids false-positive framing on arbitrary binary data.

**The proxy log exists because WebSocket debugging is blind.** You can't see WebSocket message contents in browser DevTools when you're inside a proxied iframe. The server-side log captures the HTTP and WebSocket metadata that the proxy generates, which is the only way to diagnose connection failures.
