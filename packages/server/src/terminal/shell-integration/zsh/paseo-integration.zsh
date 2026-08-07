if [[ -n "${_PASEO_ZSH_INTEGRATION_LOADED-}" ]]; then
  return
fi
typeset -g _PASEO_ZSH_INTEGRATION_LOADED=1

autoload -Uz add-zsh-hook

typeset -g _PASEO_ZSH_COMMAND_ACTIVE=0

function _paseo_osc633() {
  printf '\e]633;%s\a' "$1"
}

function _paseo_precmd() {
  local command_status=$?
  if [[ "$_PASEO_ZSH_COMMAND_ACTIVE" == "1" ]]; then
    _paseo_osc633 "D;${command_status}"
    _PASEO_ZSH_COMMAND_ACTIVE=0
  fi
  printf '\e]2;%s\a' "${PWD/#$HOME/~}"
  _paseo_osc633 "A"
  _paseo_register_zle_hook
}

function _paseo_preexec() {
  _PASEO_ZSH_COMMAND_ACTIVE=1
  _paseo_osc633 "B"
  # Nonce-tagged like the readiness marker: this is what tells the daemon the
  # line editor no longer owns stdin, so it must be as unforgeable as the
  # marker that says it does. A bare 633;C from foreign output (VS Code's own
  # shell integration, a replayed log) would otherwise strand the next script
  # on the readiness timeout.
  _paseo_osc633 "C;${PASEO_TERMINAL_NONCE-}"
  printf '\e]2;%s\a' "$1"
}

add-zsh-hook precmd _paseo_precmd
add-zsh-hook preexec _paseo_preexec

# Readiness marker. precmd is too early to type into: it runs before prompt
# expansion and before any precmd hook a later .zshrc registers, either of which
# can still block on `read`. zle-line-init fires only once the line editor has
# actually taken the line, which is the moment injected input is safe.
#
# The nonce proves the marker came from this terminal's integration rather than
# from stray output that happens to contain OSC 633.
function _paseo_zle_line_init() {
  [[ -n "${PASEO_TERMINAL_NONCE-}" ]] && _paseo_osc633 "R;${PASEO_TERMINAL_NONCE}"
}

# Registered from precmd, not at source time: this file is sourced from .zshenv,
# where zle is not loaded yet and `zle -N` is a no-op. By the first precmd the
# shell is interactive and zle exists.
#
# add-zle-hook-widget (zsh 5.3+) composes with the user's own zle-line-init;
# `zle -N zle-line-init` would silently replace theirs. The .zshenv wrapper only
# announces the integration to the daemon when this helper is available, so
# reaching here without it should not happen — but if it does, keep retrying on
# each precmd rather than latching a failure in permanently.
function _paseo_register_zle_hook() {
  (( _PASEO_ZLE_HOOK_REGISTERED )) && return
  autoload -Uz add-zle-hook-widget 2>/dev/null || return
  (( $+functions[add-zle-hook-widget] )) || return
  add-zle-hook-widget zle-line-init _paseo_zle_line_init 2>/dev/null || return
  # Latch only after the hook is actually installed. Setting it earlier would
  # turn one transient failure into a shell that never reports readiness again.
  typeset -g _PASEO_ZLE_HOOK_REGISTERED=1
}
typeset -g _PASEO_ZLE_HOOK_REGISTERED=0
