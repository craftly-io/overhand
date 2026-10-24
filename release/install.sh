#!/bin/sh
# Installs (or updates) Overhand: downloads the package for this machine from the latest release, checks its SHA-256,
# unpacks it into its own folder in ~/.overhand/releases and points the ~/.overhand/app link at it in one rename, so an
# install is either complete or not there at all. Links `overhand` into ~/.local/bin and starts it; a running Overhand
# sees its binary moved and restarts on the new one once no agent is running.
#   curl -fsSL https://get.overhand.dev | sh
# OVERHAND_DOWNLOAD points at another copy of the release files (a mirror, a test server);
# OVERHAND_NO_START=1 installs without starting it (CI, images). NO_COLOR, or output that isn't a terminal, turns colour off.
# The whole script is one function called on the last line, so a download cut off part way runs nothing.
set -eu

main() {
DOWNLOAD="${OVERHAND_DOWNLOAD:-}"
NO_START="${OVERHAND_NO_START:-}"
APP="${HOME}/.overhand/app"
RELEASES="${HOME}/.overhand/releases"
BIN="${HOME}/.local/bin"
URL_UI="http://127.0.0.1:${OVERHAND_PORT:-4317}"

# colour only on a terminal, and never with NO_COLOR set
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  b="$(printf '\033[1m')"; d="$(printf '\033[2m')"; ok="$(printf '\033[32m')"; warn="$(printf '\033[33m')"
  bad="$(printf '\033[31m')"; hi="$(printf '\033[34m')"; r="$(printf '\033[0m')"; tty=1
else
  b=""; d=""; ok=""; warn=""; bad=""; hi=""; r=""; tty=0
fi
step() { printf '  %s✓%s %s\n' "$ok" "$r" "$1"; }
note() { printf '  %s!%s %s\n' "$warn" "$r" "$1"; }
fail() { printf '  %s✗%s %s\n' "$bad" "$r" "$1" >&2; exit 1; }

printf '\n  %s◆ Overhand%s %sinstaller%s\n\n' "$b$hi" "$r" "$d" "$r"

case "$(uname -s)" in
  Darwin) os=darwin ;;
  Linux) os=linux ;;
  *) fail "Overhand runs on macOS and Linux; this is $(uname -s)." ;;
esac
case "$(uname -m)" in
  arm64 | aarch64) arch=arm64 ;;
  x86_64 | amd64) arch=x64 ;;
  *) fail "No Overhand build for $(uname -m) yet." ;;
esac
# a terminal running under Rosetta says x86_64 on an Apple silicon Mac, where the arm64 build is the right one
if [ "$os" = darwin ] && [ "$arch" = x64 ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || true)" = 1 ]; then arch=arm64; fi
# Alpine and other musl systems can't run the Linux builds, which need glibc
if [ "$os" = linux ] && { ldd --version 2>&1 | grep -qi musl || ls /lib/ld-musl-* >/dev/null 2>&1; }; then
  fail "This Linux uses musl (Alpine, for example), and Overhand's Linux builds need glibc. Install it on a glibc system such as Debian or Ubuntu."
fi
step "This machine: ${os}/${arch}"

pkg="overhand-${os}-${arch}.tar.gz"
url="${DOWNLOAD:-https://get.overhand.dev/download/latest}"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

# a progress bar on a terminal, quiet otherwise
if [ "$tty" = 1 ]; then
  printf '  %s↓%s Downloading %s\n' "$hi" "$r" "$pkg"
  curl -fL --progress-bar "${url}/${pkg}" -o "${tmp}/${pkg}" || fail "Download failed: ${url}/${pkg}. The installed Overhand is unchanged."
  printf '\033[1A\033[2K\033[1A\033[2K'
else
  curl -fsSL "${url}/${pkg}" -o "${tmp}/${pkg}" || fail "Download failed: ${url}/${pkg}. The installed Overhand is unchanged."
fi
step "Downloaded ${pkg}"

curl -fsSL "${url}/SHA256SUMS" -o "${tmp}/SHA256SUMS" || fail "Couldn't fetch SHA256SUMS. The installed Overhand is unchanged."
want="$(grep " ${pkg}\$" "${tmp}/SHA256SUMS" | cut -d' ' -f1)"
if command -v shasum >/dev/null 2>&1; then got="$(shasum -a 256 "${tmp}/${pkg}" | cut -d' ' -f1)"; else got="$(sha256sum "${tmp}/${pkg}" | cut -d' ' -f1)"; fi
if [ -z "$want" ] || [ "$want" != "$got" ]; then fail "Checksum mismatch for ${pkg}; not installing."; fi
step "Checksum verified"

# Unpacks beside the live install, checks the new binary runs, then swaps the app link in one rename. Until the swap the
# installed Overhand is untouched; on any failure the new folder is removed again.
mkdir -p "$RELEASES" "$BIN"
new="${RELEASES}/$(printf '%s' "$got" | cut -c1-12)"
part="${new}.part"
prev="$(readlink "$APP" 2>/dev/null || true)"
if [ "$prev" != "$new" ]; then
  rm -rf "$part"
  mkdir "$part"
  tar -xzf "${tmp}/${pkg}" -C "$part" || { rm -rf "$part"; fail "Couldn't unpack ${pkg}; the installed Overhand is unchanged."; }
  "${part}/overhand" version >/dev/null 2>&1 || { rm -rf "$part"; fail "The new overhand doesn't run on this machine; the installed Overhand is unchanged."; }
  rm -rf "$new"
  mv "$part" "$new"
  # an install from before releases/ has a real folder at ~/.overhand/app: it moves aside for the link (and back on failure)
  if [ -d "$APP" ] && [ ! -L "$APP" ]; then
    prev="${RELEASES}/previous"
    rm -rf "$prev"
    mv "$APP" "$prev"
  fi
  ln -s "$new" "${APP}.next"
  # rename over the old link without following it: GNU and busybox mv take -T, macOS mv takes -h
  if ! { mv -T "${APP}.next" "$APP" 2>/dev/null || mv -h "${APP}.next" "$APP" 2>/dev/null; }; then
    rm -f "${APP}.next"
    if [ "$prev" = "${RELEASES}/previous" ]; then mv "$prev" "$APP"; fi
    rm -rf "$new"
    fail "Couldn't switch ~/.overhand/app to the new version; the installed Overhand is unchanged."
  fi
  # keeps the new version and the one before it, which a running Overhand uses until it restarts
  for old in "$RELEASES"/*; do
    if [ "$old" != "$new" ] && [ "$old" != "$prev" ]; then rm -rf "$old"; fi
  done
fi
ln -sf "${APP}/overhand" "${BIN}/overhand"
version="$("${APP}/overhand" version 2>/dev/null || true)"
step "Installed Overhand ${version} at ~/.local/bin/overhand"

for tool in git gh; do
  command -v "$tool" >/dev/null 2>&1 || note "${tool} isn't installed yet; the setup page shows how to get it."
done

path_line=""
case ":${PATH}:" in
  *":${BIN}:"*) ;;
  *)
    # the exact line for the user's shell, so `overhand` works in every new terminal
    case "$(basename "${SHELL:-sh}")" in
      zsh) rc="~/.zshrc"; line="export PATH=\"\$HOME/.local/bin:\$PATH\"" ;;
      bash) if [ "$os" = darwin ]; then rc="~/.bash_profile"; else rc="~/.bashrc"; fi; line="export PATH=\"\$HOME/.local/bin:\$PATH\"" ;;
      fish) rc="~/.config/fish/config.fish"; line="fish_add_path \$HOME/.local/bin" ;;
      *) rc="your shell's startup file"; line="export PATH=\"\$HOME/.local/bin:\$PATH\"" ;;
    esac
    path_line="$line"
    ;;
esac

if [ "$NO_START" = "1" ]; then
  head="Overhand is installed"
  # until a new terminal picks up the PATH line below, only the full path runs
  if [ -n "$path_line" ]; then tail="Start it with: ~/.local/bin/overhand start"; else tail="Start it with: overhand start"; fi
elif [ -n "$prev" ] && [ "$prev" != "$new" ] && curl -s -o /dev/null --max-time 2 "${URL_UI}/" 2>/dev/null; then
  # an update while Overhand runs: it sees its binary moved, and restarts on the new one between work passes
  head="Overhand ${version} is installed"
  tail="The running Overhand restarts on it once no agent is running."
else
  "${APP}/overhand" start >"${tmp}/start.log" 2>&1 || { cat "${tmp}/start.log" >&2; fail "Overhand didn't start."; }
  step "Started"
  # e.g. no systemd user session (a container, WSL): it runs in the background until a reboot
  grep '^Note: ' "${tmp}/start.log" | sed 's/^Note: //' | while IFS= read -r line; do note "$line"; done
  head="Overhand is running → ${URL_UI}"
  tail="Open it to finish setting up."
fi

# the final box, sized to its longest line (the arrow is one character, though three bytes; wc -m counts bytes in a
# C locale, as in a bare container, so it's swapped for one byte first)
len() { printf '%s' "$1" | sed 's/→/>/g' | wc -c | tr -d ' '; }
pad() { printf '%*s' $(($2 - $(len "$1"))) ''; }
w="$(len "$head")"; [ "$(len "$tail")" -gt "$w" ] && w="$(len "$tail")"
bar="$(printf '%*s' $((w + 2)) '' | tr ' ' '-')"
printf '\n  %s+%s+%s\n' "$d" "$bar" "$r"
printf '  %s|%s %s%s%s%s %s|%s\n' "$d" "$r" "$b" "$head" "$r" "$(pad "$head" "$w")" "$d" "$r"
printf '  %s|%s %s%s %s|%s\n' "$d" "$r" "$tail" "$(pad "$tail" "$w")" "$d" "$r"
printf '  %s+%s+%s\n\n' "$d" "$bar" "$r"

if [ -n "$path_line" ]; then
  printf '  ~/.local/bin isn'"'"'t on your PATH. Add this line to %s, then open a new terminal:\n' "$rc"
  printf '    %s%s%s\n\n' "$b" "$path_line" "$r"
fi
}

main "$@"
