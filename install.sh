#!/bin/sh
set -e

REPO="afumu/openlink"
BIN="openlink"
INSTALL_DIR="/usr/local/bin"

OS=$(uname -s | tr '[:upper:]' '[:lower:]')
ARCH=$(uname -m)
case "$ARCH" in
  x86_64) ARCH="amd64" ;;
  aarch64|arm64) ARCH="arm64" ;;
  *) echo "不支持的架构: $ARCH"; exit 1 ;;
esac

VERSION=$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" | grep '"tag_name"' | sed 's/.*"tag_name": *"\(.*\)".*/\1/')
if [ -z "$VERSION" ]; then
  echo "获取版本失败"; exit 1
fi

FILE="${BIN}_${OS}_${ARCH}.tar.gz"
URL="https://github.com/${REPO}/releases/download/${VERSION}/${FILE}"

echo "正在安装 openlink ${VERSION} (${OS}/${ARCH})..."
TMP=$(mktemp -d)
curl -fsSL "$URL" | tar -xz -C "$TMP"

if [ -w "$INSTALL_DIR" ]; then
  mv "$TMP/$BIN" "$INSTALL_DIR/$BIN"
else
  sudo mv "$TMP/$BIN" "$INSTALL_DIR/$BIN"
fi
rm -rf "$TMP"

echo "安装完成: $(which $BIN)"
echo "运行 'openlink' 启动服务"
