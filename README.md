# MoodleBOSS

MoodleBOSS is a desktop workspace for the Moodle 4.5 sandbox with a read-only
test mode for live Moodle sites.

## Run a portable build

Get the archive for your system from [GitHub Releases](https://github.com/bizzomephisto/moodleboss/releases).

| System | Open after extracting the entire archive |
| --- | --- |
| Linux x64 | `MoodleBOSS` |
| Windows x64 | `MoodleBOSS.exe` |
| macOS Apple Silicon (arm64) | `MoodleBOSS.app` |
| macOS Intel (x64) | `MoodleBOSS.app` |

The Mac builds are ad hoc signed. If macOS blocks the app after the first
launch attempt, open **System Settings → Privacy & Security** and select
**Open Anyway** for MoodleBOSS.

Keep the executable with the files extracted beside it. The archives include
Electron and the app dependencies. Saved drafts and the Moodle session live in
the app profile on each computer.

## Connect to the sandbox

Start the existing sandbox on Linux with `~/moodle-sandbox/sandbox start`, then
choose **Connect Moodle** in the app. MoodleBOSS connects to
`http://127.0.0.1:8787`.

To use that same sandbox from Windows or macOS, open PowerShell or Terminal and run the following
with an existing SSH account on the Linux host. Replace `user@linux-host` with
your Linux username and the host's address.

```powershell
ssh -N -o ExitOnForwardFailure=yes -L 127.0.0.1:8787:127.0.0.1:8787 user@linux-host
```

Leave the SSH session open while using MoodleBOSS. This forwards Windows
loopback to Linux loopback and keeps Moodle off the network. A separate Moodle
sandbox on Windows can also be used if its configured site URL is
`http://127.0.0.1:8787`.

## Test a live Moodle site

In **Settings → Moodle environment**, turn on **Test Live Moodle**, enter the
site's HTTPS base URL (including a subdirectory such as `/moodle` if it uses
one), and select **Apply environment**. Close Settings and choose
**Connect to Moodle**. This mode supports Moodle's built-in login form and
Microsoft sign-in for `https://moodle.louisiana.edu`.

Live mode reads your dashboard, assignment counts, and upcoming activities.
Assignment management and publishing are available in Sandbox. Live sessions
and dashboard data stay in memory for the current launch. MoodleBOSS starts
in Sandbox every time. Saved drafts remain available in both modes.

The dashboard uses Moodle’s **In progress** course filter in both environments.
Moodle determines which courses are in progress from course dates and completion.
Under **Settings → Course visibility**, uncheck courses to hide them from
the sidebar, dashboard, and assignment builder. MoodleBOSS saves this preference
on this computer for each Moodle site and account.

## Research and presentations in Chat

Choose **Research & Google Slides** from the Chat skill selector. Describe the
topic, audience, and slide count, then select **Research & plan**. MoodleBOSS
uses your selected AI provider to research Wikipedia and choose licensed images
from Wikimedia Commons. The preview includes the slide outline, research links,
and image credits. After connecting Google, select **Create in Google Slides**.
The generated deck includes editable layouts, speaker notes, citations, and
linked references. Research plans stay in the current chat session.

## Connect Google Slides

1. In your [Google Cloud project](https://console.cloud.google.com/), enable the
   **Google Slides API** and **Google Drive API**.
2. Configure Google Auth Platform's consent screen. For an external app in
   testing, add your Google account as a test user.
3. Create an OAuth client with the **Desktop app** application type and download
   its JSON credentials.
4. In MoodleBOSS **Settings → Google Slides**, select **Import Google credentials**,
   choose that file, and then select **Connect Google**. Finish sign-in in
   your browser.

MoodleBOSS requests access to files it creates using the `drive.file` scope.
The Google connection lasts for the app session. Imported Desktop client
credentials are stored in the local app profile. Your Google workspace's
administrator may need to allow the OAuth client.

## Build the archives

On Linux, install the project dependencies with `npm ci`, then run
`npm run package`. The build uses Bash, `unzip`, `zip`, and `tar` and writes
both archives to `dist/`. Pass `-- linux` or `-- windows` to build one archive.
On macOS, run `npm ci` and `npm run package -- mac` to build the archive for
that Mac's architecture.
