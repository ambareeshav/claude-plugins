/* @jsx h */
import type { ClientSurface } from 'claude-code'

// Draws nothing — its only job is a free-running clock. The hooks module has no timer of its
// own (only a Client's drawing-thread `surface.every` does), so this is how the "now playing"
// card gets a heartbeat: post up to `ui.message` once a second, which re-runs the AppleScript
// query and invalidates the render.

export default function Ticker(_props: unknown, surface: ClientSurface<{ started: true }>) {
  const { Box } = surface.elements
  if (surface.state === undefined) {
    surface.setState({ started: true })
    surface.every(1000, () => {
      surface.post({ tick: true })
    })
  }
  return <Box />
}
