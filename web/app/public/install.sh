#!/bin/sh
# Installs the Spider Tracker CLI (spider) from GitHub releases.
#
#   curl --proto '=https' --tlsv1.2 -fsSL https://tracker.batele.plus/install.sh | sh
#
# SPIDER_INSTALL_DIR  where to put the binary (default: $HOME/.local/bin)
# SPIDER_VERSION      release tag to install, e.g. cli-v0.1.0 (default: latest)
set -eu

REPO="pipisasa/spider-tracker"
INSTALL_DIR="${SPIDER_INSTALL_DIR:-$HOME/.local/bin}"

fail() {
  echo "spider install: $*" >&2
  exit 1
}

case "$(uname -s)" in
  Darwin) os=darwin ;;
  Linux) os=linux ;;
  *) fail "unsupported OS: $(uname -s) (supported: macOS, Linux)" ;;
esac

case "$(uname -m)" in
  arm64 | aarch64) arch=arm64 ;;
  x86_64 | amd64) arch=x64 ;;
  *) fail "unsupported CPU: $(uname -m) (supported: arm64, x64)" ;;
esac

asset="spider-$os-$arch"
if [ -n "${SPIDER_VERSION:-}" ]; then
  base="https://github.com/$REPO/releases/download/$SPIDER_VERSION"
else
  base="https://github.com/$REPO/releases/latest/download"
fi
url="$base/$asset"

if command -v curl >/dev/null 2>&1; then
  download() { curl --proto '=https' --tlsv1.2 -fsSL "$1" -o "$2"; }
elif command -v wget >/dev/null 2>&1; then
  # BusyBox wget has no --https-only.
  if wget --help 2>&1 | grep -q -- '--https-only'; then
    download() { wget -q --https-only "$1" -O "$2"; }
  else
    download() { wget -q "$1" -O "$2"; }
  fi
else
  fail "curl or wget is required"
fi

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d ' ' -f 1
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | cut -d ' ' -f 1
  else
    return 1
  fi
}

tmp=""
sums=""
cleanup() {
  if [ -n "$tmp" ]; then rm -f "$tmp"; fi
  if [ -n "$sums" ]; then rm -f "$sums"; fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# Download next to the target so the final mv is an atomic rename.
mkdir -p "$INSTALL_DIR"
tmp="$(mktemp "$INSTALL_DIR/.spider.XXXXXX")"
sums="$(mktemp "$INSTALL_DIR/.spider-sums.XXXXXX")"

echo "Downloading $url"
download "$url" "$tmp" || fail "download failed: $url"
[ -s "$tmp" ] || fail "downloaded file is empty: $url"

# Releases before cli-v0.1.3 have no SHA256SUMS.
if download "$base/SHA256SUMS" "$sums" 2>/dev/null; then
  expected="$(awk -v f="$asset" '$2 == f || $2 == "*" f { print $1; exit }' "$sums")"
  [ -n "$expected" ] || fail "$asset is not listed in $base/SHA256SUMS"
  actual="$(sha256 "$tmp")" || fail "sha256sum or shasum is required to verify the download"
  [ "$actual" = "$expected" ] || fail "checksum mismatch for $asset (expected $expected, got $actual)"
else
  echo "spider install: warning: $base/SHA256SUMS not found; skipping checksum verification" >&2
fi

chmod 755 "$tmp"
if [ "$os" = darwin ]; then
  xattr -d com.apple.quarantine "$tmp" 2>/dev/null || true
fi
"$tmp" --version >/dev/null 2>&1 || fail "the downloaded binary does not run on this machine"

mv -f "$tmp" "$INSTALL_DIR/spider"
tmp=""

echo "Installed spider $("$INSTALL_DIR/spider" --version) to $INSTALL_DIR/spider"

case ":$PATH:" in
  *":$INSTALL_DIR:"*) ;;
  *)
    echo
    echo "$INSTALL_DIR is not on your PATH. Add it, e.g. in ~/.zshrc or ~/.bashrc:"
    echo "  export PATH=\"$INSTALL_DIR:\$PATH\""
    ;;
esac
