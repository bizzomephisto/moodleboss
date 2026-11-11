#!/usr/bin/env bash
set -euo pipefail

directory="$(cd -- "$(dirname -- "$0")" && pwd -P)"
if [[ -x "$directory/MoodleBOSS" ]]; then
    command=("$directory/MoodleBOSS")
    icon="$directory/resources/app/assets/desktop/moodleboss.png"
else
    project="$(cd -- "$directory/.." && pwd -P)"
    command=("$project/node_modules/electron/dist/electron" "$project")
    icon="$project/assets/desktop/moodleboss.png"
fi
if [[ ! -x "${command[0]}" || ! -f "$icon" ]]; then
    echo 'MoodleBOSS or its icon is missing. Extract the full Linux archive or install the project dependencies.' >&2
    exit 1
fi

applications="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
mkdir -p -- "$applications"
entry="$applications/moodleboss.desktop"

escape_value() {
    local value="$1"
    value="${value//\\/\\\\}"
    value="${value//$'\n'/\\n}"
    printf '%s' "$value"
}

{
    printf '%s\n' '[Desktop Entry]' 'Type=Application' 'Name=MoodleBOSS'
    printf 'Exec='
    for argument in "${command[@]}"; do
        quoted="$(printf '%s' "$argument" | sed 's/[\\"$`]/\\&/g; s/%/%%/g')"
        printf '"%s" ' "$(escape_value "$quoted")"
    done
    printf '\nIcon=%s\n' "$(escape_value "$icon")"
    printf '%s\n' 'Terminal=false' 'Categories=Education;' 'StartupWMClass=moodleboss'
} > "$entry"
printf 'Added MoodleBOSS to Applications (%s)\n' "$entry"
