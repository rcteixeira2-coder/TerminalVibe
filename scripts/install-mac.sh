#!/bin/sh
# Gera o Cockpit.app fora da Mesa (o iCloud adiciona metadados que quebram a assinatura) e instala em ~/Applications.
set -eu
cd "$(dirname "$0")/.."
OUT="${TMPDIR:-/tmp}/cockpit-release"
rm -rf "$OUT"
npx electron-vite build
npx electron-builder --mac --dir -c.directories.output="$OUT"
APP="$OUT/mac-arm64/Cockpit.app"
codesign --verify --deep --strict "$APP"
DEST="$HOME/Applications/Cockpit.app"
mkdir -p "$HOME/Applications"
if [ "${1:-}" != "--no-install" ]; then
  rm -rf "$DEST.old"
  [ -d "$DEST" ] && mv "$DEST" "$DEST.old"
  ditto --norsrc --noextattr "$APP" "$DEST"
  codesign --verify --deep --strict "$DEST"
  rm -rf "$DEST.old"
  echo "Instalado em $DEST"
  # Cópia também na pasta do projeto, para abrir direto daqui (o iCloud marca metadados nela;
  # o app abre normalmente, mas a cópia "oficial" assinada é a de ~/Applications).
  rm -rf ./Cockpit.app
  ditto --norsrc --noextattr "$DEST" ./Cockpit.app
  echo "Cópia em $(pwd)/Cockpit.app"
else
  echo "Gerado em $APP"
fi
