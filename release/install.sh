#!/bin/sh
# Installs (or updates) Overhand: downloads the package for this machine from the latest release, checks its SHA-256
# (and, when cosign is installed, the release's signature on SHA256SUMS), unpacks it into its own folder in ~/.overhand/releases and points the ~/.overhand/app link at it in one rename, so an
# install is either complete or not there at all. Links `overhand` into ~/.local/bin, installs GitHub's command tool
# when it's missing, puts ~/.local/bin on PATH in the shell's startup file and starts Overhand, which opens the dashboard
# in the browser; a running Overhand sees its binary moved and restarts on the new one once no agent is running.
#   curl -fsSL https://get.overhand.dev | sh
# OVERHAND_DOWNLOAD points at another copy of the release files (a mirror, a test server), OVERHAND_GH_DOWNLOAD at
# another copy of gh's releases; OVERHAND_NO_START=1 installs without starting it (CI, images); OVERHAND_NO_PATH=1 edits
# no startup file; OVERHAND_QUIET=1 stops after the install lines (no gh, no PATH line), for `overhand update`, which
# says what happens next itself. NO_COLOR, or output that isn't a terminal, turns colour off.
# The whole script is one function called on the last line, so a download cut off part way runs nothing.
set -eu

main() {
DOWNLOAD="${OVERHAND_DOWNLOAD:-}"
NO_START="${OVERHAND_NO_START:-}"
QUIET="${OVERHAND_QUIET:-}"
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
sum256() { if command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | cut -d' ' -f1; else sha256sum "$1" | cut -d' ' -f1; fi; }
# every download over HTTPS with TLS 1.2 or later, redirects included, so a bad mirror or redirect fails closed; only a
# test server on this machine (file://, http://127.0.0.1 or localhost) named in OVERHAND_DOWNLOAD or
# OVERHAND_GH_DOWNLOAD may be plain
proto='=https'
for u in "$DOWNLOAD" "${OVERHAND_GH_DOWNLOAD:-}"; do
  case "$u" in file://* | http://127.0.0.1[:/]* | http://localhost[:/]*) proto='=https,http,file' ;; esac
done
get() { curl --proto "$proto" --tlsv1.2 "$@"; }
# who signs a release's SHA256SUMS (RELEASE_SIGNER in packages/contract/src/links.ts): this repository's release
# workflow, run for a version tag, which only an admin can push
SIGNER='^https://github\.com/craftly-io/overhand/\.github/workflows/release\.yml@refs/tags/v'

# GitHub's command tool (gh), which agents open pull requests through, installed the vendor's own way (cli.github.com,
# checked 2026-10-25): Homebrew on a Mac that has it, else GitHub's release for this Mac into ~/.local/bin; on Linux
# GitHub's apt or dnf repository, as root, which needs sudo that asks nothing here (the script came down a pipe, so
# there's no one to type a password); otherwise the one command to run. Anything else: the setup page links its docs.
GH_APT='mkdir -p -m 755 /etc/apt/keyrings /etc/apt/sources.list.d && curl --proto =https --tlsv1.2 -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli-archive-keyring.gpg && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list && apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y gh'
GH_DNF='curl --proto =https --tlsv1.2 -fsSL https://cli.github.com/packages/rpm/gh-cli.repo -o /etc/yum.repos.d/gh-cli.repo && dnf install -y gh --repo gh-cli'
install_gh() {
  if [ "$os" = darwin ]; then
    if command -v brew >/dev/null 2>&1; then brew install gh >"${tmp}/gh.log" 2>&1; else gh_release >"${tmp}/gh.log" 2>&1; fi
  else
    if command -v apt-get >/dev/null 2>&1; then root_cmd="$GH_APT"; elif command -v dnf >/dev/null 2>&1; then root_cmd="$GH_DNF"; else root_cmd=""; fi
    if [ -z "$root_cmd" ]; then false
    elif [ "$(id -u)" = 0 ]; then sh -c "$root_cmd" >"${tmp}/gh.log" 2>&1
    elif sudo -n true >/dev/null 2>&1; then sudo -n sh -c "$root_cmd" >"${tmp}/gh.log" 2>&1
    else
      note "GitHub's command tool (gh) needs an administrator to install. Run this, and the setup page goes on by itself:"
      printf '    %s%s%s\n' "$b" "sudo sh -c '${root_cmd}'" "$r"
      return 0
    fi
  fi && step "Installed GitHub's command tool (gh)" && return 0
  note "gh isn't installed yet; the setup page shows how to get it."
}
# GitHub's own build of gh for this Mac, from its latest release, checked against the release's checksums
gh_release() {
  rel="${OVERHAND_GH_DOWNLOAD:-https://github.com/cli/cli/releases}"
  tag="$(get -fsSLI -o /dev/null -w '%{url_effective}' "${rel}/latest")" || return 1
  tag="${tag##*/}"
  if [ "$arch" = x64 ]; then zip="gh_${tag#v}_macOS_amd64.zip"; else zip="gh_${tag#v}_macOS_arm64.zip"; fi
  get -fsSL "${rel}/download/${tag}/${zip}" -o "${tmp}/${zip}" || return 1
  get -fsSL "${rel}/download/${tag}/gh_${tag#v}_checksums.txt" -o "${tmp}/gh-sums" || return 1
  [ "$(grep " ${zip}\$" "${tmp}/gh-sums" | cut -d' ' -f1)" = "$(sum256 "${tmp}/${zip}")" ] || return 1
  unzip -q "${tmp}/${zip}" -d "${tmp}/gh" && mv "${tmp}/gh/${zip%.zip}/bin/gh" "${BIN}/gh"
}

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
  get -fL --progress-bar "${url}/${pkg}" -o "${tmp}/${pkg}" || fail "Download failed: ${url}/${pkg}. The installed Overhand is unchanged."
  printf '\033[1A\033[2K\033[1A\033[2K'
else
  get -fsSL "${url}/${pkg}" -o "${tmp}/${pkg}" || fail "Download failed: ${url}/${pkg}. The installed Overhand is unchanged."
fi
step "Downloaded ${pkg}"

get -fsSL "${url}/SHA256SUMS" -o "${tmp}/SHA256SUMS" || fail "Couldn't fetch SHA256SUMS. The installed Overhand is unchanged."
# with cosign 2.5 or newer installed, SHA256SUMS must carry the release workflow's signature (SIGNER), or nothing
# installs; an older cosign can't read the signature's format (it fails on every release), so it's skipped, said, and
# only the checksum below is checked, as without cosign
cosign_ok() {
  v="$(cosign version 2>/dev/null | sed -n 's/^GitVersion:[^0-9]*\([0-9][0-9]*\)\.\([0-9][0-9]*\).*/\1 \2/p' | head -n 1)"
  [ -n "$v" ] || return 1
  set -- $v
  [ "$1" -gt 2 ] || { [ "$1" -eq 2 ] && [ "$2" -ge 5 ]; }
}
if command -v cosign >/dev/null 2>&1 && ! cosign_ok; then
  step "cosign here is older than 2.5 and can't read the release's signature; checking the checksum only (update cosign to check it)"
elif command -v cosign >/dev/null 2>&1; then
  get -fsSL "${url}/SHA256SUMS.sigstore.json" -o "${tmp}/SHA256SUMS.sigstore.json" \
    || fail "Couldn't fetch the release's signature (SHA256SUMS.sigstore.json); not installing. The installed Overhand is unchanged."
  cosign verify-blob --bundle "${tmp}/SHA256SUMS.sigstore.json" --certificate-identity-regexp "$SIGNER" \
    --certificate-oidc-issuer https://token.actions.githubusercontent.com "${tmp}/SHA256SUMS" >"${tmp}/cosign.log" 2>&1 \
    || { cat "${tmp}/cosign.log" >&2; fail "SHA256SUMS isn't signed by Overhand's release workflow; not installing."; }
  step "Signature verified (Sigstore)"
fi
want="$(grep " ${pkg}\$" "${tmp}/SHA256SUMS" | cut -d' ' -f1)"
got="$(sum256 "${tmp}/${pkg}")"
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
if [ "$QUIET" = "1" ]; then return 0; fi

command -v git >/dev/null 2>&1 || note "git isn't installed yet; the setup page shows how to get it."
if ! command -v gh >/dev/null 2>&1; then install_gh; fi

# ~/.local/bin on PATH in every new terminal: one marked line in the shell's startup file, added once (never with
# OVERHAND_NO_PATH=1, for CI and tests), and on this script's own PATH, so the service it starts finds overhand, gh and
# agents installed there. This terminal keeps its PATH, so what's printed below runs ~/.local/bin/overhand by its path.
path_line=""
fresh=0
case ":${PATH}:" in
  *":${BIN}:"*) ;;
  *)
    fresh=1
    line="export PATH=\"\$HOME/.local/bin:\$PATH\""
    case "$(basename "${SHELL:-sh}")" in
      zsh) rc="${ZDOTDIR:-$HOME}/.zshrc" ;;
      bash) if [ "$os" = darwin ]; then rc="${HOME}/.bash_profile"; else rc="${HOME}/.bashrc"; fi ;;
      fish) rc="${XDG_CONFIG_HOME:-$HOME/.config}/fish/config.fish"; line="fish_add_path \$HOME/.local/bin" ;;
      *) rc="${HOME}/.profile" ;;
    esac
    case "$rc" in "$HOME"/*) rc_short="~${rc#"$HOME"}" ;; *) rc_short="$rc" ;; esac
    if [ "${OVERHAND_NO_PATH:-}" = "1" ]; then
      path_line="$line"
    elif ! grep -qs '\.local/bin' "$rc"; then
      if mkdir -p "$(dirname "$rc")" && printf '\n%s # added by Overhand\n' "$line" >>"$rc"; then
        step "Added ~/.local/bin to your PATH in ${rc_short}: new terminals find overhand"
      else
        path_line="$line"
      fi
    fi
    export PATH="${BIN}:${PATH}"
    ;;
esac
if [ "$fresh" = 1 ]; then cmd="~/.local/bin/overhand"; else cmd="overhand"; fi

if [ "$NO_START" = "1" ]; then
  head="Overhand is installed"
  tail="Start it with: ${cmd} start"
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
  # `overhand start` opens the dashboard, signed in, in this computer's browser when there is one
  if grep -q 'Opened ' "${tmp}/start.log"; then tail="It's open in your browser: finish setting up there."; else tail="Open it to finish setting up."; fi
  # no display (a server over SSH, a container): the address opens only through a tunnel from your own computer
  if [ -n "${SSH_CONNECTION:-}" ] || { [ "$os" = linux ] && [ -z "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]; }; then
    server="$(printf '%s' "${SSH_CONNECTION:-}" | cut -d' ' -f3)"
    if [ -n "$server" ]; then at="$(id -un)@${server}"; else at="you@your-server"; fi
    port="${OVERHAND_PORT:-4317}"
    tunnel="ssh -N -L ${port}:127.0.0.1:${port} ${at}"
    tail="Finish setting up from your own computer's browser:"
  fi
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

if [ -n "${tunnel:-}" ]; then
  printf '  1. On your own computer, open a tunnel to this one:\n'
  printf '    %s%s%s\n' "$b" "$tunnel" "$r"
  printf '  2. Here, run %s%s open%s and open the link it prints in that computer'"'"'s browser.\n\n' "$b" "$cmd" "$r"
fi

if [ -n "$path_line" ]; then
  printf '  ~/.local/bin isn'"'"'t on your PATH. Add this line to %s, then open a new terminal:\n' "$rc_short"
  printf '    %s%s%s\n\n' "$b" "$path_line" "$r"
fi
}

main "$@"
