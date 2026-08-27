# Open the Codex stream beside interactive Codex sessions started inside Cmux.
# Sourcing this file is safe outside Cmux: the wrapper delegates directly.

_cmux_codex_starts_session() {
  local arg skip_next=false

  (( $# == 0 )) && return 0
  for arg in "$@"; do
    if [[ "$skip_next" == true ]]; then
      skip_next=false
      continue
    fi
    case "$arg" in
      --) return 0 ;;
      --help|-h|-V|--version) return 1 ;;
      -c|--config|-m|--model|-p|--profile|-C|--cd|--remote|-a|--ask-for-approval|-s|--sandbox|--output-last-message|--enable|--disable)
        skip_next=true
        ;;
      -*) ;;
      exec|e|resume|fork) return 0 ;;
      review|login|logout|mcp|plugin|mcp-server|app-server|remote-control|app|completion|update|doctor|sandbox|debug|apply|a|archive|delete|unarchive|cloud|exec-server|features|help)
        return 1
        ;;
      *) return 0 ;;
    esac
  done
  return 0
}

codex() {
  if [[ -n "${CMUX_SURFACE_ID:-}" && -n "${CMUX_WORKSPACE_ID:-}" && "${HERDR_ENV:-}" != "1" ]] \
      && _cmux_codex_starts_session "$@"; then
    node "$HOME/.codex/skills/open-codex-stream/scripts/open_stream.mjs" --auto \
      </dev/null >/dev/null 2>&1 &!
  fi
  command codex "$@"
}
