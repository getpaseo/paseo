typeset -g PASEO_SHELL_INTEGRATION_DIR="${${(%):-%N}:A:h}"

# Announce the integration before anything else, and before the user's own
# rc files are sourced below. The daemon cannot otherwise tell "this shell has
# no Paseo integration, so no readiness marker is ever coming" apart from
# "the integration is loaded but startup is blocked waiting for input" — both
# look like silence. This line is the difference: zsh sources our wrapper
# before the user's .zshenv and .zshrc, so nothing a user configures can delay
# it. Silence here means no integration; silence *after* it means blocked.
#
# Only announce when we can actually deliver: zle-line-init reporting needs
# add-zle-hook-widget (zsh 5.3+). Announcing without delivering would strand
# every script on the readiness timeout. See docs/terminal-readiness.md.
if [[ -o interactive ]] && [[ -n "${PASEO_TERMINAL_NONCE-}" ]]; then
  autoload -Uz is-at-least
  if is-at-least 5.3; then
    printf '\e]633;I;%s\a' "${PASEO_TERMINAL_NONCE}"
  fi
fi

if [[ -n "${PASEO_ZSH_ZDOTDIR-}" ]]; then
  export ZDOTDIR="${PASEO_ZSH_ZDOTDIR}"
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

source "${PASEO_SHELL_INTEGRATION_DIR}/paseo-integration.zsh"
