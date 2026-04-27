if [[ -n "${_HUBCODE_ZSH_INTEGRATION_LOADED-}" ]]; then
  return
fi
typeset -g _HUBCODE_ZSH_INTEGRATION_LOADED=1

autoload -Uz add-zsh-hook

typeset -g _HUBCODE_ZSH_COMMAND_ACTIVE=0

function _hubcode_osc633() {
  printf '\e]633;%s\a' "$1"
}

function _hubcode_precmd() {
  local command_status=$?
  if [[ "$_HUBCODE_ZSH_COMMAND_ACTIVE" == "1" ]]; then
    _hubcode_osc633 "D;${command_status}"
    _HUBCODE_ZSH_COMMAND_ACTIVE=0
  fi
  printf '\e]2;%s\a' "${PWD/#$HOME/~}"
  _hubcode_osc633 "A"
}

function _hubcode_preexec() {
  _HUBCODE_ZSH_COMMAND_ACTIVE=1
  _hubcode_osc633 "B"
  _hubcode_osc633 "C"
  printf '\e]2;%s\a' "$1"
}

add-zsh-hook precmd _hubcode_precmd
add-zsh-hook preexec _hubcode_preexec
