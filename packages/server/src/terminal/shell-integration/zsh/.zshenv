typeset -g HUBCODE_SHELL_INTEGRATION_DIR="${${(%):-%N}:A:h}"

if [[ -n "${HUBCODE_ZSH_ZDOTDIR-}" ]]; then
  export ZDOTDIR="${HUBCODE_ZSH_ZDOTDIR}"
else
  unset ZDOTDIR
fi

if [[ -n "${ZDOTDIR-}" ]]; then
  if [[ -f "${ZDOTDIR}/.zshenv" ]]; then
    source "${ZDOTDIR}/.zshenv"
  fi
elif [[ -f "${HOME}/.zshenv" ]]; then
  source "${HOME}/.zshenv"
fi

source "${HUBCODE_SHELL_INTEGRATION_DIR}/hubcode-integration.zsh"
