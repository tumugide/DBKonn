#!/bin/bash
set -euo pipefail

DMG_NAME="DBKonn_0.1.0_aarch64.dmg"
APP_NAME="DBKonn"
INSTALL_DIR="/Applications"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DMG_PATH="$SCRIPT_DIR/appbuilds/$DMG_NAME"

if [ ! -f "$DMG_PATH" ]; then
  echo "Error: $DMG_NAME not found at $DMG_PATH"
  echo "Download the .dmg and place it in appbuilds/"
  exit 1
fi

echo "Mounting $DMG_NAME..."
MOUNT_OUTPUT=$(hdiutil attach "$DMG_PATH" -nobrowse 2>&1)
MOUNT_POINT=$(echo "$MOUNT_OUTPUT" | grep -E '/Volumes/DBKonn' | awk '{print $NF}')

if [ -z "$MOUNT_POINT" ]; then
  echo "Error: Could not find mount point"
  echo "$MOUNT_OUTPUT"
  exit 1
fi

echo "Copying $APP_NAME to $INSTALL_DIR..."
cp -R "$MOUNT_POINT/$APP_NAME.app" "$INSTALL_DIR/"

echo "Removing quarantine attribute..."
if ! xattr -cr "$INSTALL_DIR/$APP_NAME.app" 2>/dev/null; then
  echo "Note: xattr failed (app may need code signing). Trying alternative..."
  sudo xattr -cr "$INSTALL_DIR/$APP_NAME.app" 2>/dev/null || true
fi

echo "Unmounting..."
hdiutil detach "$MOUNT_POINT" -quiet

echo "Done! $APP_NAME is installed in $INSTALL_DIR"
echo "You can now open it normally from Applications or Spotlight."
