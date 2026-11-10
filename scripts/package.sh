#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

target="${1:-all}"
case "$target" in
    all) platforms=(linux win32) ;;
    linux) platforms=(linux) ;;
    windows) platforms=(win32) ;;
    *) echo "Usage: npm run package -- [all|linux|windows]" >&2; exit 2 ;;
esac

mkdir -p dist
staging="$(mktemp -d "$PWD/dist/.package.XXXXXXXX")"
trap 'rm -rf -- "$staging"' EXIT

app_dir="$staging/app"
mkdir "$app_dir"
cp -R package.json package-lock.json src "$app_dir/"
npm ci --prefix "$app_dir" --omit=dev --ignore-scripts --no-audit --no-fund

version="$(node -p "require('./package.json').version")"
for platform in "${platforms[@]}"; do
    # Use the same downloader, release checksums, and cache as Electron's npm installer.
    electron_zip="$(node - "$platform" <<'JS'
const { createRequire } = require('node:module');
const electronRequire = createRequire(require.resolve('electron/package.json'));
const { downloadArtifact } = electronRequire('@electron/get');

downloadArtifact({
  version: electronRequire('./package.json').version,
  artifactName: 'electron',
  platform: process.argv[2],
  arch: 'x64',
  checksums: electronRequire('./checksums.json'),
  cacheRoot: process.env.electron_config_cache,
}).then(
  zip => console.log(zip),
  error => { console.error(error); process.exitCode = 1; },
);
JS
)"
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
        archive="$name.zip"
        (cd "$staging" && zip -qr "$archive" "$name")
    else
        mv "$bundle/electron" "$bundle/MoodleBOSS"
        archive="$name.tar.gz"
        tar -C "$staging" -czf "$staging/$archive" "$name"
    fi

    mv -f "$staging/$archive" "dist/$archive"
    printf 'Built dist/%s\n' "$archive"
done
