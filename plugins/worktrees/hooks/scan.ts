// Bash run by $.process.run: finds repos with linked worktrees, their merge state against
// main/master/dev/develop, Claude session files and the cwds they ran in, and live sessions.
// Args: depth, the comma-separated branches the person picked as targets, then roots. One tab-separated record per line, tagged by its first field.
export const SCAN = String.raw`set -u
# args: depth root...
depth=$1; branches=$2; shift 2
P="$HOME/.claude/projects"
echo "N	$(date +%s)"

for root in "$@"; do
  case "$root" in "~"*) root="$HOME$(printf '%s' "$root" | cut -c2-)";; esac
  [ -d "$root" ] || continue
  find "$root" -maxdepth "$depth" \( -name node_modules -o -name .venv -o -name vendor -o -name worktrees -o -name .worktrees \) -prune -o -name .git -type d -print 2>/dev/null
done | sort -u | while IFS= read -r g; do
  repo=$(dirname "$g")
  [ "$(git -C "$repo" worktree list --porcelain 2>/dev/null | grep -c '^worktree ')" -gt 1 ] || continue
  bases=""
  for b in $(echo "$branches" | tr ',' ' '); do
    refs=""
    git -C "$repo" rev-parse -q --verify "refs/heads/$b" >/dev/null && refs="$b"
    git -C "$repo" rev-parse -q --verify "refs/remotes/origin/$b" >/dev/null && refs="$refs origin/$b"
    [ -n "$refs" ] && bases="$bases $b:$(echo $refs | tr ' ' ',')"
  done
  echo "R	$repo	$(echo $bases)"
  # branches never deleted and offered as picks: origin's default and the main checkout's
  echo "D	$repo	$(git -C "$repo" symbolic-ref --short -q refs/remotes/origin/HEAD | sed 's#^origin/##') $(git -C "$repo" branch --show-current)"
  wt=""; head=""; br=""; prn=""; lck=""
  { git -C "$repo" worktree list --porcelain; echo; } | while IFS= read -r line; do
    case "$line" in
      "worktree "*) wt=$(printf '%s' "$line" | cut -c10-);;
      "HEAD "*) head=$(printf '%s' "$line" | cut -c6-);;
      "branch "*) br=$(printf '%s' "$line" | cut -c8- | sed 's#^refs/heads/##');;
      "prunable"*) prn=1;;
      "locked"*) lck=1;;
      "")
        if [ -n "$wt" ]; then
          if [ "$wt" = "$repo" ]; then main=1; else main=0; fi
          ct=0; dirty=0; merged=""; remote=0
          if [ -z "$prn" ] && [ -d "$wt" ]; then
            ct=$(git -C "$wt" log -1 --format=%ct 2>/dev/null || echo 0)
            dirty=$(git -C "$wt" status --porcelain 2>/dev/null | wc -l | tr -d ' ')
            [ -n "$(git -C "$repo" for-each-ref --contains "$head" --count=1 refs/remotes 2>/dev/null)" ] && remote=1
            for pair in $bases; do
              name=$(echo "$pair" | cut -d: -f1); best=""
              for ref in $(echo "$pair" | cut -d: -f2 | tr ',' ' '); do
                n=$(git -C "$repo" rev-list --count "$ref..$head" 2>/dev/null) || continue
                if [ -z "$best" ] || [ "$n" -lt "$best" ]; then best=$n; fi
              done
              [ -n "$best" ] || continue
              # squash/rebase merges: merging HEAD into the base would change nothing
              if [ "$best" -gt 0 ]; then
                for ref in $(echo "$pair" | cut -d: -f2 | tr ',' ' '); do
                  t=$(git -C "$repo" merge-tree --write-tree "$ref" "$head" 2>/dev/null | head -1)
                  if [ -n "$t" ] && [ "$t" = "$(git -C "$repo" rev-parse "$ref^{tree}")" ]; then best=s; break; fi
                done
              fi
              merged="$merged $name=$best"
            done
          fi
          echo "W	$repo	$wt	$br	$head	$ct	$dirty	$remote	$main	$prn	$lck	$(echo $merged)"
        fi
        wt=""; head=""; br=""; prn=""; lck="";;
    esac
  done
done

# sessions: file mtimes, then each file's distinct cwds and last title, cached per file
find "$P" -maxdepth 2 -name '*.jsonl' -exec stat -f 'T	%m	%N' {} + 2>/dev/null
C="$HOME/.claude/worktree-sessions-cache/v2"; mkdir -p "$C"
find "$P" -maxdepth 2 -name '*.jsonl' | while IFS= read -r f; do
  c="$C/$(printf '%s' "$f" | tr '/' '_')"
  if [ ! -f "$c" ] || [ "$f" -nt "$c" ]; then
    LC_ALL=C grep -o -E '"(cwd|aiTitle|customTitle)":"[^"]*"' "$f" 2>/dev/null | LC_ALL=C awk -v f="$f" '
      { j = index($0, "\":\""); k = substr($0, 2, j - 2); v = substr($0, j + 3); v = substr(v, 1, length(v) - 1)
        if (k == "cwd") { last = v; if (!(v in seen)) { seen[v] = 1; print "C\t" f "\t" v } }
        else if (k == "customTitle") ct = v
        else at = v }
      END { if (last != "") print "Z\t" f "\t" last; if (ct != "") print "A\t" f "\t" ct; else if (at != "") print "A\t" f "\t" at }' > "$c.tmp" && mv "$c.tmp" "$c"
  fi
  cat "$c"
done

# live sessions
for j in "$HOME"/.claude/sessions/*.json; do
  [ -f "$j" ] || continue
  pid=$(basename "$j" .json)
  kill -0 "$pid" 2>/dev/null || continue
  cwd=$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | grep '^n' | cut -c2-)
  echo "L	$pid	$cwd	$(tr -d '\n' < "$j")"
done
`
