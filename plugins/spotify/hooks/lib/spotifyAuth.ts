// Pure PKCE/URL helpers only — nothing here touches `$`. The actual browser-open and token-fetch
// calls live in register.tsx. `crypto`, `atob`/`btoa`, `TextEncoder` and `URL` are runtime
// globals, not the `$` API, so they're fine to use here.

// a loopback redirect URI never needs a real listener for Spotify's side of things (it allows an
// unregistered one, and the code lands in the address bar regardless) — but catching it
// automatically instead of asking for a copy-paste does need something briefly listening there
export const CALLBACK_PORT = 8907;
export const REDIRECT_URI = `http://127.0.0.1:${CALLBACK_PORT}/callback`;

// there's no shared Client ID: a Spotify app in Development Mode only answers the Web API for
// its owner and up to 5 registered users, so a shared one could never serve everyone. Each person
// brings their own app's ID (`/spotify config <id>`); as its owner they're let in automatically.
// Spotify Client IDs are 32 hex characters
export function isClientId(value: string): boolean {
  return /^[0-9a-f]{32}$/i.test(value);
}

export const SCOPES = [
  'user-read-playback-state',
  'user-modify-playback-state',
  'user-read-currently-playing',
  'playlist-read-private',
  'playlist-read-collaborative',
  'user-library-read', // Liked Songs — reading only, there's no "like" button anymore
].join(' ');

function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function randomVerifier(): string {
  const bytes = new Uint8Array(64);
  crypto.getRandomValues(bytes);
  return base64url(bytes);
}

export function randomState(): string {
  return crypto.randomUUID();
}

export async function challengeFor(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

export function authUrl(clientId: string, challenge: string, state: string): string {
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: REDIRECT_URI,
    code_challenge_method: 'S256',
    code_challenge: challenge,
    scope: SCOPES,
    state,
  });
  return `https://accounts.spotify.com/authorize?${params.toString()}`;
}

// accepts either the full redirected URL (the normal case — pasted straight from the address
// bar) or a bare authorization code, so a fumbled copy still works
export function extractCode(pasted: string, expectedState: string): string {
  const trimmed = pasted.trim();
  if (!trimmed.includes('://')) {
    if (!trimmed) throw new Error('nothing pasted');
    return trimmed;
  }

  const url = new URL(trimmed);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const error = url.searchParams.get('error');
  if (error) throw new Error(`Spotify denied the request: ${error}`);
  if (!code) throw new Error('that URL has no "code" in it — paste the one from right after you clicked Agree');
  if (state !== expectedState) throw new Error('that code is from an older /spotify login — run login again and paste the newest one');
  return code;
}

// where the one-shot local listener (below) drops what it caught, and the script that runs it —
// state-scoped so a stale file from an earlier, abandoned login is never mistaken for this one
export function callbackFilePath(state: string): string {
  return `/tmp/spotify-mod-callback-${state}.json`;
}

export function serverScriptFilePath(state: string): string {
  return `/tmp/spotify-mod-server-${state}.py`;
}

// a short-lived HTTP server: takes the redirect Spotify sends, writes its code/state/error to
// CALLBACK_FILE as JSON, answers the browser with a page saying to come back, and stops —
// python3 is reliably preinstalled on macOS, so this needs no compiled helper. `$` has no
// long-lived-process primitive (`process.run` is one-shot, resolves only once its child exits),
// so this is spawned backgrounded (`nohup ... & disown`) from a shell that itself exits right
// away, and the hooks module polls for the file it wrote on the ticker's existing once-a-second
// tick instead of waiting on the listener directly.
//
// It loops `handle_request()` rather than answering exactly once: a single-shot server that
// exits after the very first connection is gone by the time the real OAuth redirect lands if
// anything else reaches the port first (a browser's speculative preconnect, a stray favicon
// fetch) — which reads to the person as the page hanging ("took too long to respond"), not an
// instant, expected "can't reach this page". Requests that aren't the real callback are answered
// (so nothing hangs) but don't stop the loop; only one carrying `code` or `error` does. The file
// write is wrapped so a failure there (e.g. a sandboxed environment that can't write to /tmp)
// still can't prevent the HTTP response from going out.
export function loopbackServerScript(state: string): string {
  const filePath = callbackFilePath(state);
  return [
    'import http.server, json, time, urllib.parse',
    `PATH = ${JSON.stringify(filePath)}`,
    'def page(ok):',
    '    if ok:',
    "        icon, title, sub = '\\u2713', 'Connected to Claude Code', 'You can close this tab now.'",
    '    else:',
    "        icon, title, sub = '\\u2715', 'Connection failed', 'Go back to Claude Code and try again.'",
    "    return ('<!doctype html><html><head><meta charset=\"utf-8\"><title>' + title + '</title><style>'"
      + " 'body{background:#121212;color:#fff;font-family:-apple-system,BlinkMacSystemFont,\"Segoe UI\",sans-serif;'"
      + " 'display:flex;align-items:center;justify-content:center;height:100vh;margin:0}'"
      + " '.card{text-align:center}'"
      + " '.icon{width:56px;height:56px;border-radius:50%;display:flex;align-items:center;justify-content:center;'"
      + " 'margin:0 auto 20px;font-size:26px;font-weight:bold}'"
      + " '.icon.ok{background:#1db954;color:#000}' '.icon.err{background:#e22134;color:#fff}'"
      + " 'h1{font-size:18px;font-weight:600;margin:0 0 6px}' 'p{color:#b3b3b3;font-size:13px;margin:0}'"
      + " '</style></head><body><div class=\"card\"><div class=\"icon ' + ('ok' if ok else 'err') + '\">'"
      + " + icon + '</div><h1>' + title + '</h1><p>' + sub + '</p></div>'"
      + " '<script>setTimeout(function(){window.close()},1500)</script></body></html>')",
    'class H(http.server.BaseHTTPRequestHandler):',
    '    def do_GET(self):',
    '        q = urllib.parse.urlparse(self.path)',
    '        p = urllib.parse.parse_qs(q.query)',
    "        code = p.get('code', [''])[0]",
    "        state = p.get('state', [''])[0]",
    "        error = p.get('error', [''])[0]",
    '        is_callback = bool(code or error)',
    '        self.send_response(200)',
    "        self.send_header('Content-Type', 'text/html')",
    '        self.end_headers()',
    "        self.wfile.write(page(bool(code)).encode('utf-8') if is_callback else b'')",
    '        if is_callback:',
    '            try:',
    "                open(PATH, 'w').write(json.dumps({'code': code, 'state': state, 'error': error}))",
    '            except Exception:',
    '                pass',
    '            self.server.got_it = True',
    '    def log_message(self, *a):',
    '        pass',
    `srv = http.server.HTTPServer(('127.0.0.1', ${CALLBACK_PORT}), H)`,
    'srv.got_it = False',
    'deadline = time.time() + 180',
    'while not srv.got_it and time.time() < deadline:',
    '    srv.timeout = max(1, deadline - time.time())',
    '    srv.handle_request()',
    'srv.server_close()',
  ].join('\n');
}
