# Claude Code Spotify Mod
<img width="128" height="128" alt="467aaf4c-bac3-48b5-806b-af480625bb20" src="https://github.com/user-attachments/assets/cd191646-521c-4554-b445-f4e06c5fefdc" /> A Spotify plugin for Claude Code. Skip a bad song without leaving the terminal. `/spotify` puts play/pause/skip/mute, the album cover and what's playing right above the prompt, with nothing to set up beyond having Spotify open. `◫` opens a sidebar with the album cover, and once you connect your own (free) Spotify app, search and your playlists too.

**Works out of the box:** playback controls, now playing, album art.
**Needs your own Spotify Client ID** (a couple of minutes, see [below](#connecting-the-sidebar)): search, playlists, Liked Songs.

## Install

Part of [Ambareesha's Claude Code plugins](https://github.com/ambareeshav/claude-plugins). Add the marketplace once, then install spotify from it.

Inside Claude Code:

```
/plugin marketplace add ambareeshav/claude-plugins
/plugin install spotify@ambareeshav
```

Or, once the marketplace is added, run `/plugin`, open the **ambareeshav** marketplace, and install spotify from the list.

If you're continuing a session, run `/reload-plugins` to turn it on, and `/spotify` is available.

From the terminal:

```
claude plugin marketplace add ambareeshav/claude-plugins
claude plugin install spotify@ambareeshav
```

## Play

1. `/spotify` opens the band (`/spotify stop` closes it).
2. Buttons, icons only: `✕` close, `◫` sidebar, `⌄`/`⌃` collapse/expand, `⏮` prev, `▶`/`⏸` play/pause, `⏭` next, `🔇`/`🔈` mute/unmute. Track/artist/album and a position bar are shown below them, ticking on their own once a second.
3. `⌄` collapses the band to one line — buttons, then `│ track — artist │ 1:23/4:56` — for when three rows is more than you want to spare; `⌃` expands it back.
4. If Spotify isn't open, the band offers an `open Spotify` button instead of controls.
5. `◫` opens a sidebar (`Pane`) — a now-playing header with the album cover (in terminals with kitty graphics: Ghostty, kitty; elsewhere just the text) over a black → rust gradient, then a **Playlists** list (with **Liked Songs** always listed first, then playlists you created yourself — followed and other-owned playlists don't show up here, see below), and inside one, its tracks to play individually, `▶` play the whole thing in order, or `🔀` shuffle-play it. `‹` goes back to the list. A search box at the top searches Spotify's whole catalog (songs, albums, artists, playlists — up to 10 of each); a song plays on press; an album, an artist (→ its albums → their tracks) or a playlist you own opens (marked `›`) with `▶`/`🔀` and per-track play that continues through the rest; a playlist someone else owns just plays, since Spotify won't let apps read its tracks. Results are grouped under Songs / Albums / Artists / Playlists; icons: `▸` song, `◉` album, `☺` artist, `≡` playlist. Every list loads in full (page by page, 50 at a time) and scrolls under a pinned header.

## Connecting the sidebar

The band needs nothing: it talks to the Spotify desktop app directly. Search and playlists go through the Spotify Web API, which needs a Spotify app of your own. Spotify only lets an app in Development Mode serve its owner and up to 5 added users, so this mod can't ship a shared one.

1. Go to [developer.spotify.com/dashboard](https://developer.spotify.com/dashboard) and create an app (Spotify requires a Premium account for this). Set the Redirect URI to exactly `http://127.0.0.1:8907/callback` and tick **Web API**.
2. Copy the app's Client ID and run `/spotify config <client-id>`. It's saved for every session. (`/spotify config` on its own shows the current one.)
3. Open the sidebar with `◫` and press **connect Spotify**. Your browser opens Spotify's login page; approve it, and the sidebar connects on its own within a second or two.

As the app's owner you're let in automatically, so there's no one to add under User Management. There's no client secret anywhere: the login uses PKCE, where the Client ID isn't a secret.

If the sidebar doesn't connect by itself (no `python3`, or something else is using port 8907), the browser shows a "can't reach this page" error with the code in the address bar. Paste that URL into the sidebar's input and press Enter.

You can also set the Client ID as the plugin's `clientId` setting (your Claude Code plugin settings, or `.claude/settings.json`); that wins over `/spotify config`.

**Starting over**: `/spotify logout` clears the stored login without touching your Spotify account's own authorization. Press **connect Spotify** afterward to log in again.

## How it works

- **The band** talks to the local **Spotify desktop app** via `osascript` (AppleScript) — no login, no API keys.
  - Reading "what's playing" checks whether Spotify is running (via System Events) first and never launches it just to check. The transport buttons do launch it if it's closed, the same as clicking its dock icon would.
  - It's narrow (icon-only buttons need far less room than labeled ones) and draws in a row with `{await next(e)}` — the same `AbovePrompt` site other mods (tetris, pong) use, so it can sit beside whatever else draws there instead of hiding it.
  - A zero-size `Client` (`boards/ticker.tsx`) is mounted purely for its drawing-thread timer: it posts a tick once a second, which the hooks module answers by re-running the AppleScript query and invalidating the render. That's what keeps the position/progress bar moving without a button press — the hooks module has no timer of its own, only a `Client`'s `surface.every` does.
  - Mute remembers the volume it muted from (in memory, for this session) so unmute restores it instead of guessing.
  - Collapsed (`⌄`/`⌃`) mode drops the fixed narrow column width and lets the row size to its content instead — the whole point of asking for one wide line rather than three narrow ones.
- **The sidebar** has no transport controls, since the band already owns those — just a now-playing header with the cover (fetched once per track via AppleScript's `artwork url`, converted to PNG with `sips`, drawn with `Image`). The pane scrolls its own list (a `ui.scroll` hook) rather than letting the engine scroll the whole tree, so the cover never moves — a moving kitty image made Ghostty's scrolling stutter. It talks to the real **Spotify Web API**, authenticated via OAuth's Authorization Code + PKCE flow — no client secret, since PKCE's whole point is not needing one for a public/desktop client.
  - Login spawns a short-lived local Python HTTP server (`python3`, backgrounded via `nohup ... & disown` so the spawning call returns immediately) on `127.0.0.1:8907` to catch the OAuth redirect — `$.process.run` itself only runs one-shot commands that it waits on, not long-lived listeners, so the listener has to be launched detached from it. It loops on the real callback rather than answering exactly once — a single-shot server that exits after the very first connection is gone by the time the real redirect lands if anything else reaches the port first (a browser's speculative preconnect, a stray favicon fetch), which reads as the page hanging ("took too long to respond"), not the expected instant "can't reach this page." A `pkill` before spawning a new one also clears out any listener still bound to the port from an earlier, abandoned attempt (it can sit alive for up to three minutes) — otherwise a retry's new listener silently fails to bind at all. It writes what it catches to a state-scoped file, and the same `Client` ticker that drives the band's progress bar also polls for that file once a second while a login is pending, completing it automatically. If the listener can't start (no `python3`) or the redirect never reaches it, the sidebar's paste-the-URL `Input` is still there as a fallback — the loopback redirect URI needs no real listener either way, since the code lands in the browser's address bar regardless of whether anything answers it. The page the browser lands on is styled (dark, a check or an ✕, auto-closes the tab after a second and a half) and distinguishes a real success from Spotify denying the request, rather than showing the same "connected" text regardless.
  - `/spotify logout` clears the stored tokens and all sidebar state.
  - Tokens (access + refresh) persist in `$.store` across sessions; the access token silently refreshes on expiry (or on a 401), once per call, before failing for real.
  - A failed request (a 403, a flaky connection, whatever) shows as a small dismissible banner, not a screen that replaces the whole sidebar — navigating back and retrying always stays available. An earlier version let one failed request hide the entire playlists list and its back button; this is the fix.
  - Playlist tracks come from `/playlists/{id}/items`, not `/playlists/{id}/tracks` — Spotify deprecated the latter in an early-2026 API migration. The response's per-item field also renamed (`track` → `item`); this mod reads `item` and falls back to `track` only for safety.
  - **The list only shows playlists you created.** As of a Feb 2026 Spotify API change, `/playlists/{id}/items` only serves tracks to the account that *owns* the playlist — a followed, collaborative-but-not-yours, or algorithmic playlist (Discover Weekly, Daily Mix, a Blend, ...) always 403s there now, for any third-party app, permanently. Rather than list something that's guaranteed to fail when opened, `loadPlaylists` fetches the account's own id from `/me` once and filters `/me/playlists` down to `owner.id === ` that id (`lib/spotifyApi.ts`'s `toPlaylists`) before the sidebar ever sees it.
  - **Search** uses `/v1/search` (no extra scope). Since Spotify's Feb 2026 change its `limit` caps at 10 per type, so the sidebar shows the top 10 of each rather than paging. Playing a searched playlist you don't own works (it's a `context_uri`, not an `/items` read), even though opening one wouldn't. Artists open to `/artists/{id}/albums` (singles + albums) — Spotify removed `/artists/{id}/top-tracks` in the same change.
  - **Liked Songs** isn't a real playlist — Spotify's `/me/playlists` never lists it, since it isn't a playlist resource. This mod synthesizes an entry for it from `/me/tracks` (the separate "Your Music" saved-tracks endpoint) instead, so it shows up and works the same as any other playlist to browse or play. It has no `context_uri` of its own either, so playing it (in order or shuffled) sends the loaded tracks' own URIs directly rather than asking Spotify to play a playlist context — capped at 500 to keep the request small. It isn't subject to the owner-only filter above, since it's read from a different endpoint entirely.

## Requirements

- macOS with the Spotify desktop app installed (not the web player) — the band always needs this.
- Claude Code with `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` — the `$` API is early access and may change between releases.
- The first control you press may prompt macOS for permission to let Claude Code (your terminal) control Spotify via Accessibility/Automation — allow it once.
- For search and playlists: your own Spotify app's Client ID and a one-time browser login (see above). Creating the app, and starting playback remotely via the Web API, both need Spotify Premium (Spotify's rules, not this mod's).
- **Only playlists you created yourself show up in the sidebar.** Followed, collaborative-but-not-yours, and algorithmic playlists (Discover Weekly, Daily Mix, a Blend, ...) are filtered out before they're ever listed — their tracks are permanently unreadable via the Web API for any third-party app as of a Feb 2026 Spotify change, so there's nothing to show for them. Liked Songs is unaffected (different endpoint).

## Known limitations / next steps

- **Search and playlists need your own Spotify app.** Spotify's Development Mode caps an app at its owner plus 5 users, so there's no shared app to fall back on.
- **The local OAuth listener needs `python3` and a free port 8907** — if either's missing, connecting falls back to copy-pasting the redirect URL by hand.
- **The progress bar ticks once a second**, driven by the ticker `Client`'s own timer — not sample-accurate, but close enough to read at a glance.
- **Session-scoped mute memory.** The volume mute restores to resets on plugin reload.
- **Playing needs an active Spotify Connect device.** If nothing's playing anywhere, the mod looks up your devices and targets one, but if none exist yet it asks you to press play in Spotify once first — a Web API restriction, not a workaround avoided.
