# Communication security

tlbx requires HTTPS and authentication for its control API, WebSockets, files,
terminal sessions, configuration, diagnostics, and API documentation. A missing
password locks control access. The legacy `authenticationEnabled: false` setting
does not disable this boundary, including on loopback.

Before entering a password, obtain the host certificate's SHA-256 fingerprint
directly on the host with `mt --fingerprint`, or from its administrator through
an independently trusted channel. Compare it with the certificate actually
presented in the browser's certificate viewer. The login and trust pages display
the complete fingerprint with a copy control, but page content alone cannot
authenticate the server: an impersonator could also replace that content.
For a private certificate, verify it before adding it to a device's trust store.
The native connectors use platform certificate validation.

The unauthenticated API exceptions are deliberately narrow:

- `POST /api/auth/login` exchanges a password for a secure, HttpOnly session cookie.
- `POST /api/share/claim` exchanges an owner-issued share secret for scoped access.
- `GET` and `HEAD` on `/api/bootstrap/login`, `/api/certificate/info`, and the
  PEM, CRT, and mobileconfig certificate downloads support verification before login.

Static login/trust assets are also public. Health, version, paths, security status,
certificate management, and other authentication endpoints require credentials.
Deleting an API key closes its existing WebSocket connections, including connections
being authenticated during revocation. Session cookies and owner-issued API keys grant owner access; share and browser
preview credentials grant only their explicit scope. Preview route names and
Referer headers are not credentials. tlbx authentication headers and cookies must
not be forwarded to preview applications.

New passwords must contain 15–1024 characters. Password hashing uses PBKDF2-HMAC-
SHA256 with 600,000 iterations; successful legacy logins upgrade older work factors.
Failed password attempts accumulate across checks, with temporary lockouts.
Password operations are serialized to bound concurrent hashing work. Browser
mutations and WebSocket handshakes require the same origin; non-browser API clients
can authenticate without an Origin header.

For local recovery, run `mt --set-password` under the service's identity and
settings directory, then restart the instance. Do not disable authentication.
Hub connections require HTTPS and validate the configured certificate pin or the
platform trust chain before sending credentials. They do not follow redirects.

Regression coverage includes the generated API inventory plus source-registered
routes through the actual authentication middleware, preview scope boundaries,
password throttling, hostile origins, and HTTPS Hub servers proving that invalid
certificates and redirects do not receive forwarded credentials.
