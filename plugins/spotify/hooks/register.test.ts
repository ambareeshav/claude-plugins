import { test, expect } from 'claude-code/testing';
import { register } from './register';
import { callbackFilePath, loopbackServerScript, serverScriptFilePath } from './lib/spotifyAuth';

const SEP = '\x1f';
const TRACK_ID = '3E7dfMvvCLjXCzDXf1a4ma';
const PLAYING_OUTPUT = [TRACK_ID, 'Midnight City', 'M83', 'Hurry Up, We\'re Dreaming', '243000', '61', 'playing', '55'].join(SEP);

function installMocks(on: any, opts: { running?: boolean; playCalls?: string[]; positions?: string[] } = {}) {
  const running = opts.running ?? true;
  const calls = opts.playCalls ?? [];
  const positions = opts.positions;
  let statusCalls = 0;

  on('process.run', async ($: any, e: any) => {
    const [cmd, ...rest] = e.argv as string[];
    if (cmd === 'osascript') {
      const script = rest[rest.length - 1] as string;
      calls.push(script);
      if (script.includes('isRunning')) {
        if (!running) return { value: { exitCode: 0, stdout: 'not running', stderr: '' } };
        const pos = positions ? positions[Math.min(statusCalls, positions.length - 1)] : '61';
        statusCalls++;
        const fields = [TRACK_ID, 'Midnight City', 'M83', "Hurry Up, We're Dreaming", '243000', pos, 'playing', '55'];
        return { value: { exitCode: 0, stdout: fields.join(SEP), stderr: '' } };
      }
      if (script.includes('artwork url')) {
        return { value: { exitCode: 0, stdout: 'https://i.scdn.co/image/abc\n', stderr: '' } };
      }
      if (script.includes('sound volume') && !script.includes('set sound volume')) {
        return { value: { exitCode: 0, stdout: '55', stderr: '' } };
      }
      return { value: { exitCode: 0, stdout: '', stderr: '' } };
    }
    if (cmd === 'open') {
      calls.push(e.argv.join(' '));
      return { value: { exitCode: 0, stdout: '', stderr: '' } };
    }
    if (cmd === '/bin/sh' || cmd === 'rm') {
      calls.push(e.argv.join(' '));
      return { value: { exitCode: 0, stdout: '', stderr: '' } };
    }
    return { value: { exitCode: 1, stdout: '', stderr: `unmocked argv: ${e.argv.join(' ')}` } };
  });

  // stands in for the engine's own AbovePrompt content: the band composes in a row with
  // whatever else draws there, so its render hook always calls next(e)
  on('ui.render', { component: 'AbovePrompt' }, async () => ({ type: 'Text', props: {}, children: [] }));
}

const BAND_PROPS = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 10,
  bodyColumns: 60,
  scroll: { offset: 0, bodyRows: 8 },
  view: {},
};

const PANE_PROPS = {
  title: 'Spotify',
  isFocused: true,
  bodyColumns: 60,
  placement: 'inline' as const,
  scroll: { offset: 0, bodyRows: 20 },
  view: {},
};

// a Client ID is set unless a test says otherwise — it's the person's own, from /spotify config
function installStoreMocks(on: any, opts: { initialToken?: unknown; clientId?: string | null } = {}) {
  let token = opts.initialToken ?? undefined;
  let clientId: unknown = opts.clientId === undefined ? 'test-client-id' : opts.clientId ?? undefined;
  on('store.get', async ($: any, e: any) => ({
    value: e.key === 'spotify:tokens' ? token : e.key === 'spotify:clientId' ? clientId : undefined,
  }));
  on('store.set', async ($: any, e: any) => {
    if (e.key === 'spotify:tokens') token = e.value;
    if (e.key === 'spotify:clientId') clientId = e.value;
    return { value: undefined };
  });
  on('ui.open', async () => ({ value: undefined }));
}

function installWebApiMocks(on: any, opts: { apiCalls?: string[]; bodies?: string[] } = {}) {
  const calls = opts.apiCalls ?? [];
  on('http.fetch', async ($: any, e: any) => {
    const url = e.url as string;
    calls.push(`${e.init?.method ?? 'GET'} ${url}`);
    opts.bodies?.push(e.init?.body ?? '');

    if (url.startsWith('https://accounts.spotify.com/api/token')) {
      return {
        value: {
          status: 200,
          ok: true,
          headers: {},
          text: JSON.stringify({ access_token: 'access-1', refresh_token: 'refresh-1', expires_in: 3600 }),
        },
      };
    }
    if (url.endsWith('/v1/me')) {
      return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ id: 'my-id' }) } };
    }
    if (url.includes('/me/playlists')) {
      return {
        value: {
          status: 200,
          ok: true,
          headers: {},
          text: JSON.stringify({
            items: [
              { id: 'pl1', name: 'Focus', owner: { id: 'my-id' } },
              { id: 'pl2', name: 'Friend\'s Mix', owner: { id: 'someone-else' } },
            ],
          }),
        },
      };
    }
    if (url.includes('/playlists/pl1/items')) {
      return {
        value: {
          status: 200,
          ok: true,
          headers: {},
          text: JSON.stringify({
            // `item`, not the deprecated `track` field — this is the current shape
            items: [{ item: { uri: 'spotify:track:aaa', name: 'Song A', artists: [{ name: 'Artist A' }] } }],
          }),
        },
      };
    }
    if (url.includes('/me/tracks?limit=50')) {
      return {
        value: {
          status: 200,
          ok: true,
          headers: {},
          text: JSON.stringify({ items: [{ track: { uri: 'spotify:track:bbb', name: 'Song B', artists: [{ name: 'Artist B' }] } }] }),
        },
      };
    }
    if (url.includes('/v1/search?')) {
      return {
        value: {
          status: 200,
          ok: true,
          headers: {},
          text: JSON.stringify({
            tracks: { items: [{ uri: 'spotify:track:sss', name: 'Found Song', artists: [{ name: 'Found Artist' }] }, null] },
            albums: { items: [{ id: 'alb', uri: 'spotify:album:alb', name: 'Found Album', artists: [{ name: 'Found Artist' }] }] },
            artists: { items: [{ id: 'art', uri: 'spotify:artist:art', name: 'Found Artist' }] },
            playlists: {
              items: [
                null,
                { id: 'pl1', uri: 'spotify:playlist:pl1', name: 'Mine Found', owner: { id: 'my-id' } },
                { id: 'pl9', uri: 'spotify:playlist:pl9', name: 'Theirs Found', owner: { id: 'someone-else' } },
              ],
            },
          }),
        },
      };
    }
    if (url.includes('/albums/alb/tracks')) {
      return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ items: [{ uri: 'spotify:track:t1', name: 'Album Cut', artists: [{ name: 'Found Artist' }] }] }) } };
    }
    if (url.includes('/artists/art/albums')) {
      return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ items: [{ id: 'alb', uri: 'spotify:album:alb', name: 'Found Album', artists: [{ name: 'Found Artist' }] }] }) } };
    }
    if (url.includes('/me/player/shuffle')) {
      return { value: { status: 204, ok: true, headers: {}, text: '' } };
    }
    if (url.includes('/me/player/play')) {
      return { value: { status: 204, ok: true, headers: {}, text: '' } };
    }
    return { value: { status: 404, ok: false, headers: {}, text: `unmocked url: ${url}` } };
  });
}

test('bare /spotify reports the band is open', async ($: any, on: any) => {
  register(on, {});
  installMocks(on);

  const result = await $.command.run({ command: 'spotify', args: '' });
  expect(result.text).toContain('Spotify');
});

test('the band shows the current track when Spotify is running', async ($: any, on: any) => {
  register(on, {});
  installMocks(on);

  await $.command.run({ command: 'spotify', args: '' });

  const ui = await $.ui.mount({ plugin: 'spotify', surface: 'terminal', component: 'AbovePrompt', requestId: 'spotify', props: BAND_PROPS });
  expect(await ui.find({ text: /Midnight City/ })).toBeDefined();
  expect(await ui.find({ text: /M83/ })).toBeDefined();
  expect(await ui.find({ text: '⏸' })).toBeDefined();
  await ui.unmount();
});

test('every control button is present and pressable, not clipped out of the row', async ($: any, on: any) => {
  register(on, {});
  const calls: string[] = [];
  installMocks(on, { playCalls: calls });

  await $.command.run({ command: 'spotify', args: '' });
  const ui = await $.ui.mount({ plugin: 'spotify', surface: 'terminal', component: 'AbovePrompt', requestId: 'spotify', props: BAND_PROPS });

  for (const text of [/✕/, /◫/, /⌄/, /⏮/, /⏸/, /⏭/, /🔇/]) {
    expect(await ui.find({ text })).toBeDefined();
  }

  await ui.press({ key: 'next' });
  expect(calls.some(s => s.includes('next track'))).toBe(true);

  await ui.press({ key: 'mute' });
  expect(calls.some(s => s.includes('set sound volume to 0'))).toBe(true);

  await ui.unmount();
});

test('the band offers to open Spotify when it is not running', async ($: any, on: any) => {
  register(on, {});
  installMocks(on, { running: false });

  await $.command.run({ command: 'spotify', args: '' });

  const ui = await $.ui.mount({ plugin: 'spotify', surface: 'terminal', component: 'AbovePrompt', requestId: 'spotify', props: BAND_PROPS });
  expect(await ui.find({ text: /isn't running/ })).toBeDefined();
  expect(await ui.find({ text: /open Spotify/ })).toBeDefined();
  await ui.unmount();
});

test('pressing play-pause runs playpause and refreshes the band', async ($: any, on: any) => {
  register(on, {});
  const calls: string[] = [];
  installMocks(on, { playCalls: calls });

  await $.command.run({ command: 'spotify', args: '' });
  const ui = await $.ui.mount({ plugin: 'spotify', surface: 'terminal', component: 'AbovePrompt', requestId: 'spotify', props: BAND_PROPS });

  await ui.press({ key: 'playpause' });
  expect(calls.some(s => s.includes('playpause'))).toBe(true);
  expect(await ui.find({ text: /Midnight City/ })).toBeDefined();

  await ui.unmount();
});

test('the compact toggle collapses the band to one line, and back', async ($: any, on: any) => {
  register(on, {});
  installMocks(on);

  await $.command.run({ command: 'spotify', args: '' });
  const ui = await $.ui.mount({ plugin: 'spotify', surface: 'terminal', component: 'AbovePrompt', requestId: 'spotify', props: BAND_PROPS });

  // expanded: the full three-line layout, "collapse" (⌄) offered
  expect(await ui.find({ text: /Midnight City/ })).toBeDefined();
  expect(await ui.find({ text: '⌄' })).toBeDefined();

  await ui.press({ key: 'spotify:compact' });

  // collapsed: everything on one row, separated by │, "expand" (⌃) offered now
  expect(await ui.find({ text: /Midnight City — M83/ })).toBeDefined();
  expect(await ui.find({ text: /1:01\/4:03/ })).toBeDefined();
  expect(await ui.find({ text: '⌃' })).toBeDefined();
  expect(await ui.find({ text: '⌄' })).toBeUndefined();

  await ui.press({ key: 'spotify:compact' });
  expect(await ui.find({ text: '⌄' })).toBeDefined();

  await ui.unmount();
});

test('the ticker client posts a tick every second, refreshing the position without a button press', async ($: any, on: any) => {
  register(on, {});
  installMocks(on, { positions: ['10', '20', '30'] });

  await $.command.run({ command: 'spotify', args: '' });
  const ui = await $.ui.mount({ plugin: 'spotify', surface: 'terminal', component: 'AbovePrompt', requestId: 'spotify', props: BAND_PROPS });

  expect(await ui.find({ text: /0:10/ })).toBeDefined();
  await ui.advance(1000);
  expect(await ui.find({ text: /0:20/ })).toBeDefined();
  await ui.advance(1000);
  expect(await ui.find({ text: /0:30/ })).toBeDefined();

  await ui.unmount();
});

test('with no Client ID, the sidebar shows setup steps; /spotify config saves one and enables connecting', async ($: any, on: any) => {
  register(on, {});
  const calls: string[] = [];
  installMocks(on, { playCalls: calls });
  installStoreMocks(on, { clientId: null });
  installWebApiMocks(on);

  await $.command.run({ command: 'spotify', args: '' }); // reads what's playing
  const pane = await $.ui.mount({ plugin: 'spotify', surface: 'terminal', component: 'Pane', requestId: 'spotify-full', props: PANE_PROPS });
  expect(await pane.find({ text: /\/spotify config <client-id>/ })).toBeDefined();
  expect(await pane.find({ key: 'pane:connect' })).toBeUndefined();
  expect(await pane.find({ text: /Now playing/ })).toBeDefined(); // the header needs no app at all

  const bad = await $.command.run({ command: 'spotify', args: 'config nope' });
  expect(bad.text).toContain("isn't a Client ID");

  const id = 'ABCDEF0123456789abcdef0123456789'; // case kept: only `config` itself is case-insensitive
  const ok = await $.command.run({ command: 'spotify', args: `config ${id}` });
  expect(ok.text).toContain('saved');
  expect((await $.command.run({ command: 'spotify', args: 'config' })).text).toContain(id);

  await pane.redraw(PANE_PROPS);
  await pane.press({ key: 'pane:connect' });
  expect(calls.some(c => c.startsWith('open ') && c.includes(`client_id=${id}`))).toBe(true);
  await pane.unmount();
});

test('connecting spawns a backgrounded local listener, and the tick picks up the code it catches — no paste needed', async ($: any, on: any) => {
  register(on, {});
  const calls: string[] = [];
  installMocks(on, { playCalls: calls });
  installStoreMocks(on);
  const files = new Map<string, string>();
  on('fs.write', async ($: any, e: any) => {
    files.set(e.path, e.text);
    return { value: undefined };
  });
  on('fs.read', async ($: any, e: any) => {
    if (!files.has(e.path)) throw new Error(`no such file: ${e.path}`);
    return { value: files.get(e.path) };
  });
  on('fs.exists', async ($: any, e: any) => ({ value: files.has(e.path) }));
  const apiCalls: string[] = [];
  installWebApiMocks(on, { apiCalls });

  await $.command.run({ command: 'spotify', args: '' });
  const band = await $.ui.mount({ plugin: 'spotify', surface: 'terminal', component: 'AbovePrompt', requestId: 'spotify', props: BAND_PROPS });
  await band.press({ key: 'spotify:full' });

  const pane = await $.ui.mount({ plugin: 'spotify', surface: 'terminal', component: 'Pane', requestId: 'spotify-full', props: PANE_PROPS });
  await pane.press({ key: 'pane:connect' });

  // a listener script got written and spawned backgrounded, ready for the real redirect to land on
  expect(calls.some(c => c.includes('nohup python3'))).toBe(true);
  // a stale listener from an earlier, abandoned attempt can sit bound to the port for up to
  // three minutes — without clearing it first, a retry's new listener fails to bind at all
  expect(calls.some(c => c.includes('pkill -f spotify-mod-server-'))).toBe(true);
  const scriptPath = [...files.keys()].find(p => p.includes('spotify-mod-server-'));
  expect(scriptPath).toBeDefined();
  const state = scriptPath!.match(/spotify-mod-server-(.+)\.py$/)![1];

  // simulate what that listener would have written once Spotify actually redirected to it
  files.set(`/tmp/spotify-mod-callback-${state}.json`, JSON.stringify({ code: 'auth-code-1', state, error: '' }));

  await band.advance(1000); // the ticker's existing once-a-second tick, which now also polls for this

  expect(await pane.find({ text: /Focus/ })).toBeDefined(); // playlists loaded — login completed on its own
  expect(apiCalls.some(c => c.startsWith('POST https://accounts.spotify.com/api/token'))).toBe(true);
  expect(calls.some(c => c.startsWith('rm -f'))).toBe(true); // callback + script cleaned up after

  await band.unmount();
  await pane.unmount();
});

test('once connected, there is no like button in the band', async ($: any, on: any) => {
  register(on, { clientId: 'test-client-id' });
  installMocks(on);
  installStoreMocks(on, { initialToken: { accessToken: 'access-1', refreshToken: 'refresh-1', expiresAt: Date.now() + 60 * 60 * 1000 } });
  installWebApiMocks(on);

  await $.command.run({ command: 'spotify', args: '' });
  const band = await $.ui.mount({ plugin: 'spotify', surface: 'terminal', component: 'AbovePrompt', requestId: 'spotify', props: BAND_PROPS });
  await band.press({ key: 'spotify:full' }); // loads `auth` from the store

  expect(await band.find({ text: /🤍|💚|❓/ })).toBeUndefined();

  await band.unmount();
});

test('once connected, the sidebar lists playlists (names only, no track count, no player) and plays a track from one', async ($: any, on: any) => {
  register(on, { clientId: 'test-client-id' });
  installMocks(on);
  installStoreMocks(on, { initialToken: { accessToken: 'access-1', refreshToken: 'refresh-1', expiresAt: Date.now() + 60 * 60 * 1000 } });
  const apiCalls: string[] = [];
  installWebApiMocks(on, { apiCalls });

  await $.command.run({ command: 'spotify', args: '' });
  const band = await $.ui.mount({ plugin: 'spotify', surface: 'terminal', component: 'AbovePrompt', requestId: 'spotify', props: BAND_PROPS });
  await band.press({ key: 'spotify:full' });
  await band.unmount();

  const pane = await $.ui.mount({ plugin: 'spotify', surface: 'terminal', component: 'Pane', requestId: 'spotify-full', props: PANE_PROPS });
  expect(await pane.find({ text: /Focus/ })).toBeDefined();
  expect(await pane.find({ text: /Focus \(\d/ })).toBeUndefined(); // no track count next to the name
  expect(await pane.find({ text: /🤍|💚|⏸/ })).toBeUndefined(); // no player controls in the sidebar anymore
  expect(await pane.find({ text: /Friend/ })).toBeUndefined(); // owned by someone else — filtered out entirely

  await pane.press({ key: 'playlist:pl1' });
  expect(await pane.find({ text: /Song A/ })).toBeDefined();

  await pane.press({ key: 'track:spotify:track:aaa' });
  expect(apiCalls.some(c => c.startsWith('PUT https://api.spotify.com/v1/me/player/play'))).toBe(true);

  await pane.unmount();
});

test('searching lists results and plays a track by uri, an album by context', async ($: any, on: any) => {
  register(on, { clientId: 'test-client-id' });
  installMocks(on);
  installStoreMocks(on, { initialToken: { accessToken: 'access-1', refreshToken: 'refresh-1', expiresAt: Date.now() + 60 * 60 * 1000 } });
  const apiCalls: string[] = [];
  const bodies: string[] = [];
  installWebApiMocks(on, { apiCalls, bodies });

  await $.command.run({ command: 'spotify', args: '' });
  const band = await $.ui.mount({ plugin: 'spotify', surface: 'terminal', component: 'AbovePrompt', requestId: 'spotify', props: BAND_PROPS });
  await band.press({ key: 'spotify:full' });
  await band.unmount();

  const pane = await $.ui.mount({ plugin: 'spotify', surface: 'terminal', component: 'Pane', requestId: 'spotify-full', props: PANE_PROPS });
  await pane.input({ key: 'pane:search', text: 'midnight city' });
  expect(apiCalls.some(c => c.includes('/v1/search?q=midnight+city&type=track%2Calbum%2Cartist%2Cplaylist&limit=10'))).toBe(true);
  expect(await pane.find({ text: /Found Song/ })).toBeDefined();
  expect(await pane.find({ text: /Found Album/ })).toBeDefined();
  for (const heading of [/Songs/, /Albums/, /Artists/, /Playlists/]) expect(await pane.find({ text: heading })).toBeDefined();

  await pane.press({ key: 'result:spotify:track:sss' });
  expect(bodies[bodies.length - 1]).toBe(JSON.stringify({ uris: ['spotify:track:sss'] }));
  // a playlist someone else owns can't be opened (its tracks 403) — pressing it plays instead
  await pane.press({ key: 'result:spotify:playlist:pl9' });
  expect(bodies[bodies.length - 1]).toBe(JSON.stringify({ context_uri: 'spotify:playlist:pl9' }));

  // an album opens to its tracks; a track plays inside the album, so the rest follows on
  await pane.press({ key: 'result:spotify:album:alb' });
  expect(await pane.find({ text: /Album Cut/ })).toBeDefined();
  await pane.press({ key: 'browse:spotify:track:t1' });
  expect(bodies[bodies.length - 1]).toBe(JSON.stringify({ context_uri: 'spotify:album:alb', offset: { uri: 'spotify:track:t1' } }));
  await pane.press({ key: 'pane:browse-play' });
  expect(bodies[bodies.length - 1]).toBe(JSON.stringify({ context_uri: 'spotify:album:alb' }));
  await pane.press({ key: 'pane:back-browse' });

  // an owned playlist opens to its items
  await pane.press({ key: 'result:spotify:playlist:pl1' });
  expect(await pane.find({ text: /Song A/ })).toBeDefined();
  await pane.press({ key: 'pane:back-browse' });

  // artist → its albums → one album's tracks, and ‹ walks back out one level at a time
  await pane.press({ key: 'result:spotify:artist:art' });
  await pane.press({ key: 'browse:spotify:album:alb' });
  expect(await pane.find({ text: /Album Cut/ })).toBeDefined();
  await pane.press({ key: 'pane:back-browse' });
  expect(await pane.find({ text: /Album Cut/ })).toBeUndefined();
  await pane.press({ key: 'pane:back-browse' });
  expect(await pane.find({ text: /Found Song/ })).toBeDefined();

  await pane.press({ key: 'pane:back-search' });
  expect(await pane.find({ text: /Focus/ })).toBeDefined();
  await pane.unmount();
});

test('Liked Songs shows up as a synthetic playlist and plays in order or shuffled from its own loaded tracks', async ($: any, on: any) => {
  register(on, { clientId: 'test-client-id' });
  installMocks(on);
  installStoreMocks(on, { initialToken: { accessToken: 'access-1', refreshToken: 'refresh-1', expiresAt: Date.now() + 60 * 60 * 1000 } });
  const apiCalls: string[] = [];
  const bodies: string[] = [];
  installWebApiMocks(on, { apiCalls, bodies });

  await $.command.run({ command: 'spotify', args: '' });
  const band = await $.ui.mount({ plugin: 'spotify', surface: 'terminal', component: 'AbovePrompt', requestId: 'spotify', props: BAND_PROPS });
  await band.press({ key: 'spotify:full' });
  await band.unmount();

  const pane = await $.ui.mount({ plugin: 'spotify', surface: 'terminal', component: 'Pane', requestId: 'spotify-full', props: PANE_PROPS });
  expect(await pane.find({ text: 'Liked Songs' })).toBeDefined(); // synthesized, always listed first

  await pane.press({ key: 'playlist:__liked__' });
  expect(await pane.find({ text: /Song B/ })).toBeDefined();

  await pane.press({ key: 'pane:play' });
  expect(await pane.find({ text: /▶/ })).toBeDefined(); // the in-order button, next to shuffle
  const playCall = apiCalls.findIndex(c => c.startsWith('PUT https://api.spotify.com/v1/me/player/play'));
  expect(playCall).toBeGreaterThanOrEqual(0);
  // Liked Songs has no context_uri of its own — it plays the loaded tracks' own uris directly,
  // never Spotify's playlist-shuffle endpoint (which doesn't apply to it either)
  expect(JSON.parse(bodies[playCall]).uris).toEqual(['spotify:track:bbb']);
  expect(apiCalls.some(c => c.includes('/me/player/shuffle'))).toBe(false);

  await pane.unmount();
});

test('a failed track load shows an error inline without hiding the back button', async ($: any, on: any) => {
  register(on, { clientId: 'test-client-id' });
  installMocks(on);
  installStoreMocks(on, { initialToken: { accessToken: 'access-1', refreshToken: 'refresh-1', expiresAt: Date.now() + 60 * 60 * 1000 } });
  on('http.fetch', async ($: any, e: any) => {
    const url = e.url as string;
    if (url.endsWith('/v1/me')) {
      return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ id: 'my-id' }) } };
    }
    if (url.includes('/me/playlists')) {
      return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ items: [{ id: 'pl1', name: 'Focus', owner: { id: 'my-id' } }] }) } };
    }
    if (url.includes('/playlists/pl1/items')) {
      return { value: { status: 403, ok: false, headers: {}, text: '{"error":{"status":403,"message":"Forbidden"}}' } };
    }
    return { value: { status: 404, ok: false, headers: {}, text: `unmocked url: ${url}` } };
  });

  await $.command.run({ command: 'spotify', args: '' });
  const band = await $.ui.mount({ plugin: 'spotify', surface: 'terminal', component: 'AbovePrompt', requestId: 'spotify', props: BAND_PROPS });
  await band.press({ key: 'spotify:full' });
  await band.unmount();

  const pane = await $.ui.mount({ plugin: 'spotify', surface: 'terminal', component: 'Pane', requestId: 'spotify-full', props: PANE_PROPS });
  await pane.press({ key: 'playlist:pl1' });

  expect(await pane.find({ text: /403/ })).toBeDefined();
  expect(await pane.find({ text: /isn't registered on this Spotify app/ })).toBeDefined();
  // the whole point of the fix: the back button is still there and still works
  expect(await pane.find({ text: '‹' })).toBeDefined();
  await pane.press({ key: 'pane:back-playlists' });
  expect(await pane.find({ text: /Playlists/ })).toBeDefined();

  await pane.unmount();
});

test('the local callback listener script is scoped to the right state, file, and port', async () => {
  const state = 'abc-123-def';
  const script = loopbackServerScript(state);
  expect(script).toContain(callbackFilePath(state));
  expect(script).toContain('8907');
  expect(serverScriptFilePath(state)).toContain(state);
  expect(callbackFilePath(state)).toContain(state);
  // a different login's state must never resolve to this one's file
  expect(callbackFilePath('other-state')).not.toBe(callbackFilePath(state));
  // it must loop until a real callback (code/error present), not stop after the first request of
  // any kind — a single-shot server is gone by the time the real redirect lands if a browser's
  // preconnect or a stray favicon fetch reaches the port first, which reads as the page hanging
  expect(script).toContain('got_it');
  expect(script).toMatch(/while not srv\.got_it/);
  // the page the browser actually renders distinguishes success from denial, rather than
  // showing the same "connected" text regardless of what Spotify's redirect actually says
  expect(script).toContain('Connected to Claude Code');
  expect(script).toContain('Connection failed');
});

test('/spotify logout clears the connection and returns the sidebar to the connect screen', async ($: any, on: any) => {
  register(on, { clientId: 'test-client-id' });
  installMocks(on);
  const storeWrites: unknown[] = [];
  // reads back the last write, so the pane's own reload-recovery loadAuth sees the cleared store
  on('store.get', async ($: any, e: any) => ({
    value:
      e.key === 'spotify:clientId'
        ? 'test-client-id'
        : e.key !== 'spotify:tokens'
        ? undefined
        : storeWrites.length
          ? storeWrites[storeWrites.length - 1]
          : { accessToken: 'access-1', refreshToken: 'refresh-1', expiresAt: Date.now() + 60 * 60 * 1000 },
  }));
  on('store.set', async ($: any, e: any) => {
    if (e.key === 'spotify:tokens') storeWrites.push(e.value);
    return { value: undefined };
  });
  on('ui.open', async () => ({ value: undefined }));
  installWebApiMocks(on);

  await $.command.run({ command: 'spotify', args: '' });
  const band = await $.ui.mount({ plugin: 'spotify', surface: 'terminal', component: 'AbovePrompt', requestId: 'spotify', props: BAND_PROPS });
  await band.press({ key: 'spotify:full' }); // loads `auth` from the store

  const result = await $.command.run({ command: 'spotify', args: 'logout' });
  expect(result.text).toContain('disconnected');
  expect(storeWrites[storeWrites.length - 1]).toBe(null);

  const pane = await $.ui.mount({ plugin: 'spotify', surface: 'terminal', component: 'Pane', requestId: 'spotify-full', props: PANE_PROPS });
  expect(await pane.find({ text: /connect Spotify/ })).toBeDefined();

  await band.unmount();
  await pane.unmount();
});

test('a pane mounted with nothing loaded (as one surviving a plugin reload is) loads auth and playlists itself', async ($: any, on: any) => {
  register(on, { clientId: 'test-client-id' });
  installMocks(on);
  installStoreMocks(on, { initialToken: { accessToken: 'access-1', refreshToken: 'refresh-1', expiresAt: Date.now() + 60 * 60 * 1000 } });
  installWebApiMocks(on);

  // no ◫ press — that's what used to be the only thing that loaded playlists
  const pane = await $.ui.mount({ plugin: 'spotify', surface: 'terminal', component: 'Pane', requestId: 'spotify-full', props: PANE_PROPS });
  expect(await pane.find({ text: /Focus/ })).toBeDefined();
  await pane.unmount();
});

test('the sidebar header shows the playing track with its cover art, fetched once per track', async ($: any, on: any) => {
  register(on, { clientId: 'test-client-id' });
  const calls: string[] = [];
  installMocks(on, { playCalls: calls });
  installStoreMocks(on, { initialToken: { accessToken: 'access-1', refreshToken: 'refresh-1', expiresAt: Date.now() + 60 * 60 * 1000 } });
  installWebApiMocks(on);

  await $.command.run({ command: 'spotify', args: '' });
  const band = await $.ui.mount({ plugin: 'spotify', surface: 'terminal', component: 'AbovePrompt', requestId: 'spotify', props: BAND_PROPS });
  await band.advance(1000);
  await band.advance(1000);
  expect(calls.filter(c => c.includes('sips')).length).toBe(1); // same track, converted once

  const pane = await $.ui.mount({ plugin: 'spotify', surface: 'terminal', component: 'Pane', requestId: 'spotify-full', props: PANE_PROPS });
  expect(await pane.find({ text: /Now playing/ })).toBeDefined();
  expect(await pane.find({ key: 'pane:art' })).toBeDefined();
  await pane.unmount();
  await band.unmount();
});

test('the band shows the cover art beside the track once it has loaded, and hides it in compact mode', async ($: any, on: any) => {
  register(on, {});
  installMocks(on);

  await $.command.run({ command: 'spotify', args: '' });
  const band = await $.ui.mount({ plugin: 'spotify', surface: 'terminal', component: 'AbovePrompt', requestId: 'spotify', props: BAND_PROPS });
  await band.advance(1000);
  expect(await band.find({ key: 'band:art' })).toBeDefined();
  expect(await band.find({ text: /Midnight City/ })).toBeDefined();

  await band.press({ key: 'spotify:compact' });
  expect(await band.find({ key: 'band:art' })).toBeUndefined();
  await band.unmount();
});

test('the pane draws only the list rows that fit under its pinned header', async ($: any, on: any) => {
  register(on, { clientId: 'test-client-id' });
  installMocks(on);
  installStoreMocks(on, { initialToken: { accessToken: 'access-1', refreshToken: 'refresh-1', expiresAt: Date.now() + 60 * 60 * 1000 } });
  // ahead of installWebApiMocks, so this answers /me/playlists before its two-playlist default does
  on('http.fetch', { url: 'https://api.spotify.com/v1/me/playlists?limit=50' }, async () => ({
    value: {
      status: 200,
      ok: true,
      headers: {},
      text: JSON.stringify({ items: Array.from({ length: 40 }, (_, i) => ({ id: `p${i}`, name: `List ${i}`, owner: { id: 'my-id' } })) }),
    },
  }));
  installWebApiMocks(on);

  const props = { ...PANE_PROPS, scroll: { offset: 0, bodyRows: 20 } };
  const pane = await $.ui.mount({ plugin: 'spotify', surface: 'terminal', component: 'Pane', requestId: 'spotify-full', props });
  expect(await pane.find({ key: 'playlist:p0' })).toBeDefined();
  expect(await pane.find({ key: 'playlist:p39' })).toBeUndefined(); // off the bottom, not drawn at all

  // (the test kit's $.ui.scroll can't resolve an offset for a mounted pane, so the wheel path
  // itself — handlePaneScroll — is only exercised live)
  expect(await pane.find({ key: 'pane:search' })).toBeDefined();
  await pane.unmount();
});

test('Liked Songs loads every page, not just the first 50', async ($: any, on: any) => {
  register(on, { clientId: 'test-client-id' });
  installMocks(on);
  installStoreMocks(on, { initialToken: { accessToken: 'access-1', refreshToken: 'refresh-1', expiresAt: Date.now() + 60 * 60 * 1000 } });
  const page = (from: number, next: string | null) => ({
    value: {
      status: 200,
      ok: true,
      headers: {},
      text: JSON.stringify({
        items: Array.from({ length: 50 }, (_, i) => ({ track: { uri: `spotify:track:t${from + i}`, name: `Liked ${from + i}`, artists: [] } })),
        next,
      }),
    },
  });
  on('http.fetch', { url: 'https://api.spotify.com/v1/me/tracks?limit=50' }, async () => page(0, 'https://api.spotify.com/v1/me/tracks?offset=50&limit=50'));
  on('http.fetch', { url: 'https://api.spotify.com/v1/me/tracks?offset=50&limit=50' }, async () => page(50, null));
  const bodies: string[] = [];
  on('http.fetch', { url: 'https://api.spotify.com/v1/me/player/play' }, async ($: any, e: any) => {
    bodies.push(e.init?.body ?? '');
    return { value: { status: 204, ok: true, headers: {}, text: '' } };
  });
  installWebApiMocks(on);

  const pane = await $.ui.mount({ plugin: 'spotify', surface: 'terminal', component: 'Pane', requestId: 'spotify-full', props: PANE_PROPS });
  await pane.press({ key: 'playlist:__liked__' });
  await pane.press({ key: 'pane:play' });
  expect(JSON.parse(bodies[bodies.length - 1]).uris.length).toBe(100);
  await pane.unmount();
});

test('/spotify stop closes the band', async ($: any, on: any) => {
  register(on, {});
  installMocks(on);

  await $.command.run({ command: 'spotify', args: '' });
  const result = await $.command.run({ command: 'spotify', args: 'stop' });
  expect(result.text).toContain('closed');
});
