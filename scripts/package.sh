#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

target="${1:-all}"
case "$target" in
    all) platforms=(linux win32) ;;
    linux) platforms=(linux) ;;
    windows) platforms=(win32) ;;
    mac) platforms=(darwin) ;;
    *) echo "Usage: npm run package -- [all|linux|windows|mac]" >&2; exit 2 ;;
esac

arch=x64
if [[ "$target" == mac ]]; then
    if [[ "$(uname -s)" != Darwin ]]; then
        echo "Build the macOS archive on a Mac to sign the app bundle." >&2
        exit 2
    fi
    if [[ "$(uname -m)" == arm64 ]]; then
        arch=arm64
    fi
fi

mkdir -p dist
staging="$(mktemp -d "$PWD/dist/.package.XXXXXXXX")"
trap 'rm -rf -- "$staging"' EXIT

app_dir="$staging/app"
mkdir "$app_dir"
cp -R package.json package-lock.json src "$app_dir/"
mkdir -p "$app_dir/assets/desktop"
cp assets/desktop/moodleboss.png "$app_dir/assets/desktop/"
npm ci --prefix "$app_dir" --omit=dev --ignore-scripts --no-audit --no-fund

version="$(node -p "require('./package.json').version")"
for platform in "${platforms[@]}"; do
    # Use the same downloader, release checksums, and cache as Electron's npm installer.
    electron_zip="$(node - "$platform" "$arch" <<'JS'
const { createRequire } = require('node:module');
const electronRequire = createRequire(require.resolve('electron/package.json'));
const { downloadArtifact } = electronRequire('@electron/get');

downloadArtifact({
  version: electronRequire('./package.json').version,
  artifactName: 'electron',
  platform: process.argv[2],
  arch: process.argv[3],
  checksums: electronRequire('./checksums.json'),
  cacheRoot: process.env.electron_config_cache,
}).then(
  zip => console.log(zip),
  error => { console.error(error); process.exitCode = 1; },
);
JS
)"
    if [[ "$platform" == darwin ]]; then
        name="MoodleBOSS-$version-macos-$arch"
        bundle="$staging/$name"
        unzip -q "$electron_zip" -d "$bundle"
        mac_app="$bundle/MoodleBOSS.app"
        mv "$bundle/Electron.app" "$mac_app"
        resources="$mac_app/Contents/Resources"
        rm -f "$resources/default_app.asar"
        cp -R "$app_dir" "$resources/app"
        cp assets/desktop/moodleboss.icns "$resources/moodleboss.icns"
        plist="$mac_app/Contents/Info.plist"
        /usr/libexec/PlistBuddy -c 'Set :CFBundleDisplayName MoodleBOSS' -c 'Set :CFBundleName MoodleBOSS' \
            -c 'Set :CFBundleIdentifier com.bizzomephisto.moodleboss' -c 'Set :CFBundleIconFile moodleboss.icns' \
            -c "Set :CFBundleShortVersionString $version" -c "Set :CFBundleVersion $version" "$plist"
        codesign --force --deep --sign - --preserve-metadata=entitlements "$mac_app"
        codesign --verify --deep --strict "$mac_app"
        ditto -c -k --keepParent "$mac_app" "$staging/$name.zip"
        mv -f "$staging/$name.zip" "dist/$name.zip"
        printf 'Built dist/%s.zip\n' "$name"
        continue
    fi
    name="MoodleBOSS-$version-linux-x64"
    if [[ "$platform" == win32 ]]; then
        name="MoodleBOSS-$version-windows-x64"
    fi

    bundle="$staging/$name"
    unzip -q "$electron_zip" -d "$bundle"
    rm -f "$bundle/resources/default_app.asar"
    cp -R "$app_dir" "$bundle/resources/app"
    cp README.md "$bundle/README.md"

    if [[ "$platform" == win32 ]]; then
        mv "$bundle/electron.exe" "$bundle/MoodleBOSS.exe"
        mv "$bundle/electron_wer.dll" "$bundle/MoodleBOSS_wer.dll"
        node scripts/windows-icon.cjs "$bundle/MoodleBOSS.exe" assets/desktop/moodleboss.ico
        archive="$name.zip"
        (cd "$staging" && zip -qr "$archive" "$name")
    else
        mv "$bundle/electron" "$bundle/MoodleBOSS"
        cp scripts/install-desktop.sh "$bundle/"
        archive="$name.tar.gz"
        tar -C "$staging" -czf "$staging/$archive" "$name"
    fi

    mv -f "$staging/$archive" "dist/$archive"
    printf 'Built dist/%s\n' "$archive"
done
