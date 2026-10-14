#!/bin/zsh
set -euo pipefail

# Keep the receiver standalone: the MacBook needs only the tools shipped with macOS.
state="${PASEO_LOCAL_MIRROR_HOME:-$HOME/Library/Application Support/Paseo Local Mirror}"
folder="${PASEO_LOCAL_MIRROR_FOLDER:-$HOME/Library/Mobile Documents/com~apple~CloudDocs/Paseo Local}"
target="${PASEO_LOCAL_MIRROR_TARGET:-$HOME/Applications/Paseo Local.app}"
label="sh.paseo.local-icloud-mirror"
self="${0:A}"
work=""
backup=""

log() { print -r -- "[$(/bin/date -u +%FT%TZ)] $*"; }
cleanup() {
  if [[ -n "$backup" && -d "$backup" && ! -e "$target" ]]; then
    /bin/mv "$backup" "$target"
  fi
  [[ -z "$work" ]] || /bin/rm -rf "$work"
}
trap cleanup EXIT

validate_bundle() {
  local bundle="$1"
  [[ "$(/usr/bin/plutil -extract CFBundleIdentifier raw -o - "$bundle/Contents/Info.plist")" == "sh.paseo.desktop.local" ]]
  /usr/bin/codesign --verify --deep --strict "$bundle"
}

bundle_hash() {
  /usr/bin/codesign -dv --verbose=4 "$1" 2>&1 | /usr/bin/sed -n 's/^CDHash=//p'
}

publish() {
  local source="$1"
  validate_bundle "$source"
  local signature="$(bundle_hash "$source")"
  [[ "$signature" =~ '^[a-f0-9]{40,64}$' ]]
  /bin/mkdir -p "$folder"
  work="$(/usr/bin/mktemp -d "$state/publish.XXXXXX")"
  /usr/bin/ditto -c -k --sequesterRsrc --keepParent "$source" "$work/app.zip"
  [[ "$(bundle_hash "$source")" == "$signature" ]] || { log "Build changed during archiving; retrying later"; return 1; }
  local digest="$(/usr/bin/shasum -a 256 "$work/app.zip")"
  digest="${digest%% *}"
  # Immutable archives let a receiver finish downloading an older build safely.
  /bin/cp "$work/app.zip" "$folder/.$digest.$$.zip"
  /bin/mv "$folder/.$digest.$$.zip" "$folder/$digest.zip"
  # macOS can protect existing iCloud .command files from LaunchAgents. The receiver
  # reads latest.sha256, so publishing a new bundle never requires replacing its installer.
  if [[ ! -e "$folder/Install on MacBook.command" ]]; then
    /bin/cp "$self" "$folder/.Install on MacBook.$$.command"
    /bin/chmod +x "$folder/.Install on MacBook.$$.command"
    /bin/mv "$folder/.Install on MacBook.$$.command" "$folder/Install on MacBook.command"
  fi
  print -r -- "$digest" > "$folder/.latest.$$.sha256"
  /bin/mv "$folder/.latest.$$.sha256" "$folder/latest.sha256"
  print -r -- "$signature" > "$state/.published.$$"
  /bin/mv "$state/.published.$$" "$state/published.cdhash"
  log "Published $digest to $folder"
}

is_running() {
  local processes="$(/bin/ps -ww -axo command=)"
  [[ "$processes" == *"$target/Contents/"* ]]
}

receive() {
  [[ -f "$folder/latest.sha256" ]] || { log "Waiting for an iCloud build"; return; }
  local digest="$(/bin/cat "$folder/latest.sha256")"
  [[ "$digest" =~ '^[a-f0-9]{64}$' ]] || { log "Invalid build checksum"; return 1; }
  if [[ -d "$target" && -f "$state/installed.sha256" && "$(/bin/cat "$state/installed.sha256")" == "$digest" ]]; then
    log "Already installed $digest"
    return
  fi
  if is_running; then log "Paseo Local is running; update deferred"; return; fi
  [[ -f "$folder/$digest.zip" ]] || { log "Waiting for the archive to sync"; return; }
  /bin/mkdir -p "${target:h}"
  work="$(/usr/bin/mktemp -d "${target:h}/.paseo-mirror.XXXXXX")"
  # Reading into local staging hydrates iCloud placeholders and isolates validation.
  /bin/cp "$folder/$digest.zip" "$work/app.zip"
  local actual="$(/usr/bin/shasum -a 256 "$work/app.zip")"
  [[ "${actual%% *}" == "$digest" ]] || { log "Incomplete or corrupt archive; retrying later"; return 1; }
  /usr/bin/ditto -x -k "$work/app.zip" "$work"
  local bundle="$work/Paseo Local.app"
  # The build output is named Paseo.app; installed source bundles are Paseo Local.app.
  [[ -d "$bundle" ]] || bundle="$work/Paseo.app"
  validate_bundle "$bundle"
  if is_running; then log "Paseo Local started; update deferred"; return; fi
  backup="${target}.mirror-backup"
  [[ ! -e "$backup" ]] || { log "Previous backup exists: $backup; restore it before retrying"; return 1; }
  [[ ! -e "$target" ]] || /bin/mv "$target" "$backup"
  /bin/mv "$bundle" "$target"
  /bin/rm -rf "$backup"
  backup=""
  print -r -- "$digest" > "$state/.installed.$$"
  /bin/mv "$state/.installed.$$" "$state/installed.sha256"
  log "Installed $target ($digest)"
}

xml() {
  print -rn -- "$1" | /usr/bin/sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' -e 's/"/\&quot;/g' -e "s/'/\&apos;/g"
}

install_agent() {
  local mode="$1"
  [[ "$(/usr/bin/uname -m)" == arm64 ]] || { log "This build requires Apple Silicon"; return 1; }
  local runtime="$state/mirror.command"
  local plist="$HOME/Library/LaunchAgents/$label.plist"
  local output="$HOME/Library/Logs/$label.log"
  local domain="gui/$(/usr/bin/id -u)"
  /bin/mkdir -p "${plist:h}" "${output:h}"
  /bin/cp "$self" "$runtime.tmp"
  /bin/mv "$runtime.tmp" "$runtime"
  /bin/cat > "$plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>$label</string>
<key>ProgramArguments</key><array><string>/bin/zsh</string><string>$(xml "$runtime")</string><string>$mode</string></array>
<key>EnvironmentVariables</key><dict>
<key>PASEO_LOCAL_MIRROR_HOME</key><string>$(xml "$state")</string>
<key>PASEO_LOCAL_MIRROR_FOLDER</key><string>$(xml "$folder")</string>
<key>PASEO_LOCAL_MIRROR_TARGET</key><string>$(xml "$target")</string>
</dict>
<key>RunAtLoad</key><true/>
<key>StartInterval</key><integer>300</integer>
<key>StandardOutPath</key><string>$(xml "$output")</string>
<key>StandardErrorPath</key><string>$(xml "$output")</string>
</dict></plist>
EOF
  /usr/bin/plutil -lint "$plist"
  if /bin/launchctl print "$domain/$label" >/dev/null 2>&1; then
    /bin/launchctl bootout "$domain/$label"
  fi
  /bin/launchctl bootstrap "$domain" "$plist"
  log "Automatic updates enabled. Log: $output"
}

uninstall_agent() {
  local domain="gui/$(/usr/bin/id -u)"
  if /bin/launchctl print "$domain/$label" >/dev/null 2>&1; then
    /bin/launchctl bootout "$domain/$label"
  fi
  /bin/rm -f "$HOME/Library/LaunchAgents/$label.plist"
}

locked() {
  local result=0
  /usr/bin/lockf -k -s -t 0 "$state/mirror.lock" /bin/zsh "$self" "$@" || result=$?
  [[ "$result" == 75 ]] && return 0
  return "$result"
}

[[ "$(/usr/bin/uname -s)" == Darwin ]] || { log "macOS required"; exit 1; }
/bin/mkdir -p "$state"
case "${1:-install}" in
  enable-publisher)
    [[ -d "${folder:h}" ]] || { log "Enable iCloud Drive on this Mac first"; exit 1; }
    [[ ! -f "$HOME/Library/LaunchAgents/$label.plist" ]] || { log "This Mac is already a receiver"; exit 1; }
    locked publish-locked "${2:-$target}"
    print -r -- "$folder" > "$state/publisher-folder"
    label="sh.paseo.local-icloud-publisher"
    install_agent publish-if-enabled
    ;;
  disable-publisher)
    label="sh.paseo.local-icloud-publisher"
    uninstall_agent
    /bin/rm -f "$state/publisher-folder"
    ;;
  publish-if-enabled)
    [[ -f "$state/publisher-folder" ]] || exit 0
    folder="$(/bin/cat "$state/publisher-folder")"
    export PASEO_LOCAL_MIRROR_FOLDER="$folder"
    locked publish-if-changed-locked "${2:-$target}"
    ;;
  publish-if-changed-locked)
    source="${2:-$target}"
    if [[ -f "$state/published.cdhash" && "$(bundle_hash "$source")" == "$(/bin/cat "$state/published.cdhash")" ]]; then
      log "Already published this build"
    else
      publish "$source"
    fi
    ;;
  publish) locked publish-locked "${2:-$target}" ;;
  publish-locked) publish "${2:-$target}" ;;
  install)
    [[ ! -f "$state/publisher-folder" ]] || { log "This Mac is already the publisher"; exit 1; }
    [[ ! -f "$HOME/Library/LaunchAgents/sh.paseo.local-auto-build.plist" ]] || {
      log "Uninstall the local auto-builder on this Mac before enabling the mirror"; exit 1;
    }
    install_agent run
    ;;
  run) locked receive-locked ;;
  receive-locked) receive ;;
  uninstall)
    uninstall_agent
    log "Automatic updates disabled; app and downloaded builds kept"
    ;;
  *) log "Usage: $self [install|uninstall|enable-publisher|disable-publisher|publish|run]"; exit 1 ;;
esac
