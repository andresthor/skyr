# pi-profile.sh — point plain `pi` at configs/<name>/agent for this shell.
# Source it:  source lib/pi-profile.sh experimental   (then run `pi`)
# ~/.pi is never touched; active sessions keep their resolved config dir.
pi-profile() {
  local name="${1:?usage: pi-profile <config>}"
  local root="${PI_PLAYGROUND:-$(git rev-parse --show-toplevel 2>/dev/null || echo "$HOME/projects/skyr")}"
  local dir="$root/configs/$name/agent"
  [ -d "$dir" ] || { echo "no config '$name' at $dir" >&2; return 1; }
  export PI_CODING_AGENT_DIR="$dir"
  echo "PI_CODING_AGENT_DIR=$PI_CODING_AGENT_DIR"
}
