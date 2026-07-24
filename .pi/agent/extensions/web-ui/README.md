# Pi Web UI

A session-scoped browser companion for one running Pi process. It starts only in TUI or RPC mode, follows Pi session replacement, and is not a daemon or process manager.

## Local use

1. Install/build once from this directory with `nub install` (the package lifecycle builds `dist/web`).
2. Start Pi normally.
3. Pi announces a loopback URL. Run `/copy-remote-url` to copy a short-lived, directly usable authenticated link.
4. Open the link in a browser. The fragment credential is exchanged once and removed from browser history.

The default listener is `127.0.0.1` on an ephemeral port. Browser actions have the same shell and filesystem authority as the Pi process.

## Configuration

All runtime settings are read once into the validated server configuration:

- `PI_WEB_UI_HOST` — bind address (default `127.0.0.1`).
- `PI_WEB_UI_PORT` — listener port, including `0` for ephemeral (default).
- `PI_WEB_UI_PUBLIC_URL` — browser-visible HTTP(S) URL, including an optional base path such as `https://machine.example/_pi/s/id/`.
- `PI_WEB_UI_BASE_PATH` — explicit base path; when a public URL is set, both paths must match.
- `PI_WEB_UI_ALLOWED_ORIGINS` — comma-separated exact HTTP(S) origins. Wildcards are rejected.

`PI_WEB_UI_REMOTE_URL` remains an alias for `PI_WEB_UI_PUBLIC_URL`.

The listener ignores proxy and Tailscale identity headers. Configuring a public URL does not make a proxy trusted and does not change authentication.

## Tailscale Serve

Keep Pi bound to loopback and use a fixed port so the proxy target survives Pi restarts. Determine the machine's Tailscale HTTPS URL first, then configure Serve and start Pi with matching settings:

```sh
export PI_WEB_UI_PORT=43123
export PI_WEB_UI_PUBLIC_URL=https://machine.example.ts.net/
tailscale serve --bg http://127.0.0.1:43123
pi
```

The public URL must be configured before Pi starts so startup discovery, exact Origin validation, secure path-scoped cookies, WebSocket `wss:` derivation, and `/copy-remote-url` all use the browser-visible address. Consult the installed Tailscale version's `tailscale serve --help` because CLI syntax can vary.

Do not expose this extension directly to the public internet. Tailscale network identity reduces exposure but does not replace the extension's per-run authorization.

## Lifecycle and limitations

- `/reload`, `/new`, `/resume`, `/fork`, and `/clone` close the old server and create a fresh generation. A standalone replacement generation requires a newly copied bootstrap link.
- Transient disconnects within one generation reconnect with bounded backoff and resnapshot.
- Arbitrary Pi extension dialogs are not bridged to the browser. Questionnaire results render in the timeline, but answering a TUI questionnaire from the browser is out of scope.
- A future machine daemon may reverse-proxy this extension at a stable base path. This package deliberately does not spawn Pi, choose working directories, discover machines, trust proxy headers, or manage daemon readiness.
