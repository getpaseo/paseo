# Shell profile for the demo terminal: a Pure-style two-line prompt that fits a
# phone-width terminal, and vitest output without the absolute checkout path
# or the long timing breakdown. Vitest drops its colors when piped, so the
# wrapper puts its usual green checks and grey timings back.
export FORCE_COLOR=1
__where() { local top; top=$(git rev-parse --show-toplevel 2>/dev/null); printf '~/paseo%s' "${PWD#"$top"}"; }
__branch() { git branch --show-current 2>/dev/null; }
__dirty() { [ -n "$(git status --porcelain 2>/dev/null)" ] && printf '*'; }
PROMPT_COMMAND='printf "\e]0;zsh\a"'
PS1='\n\[\e[34m\]$(__where)\[\e[0m\] \[\e[90m\]$(__branch)$(__dirty)\[\e[0m\]\n\[\e[35m\]❯\[\e[0m\] '
npx() {
  command npx "$@" 2>&1 | sed -E \
    -e '1{/^$/d}' -e '/ RUN /d' -e '/Start at/d' -e 's/ \(transform.*\)//' \
    -e $'s/✓/\e[32m✓\e[0m/' \
    -e $'s/ ([0-9]+ms)$/ \e[90m\\1\e[0m/' \
    -e $'s/ (\\([0-9]+( tests)?\\))/ \e[90m\\1\e[0m/' \
    -e $'s/([0-9]+ passed)/\e[1;32m\\1\e[0m/'
}
clear
