// Pure response shaping only — nothing here touches `$` or does any fetching (that's in
// register.tsx). Takes already-parsed JSON, returns the plain shapes the Pane renders.

export type TokenSet = {
  accessToken: string;
  refreshToken: string; // Spotify only sends a new one sometimes; keep the last one otherwise
  expiresAt: number; // epoch ms
};

export function tokenSetFrom(json: any, previousRefreshToken: string): TokenSet {
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token ?? previousRefreshToken,
    expiresAt: Date.now() + (Number(json.expires_in) || 3600) * 1000,
  };
}

export type Playlist = { id: string; name: string };

// only playlists this account owns — a followed, collaborative-but-not-yours, or algorithmic
// playlist (Discover Weekly, a Blend, ...) shows up in /me/playlists just like an owned one, but
// its tracks always 403 now (Spotify's Feb 2026 API change, see register.tsx). Filtering here
// means the sidebar only ever lists things it can actually open, instead of listing broken links.
export function toPlaylists(json: any, ownerId: string): Playlist[] {
  const items = Array.isArray(json?.items) ? json.items : [];
  return items
    .filter((p: any) => p && p.id && p.owner?.id === ownerId)
    .map((p: any) => ({ id: p.id, name: p.name ?? '(untitled)' }));
}

export type PlaylistTrack = { uri: string; name: string; artist: string };

// Fisher-Yates, used for shuffle-playing Liked Songs — that has no `context_uri` of its own to
// hand Spotify's own shuffle to (it isn't a playlist resource), so this mod does it client-side
// over whatever page of tracks it has loaded.
export function shuffled<T>(items: readonly T[]): T[] {
  const copy = items.slice();
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

export function toPlaylistTracks(json: any): PlaylistTrack[] {
  const items = Array.isArray(json?.items) ? json.items : [];
  return items
    // `item` is the current field (a TrackObject or EpisodeObject); `track` is Spotify's own
    // deprecated alias for the same thing, kept here only as a fallback for an older response
    // an album's /tracks items are the track objects themselves, with no wrapper at all
    .map((it: any) => it.item ?? (typeof it.track === 'object' ? it.track : it))
    .filter((t: any) => t && t.uri)
    .map((t: any) => ({
      uri: t.uri,
      name: t.name ?? '(untitled)',
      artist: (t.artists ?? []).map((a: any) => a.name).join(', '),
    }));
}

// one row of /v1/search, flattened across the types the sidebar asks for. `kind` picks how it
// plays: a track goes in as `uris`, an album/artist/playlist as its own `context_uri`
// `ownerId` is only set for playlists: only an owned one can be opened (see register.tsx)
export type SearchResult = { kind: 'track' | 'album' | 'artist' | 'playlist'; id: string; uri: string; name: string; detail: string; ownerId?: string };

const joinArtists = (x: any) => (x?.artists ?? []).map((a: any) => a.name).join(', ');

// tracks first — the thing a search is usually after — then albums, artists, playlists.
// Spotify pads `items` with nulls for results it won't return, hence the filter
export function toSearchResults(json: any): SearchResult[] {
  const pick = (key: string, kind: SearchResult['kind'], detail: (x: any) => string): SearchResult[] =>
    (Array.isArray(json?.[key]?.items) ? json[key].items : [])
      .filter((x: any) => x && x.uri)
      .map((x: any) => ({ kind, id: x.id, uri: x.uri, name: x.name ?? '(untitled)', detail: detail(x), ...(kind === 'playlist' ? { ownerId: x.owner?.id } : {}) }));
  return [
    ...pick('tracks', 'track', joinArtists),
    ...pick('albums', 'album', joinArtists),
    ...pick('artists', 'artist', () => 'artist'),
    ...pick('playlists', 'playlist', (p: any) => `by ${p.owner?.display_name ?? p.owner?.id ?? 'unknown'}`),
  ];
}

// /artists/{id}/albums — the one artist listing left after Spotify dropped top-tracks (Feb 2026)
export function toArtistAlbums(json: any): SearchResult[] {
  return toSearchResults({ albums: json });
}
