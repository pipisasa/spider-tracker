#!/bin/sh
# Installs the Spider Tracker CLI (spider) from GitHub releases.
#
#   curl -fsSL https://tracker.batele.plus/install.sh | sh
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
  url="https://github.com/$REPO/releases/download/$SPIDER_VERSION/$asset"
else
  url="https://github.com/$REPO/releases/latest/download/$asset"
fi

tmp="$(mktemp "${TMPDIR:-/tmp}/spider.XXXXXX")"
trap 'rm -f "$tmp"' EXIT INT TERM

echo "Downloading $url"
if command -v curl >/dev/null 2>&1; then
  curl -fsSL "$url" -o "$tmp" || fail "download failed: $url"
elif command -v wget >/dev/null 2>&1; then
  wget -q "$url" -O "$tmp" || fail "download failed: $url"
else
  fail "curl or wget is required"
fi

[ -s "$tmp" ] || fail "downloaded file is empty: $url"
chmod 755 "$tmp"
if [ "$os" = darwin ]; then
  xattr -d com.apple.quarantine "$tmp" 2>/dev/null || true
fi
"$tmp" --version >/dev/null 2>&1 || fail "the downloaded binary does not run on this machine"

mkdir -p "$INSTALL_DIR"
mv -f "$tmp" "$INSTALL_DIR/spider"
trap - EXIT INT TERM

echo "Installed spider $("$INSTALL_DIR/spider" --version) to $INSTALL_DIR/spider"

case ":$PATH:" in
  *":$INSTALL_DIR:"*) ;;
  *)
    echo
    echo "$INSTALL_DIR is not on your PATH. Add it, e.g. in ~/.zshrc or ~/.bashrc:"
    echo "  export PATH=\"$INSTALL_DIR:\$PATH\""
    ;;
esac
