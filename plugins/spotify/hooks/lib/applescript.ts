// Pure parsing/formatting only — nothing here touches `$`. Actually shelling out to `osascript`
// lives in register.tsx (the validator requires every `$` call to be textually in the hooks
// module file, not reached through an import).

export type PlayerState = 'playing' | 'paused' | 'stopped';

export type NowPlaying =
  | { running: false }
  | {
      running: true;
      trackId: string; // bare id, "37i9..." — the "spotify:track:" prefix stripped
      track: string;
      artist: string;
      album: string;
      durationMs: number;
      positionSec: number;
      state: PlayerState;
      volume: number;
    };

// the AppleScript below joins fields with ASCII 31 (a unit separator no track/artist name uses)
export const FIELD_SEP = '\x1f';

export function parseNowPlaying(raw: string): NowPlaying {
  const trimmed = raw.trim();
  if (trimmed === 'not running' || trimmed === '') return { running: false };

  const [trackId, track, artist, album, durationMs, positionSec, state, volume] = trimmed.split(FIELD_SEP);
  const validState: PlayerState = state === 'playing' || state === 'paused' ? (state as PlayerState) : 'stopped';

  return {
    running: true,
    trackId: (trackId ?? '').replace('spotify:track:', ''),
    track: track ?? '',
    artist: artist ?? '',
    album: album ?? '',
    durationMs: Number(durationMs) || 0,
    positionSec: Number(positionSec) || 0,
    state: validState,
    volume: Number(volume) || 0,
  };
}

export function formatTime(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}:${rem.toString().padStart(2, '0')}`;
}

// a text progress bar: filled cells up to the playback fraction, out of `width` cells total
export function progressBar(positionSec: number, durationMs: number, width = 24): string {
  const durationSec = durationMs / 1000;
  const fraction = durationSec > 0 ? Math.min(1, Math.max(0, positionSec / durationSec)) : 0;
  const filled = Math.round(fraction * width);
  return '█'.repeat(filled) + '░'.repeat(Math.max(0, width - filled));
}
