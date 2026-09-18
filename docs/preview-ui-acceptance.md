# Integrated app preview browser fixture

Run `taskset -c 0,1 nice -n 10 node scripts/smoke-preview-ui-mcp.mjs` with the installed official Playwright MCP and Chrome. This starts only disposable loopback services and browser state. It does not accept a production origin, cookie file, account credential or AWS target.

The fixture uses the real Relay UI, Google/Auth.js session handling, chat APIs, AppPreviews, PreviewBootstrap, HTTP/WebSocket proxy, framed TCP bridge and unchanged SSH worker launcher. The Google provider is a signed synthetic OIDC fixture; the saved CloudFront registry is an in-memory stand-in; an isolated local child process stands in for EC2's SSH connection. TLS and two distinct browser sites exercise real browser cookies/CORS and the trusted launch page. All destinations are locally mapped; the sole Google navigation is fulfilled by the fixture provider, not sent to Google.

Assertions cover:

- Google login UI and real signed fixture callback; chat creation without a prompt.
- Explicit port/path setup, pending status, ready status, and no worker acquisition or launch minting during setup/polling.
- Real **Open app** click, detached/no-referrer popup, exact app pathname/query/fragment.
- HTTP app content, a WebSocket echo and incremental SSE through the real proxy/bridge.
- Application-only upstream cookies; no Relay session/preview grant or authorization header reaches the fixture app.
- UI revocation closes both live streams, rejects subsequent app requests and leaves no transcript/model messages.
- Exact locally spawned launcher children and browser transport are observed closed before successful cleanup is reported.

Only fixed booleans and the current phase on failure are printed. Screenshots under ignored `test-results/preview-ui-integrated-mcp/` show synthetic identities and app content, not browser cookies or launch URLs. On unconfirmed cleanup the private temporary fixture directory is retained and the script fails.

Passing this fixture is an integrated local product-flow result, **not** real Google consent, CloudFront provisioning, EC2 isolation or a deployed AWS preview acceptance claim. Those gates require separate execution against the deployed system.
