# Theater Simple

A presentation app for a theater projector and hybrid Zoom events. Choose a PDF or PowerPoint once, or enter a website address, and show the content above translated captions. OBS is not required.

## macOS Apple silicon test build

This branch starts from the first Windows release, v1.2.0, and adds an Apple silicon Mac app. The Windows v1.2.0 release remains unchanged. Extract the macOS ZIP, open **Theater Simple.app**, and follow **START HERE Mac.txt**. The Mac build is ad-hoc signed and is not yet notarized; macOS may require **System Settings → Privacy & Security → Open Anyway** after the first launch attempt. Grant microphone, Screen Recording, camera, and PowerPoint Automation permissions only when using those features. [Apple explains the Open Anyway flow](https://support.apple.com/en-us/102445).

PDFs and websites use the same display and caption code as the Windows app. Direct `.pptx` and `.ppsx` import asks installed, activated Microsoft PowerPoint for Mac to export static PDF slides through AppleScript. This Office automation path needs a real test on the destination Mac. If it fails, export the deck as PDF in PowerPoint and select that PDF. For animations, run the slideshow in PowerPoint and capture its window under **Other windows**. Use an extended projector display, then share the **Theater Simple · Projector** window in Zoom.

To build on an Apple silicon Mac with Node.js 24.19.0 and npm:

```bash
bash scripts/build-macos.sh
```

The script downloads and verifies the pinned official Electron 44.9.0 arm64 archive, installs locked dependencies, runs tests, bundles the app, signs it ad hoc, and writes a ZIP plus SHA-256 checksum in `dist/`. The GitHub Actions macOS workflow performs the same build and checks the bundled local server. Production distribution will require Developer ID signing and notarization.

## Windows quickstart

1. Download the Windows ZIP from [the latest release](https://github.com/vmihalis/theater-simple/releases/latest).
2. Choose **Extract All**. Open **Start Theater.cmd** inside the extracted folder.
3. Choose a PDF, `.pptx`, or `.ppsx`, or enter a URL and click **Show website**.
4. Click **Open projector**, move that window to the extended display, then click **Full screen**.
5. Use **Live presentation** to show content, or **Holding** / **Blackout** between speakers.

Windows 11 x64 is the tested platform. The release includes Node.js, Electron, and browser assets; no developer tools are needed. Internet is needed for websites and live Soniox translation. PDF presentation and caption test text work offline.

## Content

| Content | How it works |
| --- | --- |
| PDF | Select once. Use **Previous** / **Next** in the app. |
| PowerPoint | Select `.pptx` or `.ppsx` once. Installed, activated **Microsoft PowerPoint** exports static slides locally; use the same page controls. |
| Website | Enter its address once. The desktop app opens one website window and automatically captures it. Use **Browse website** to click and scroll there; the projector follows the same page. |
| Another app or a remote Zoom presenter | Expand **Other windows**, then explicitly choose the presentation window. |

PowerPoint animations, transitions, video, and audio do **not** play in the direct-file route. Save older `.ppt` / `.pps` files as `.pptx` or PDF first. Decks linking to external media or data must be made self-contained or exported to PDF. Animated slides can use the original PowerPoint window through **Other windows** instead.

The website window has its own browser session. Existing Edge logins are not imported. Some pop-up login flows, DRM, or other browser features may need the ordinary browser plus manual window capture. Automatic website capture works in the desktop app, not in a normal browser tab. Picture capture does not carry website or presentation audio.

## Captions and camera

Choose the microphone carrying the speaker's voice. Add your own Soniox API key under **Soniox key & caption test**, choose English → Japanese or Japanese → English, and click **Start captions**. The selected microphone audio is sent to Soniox while captions are running. Stop captions to end the session.

The key is held in the local server's memory for the current session. It is not written to settings, browser storage, or the release package; enter it again after restarting the server. **Show test** displays sample text without audio, a key, or a network request. Optional camera capture has separate controls.

## Zoom

For direct PDFs, PowerPoints, and websites, share the **Theater Simple · Projector** window in Zoom. The picture and Soniox captions then appear together. Zoom's own translated captions remain an optional separate feature, subject to the Zoom account's license.

A remote presenter can share their own screen normally in Zoom. Capture the incoming shared-content window under **Other windows** to show it in the theater. **Do not share that received view back into the same Zoom meeting.** The Soniox caption strip on the theater output will not automatically appear over the remote presenter's original Zoom share; attendees can use Zoom captions or a separate caption display. Clean remote-speaker audio for Soniox requires a suitable mixer or loopback input; the laptop microphone is not an automatic remote-audio route.

Rehearse projector placement, microphone routing, both caption directions, Zoom audio, and camera use on the destination equipment before an event. Use only one control window at a time.

## Run from source

From a Windows PowerShell prompt in the repository:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/setup-windows.ps1
& '.\Start Theater.cmd'
```

Setup downloads the pinned official Node.js and Electron Windows x64 ZIPs, checks their SHA-256 hashes, installs locked npm dependencies with lifecycle scripts disabled, and generates the ignored PDF.js browser assets. It does not require a system Node.js installation. Download hashes and URLs are recorded in [runtime-versions.json](scripts/runtime-versions.json).

If you already have Node.js 24.19.0 or newer, browser-only development also works:

```powershell
npm ci --ignore-scripts --omit=optional
npm run vendor:pdfjs
npm test
npm start
```

Open `http://127.0.0.1:43120/`. Browser-only mode supports direct PDFs and PowerPoint but uses manual window capture for websites.

To test using the bundled Node runtime:

```powershell
& '.\runtime\node.exe' --test 'tests/*.test.mjs'
```

## Build a Windows release

After setup:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build-windows.ps1
```

The script writes `dist/Theater Simple Windows.zip` and a `.sha256` file. It packages an explicit source/runtime allowlist, including only the `ws` production dependency. It excludes user data, browser profiles, keys, logs, downloads, and uploaded documents. It refuses to overwrite an existing package; use `-PackageName 'Theater Simple Windows 1.2.0'` for a new output name.

## Files and stopping

Uploaded documents and prepared slides live under `data/`; website sessions live under `data/desktop-profile/`. They are ignored by Git. Copying an already-used application folder will also copy its local data, so distribute the clean release ZIP instead.

Stop captions and captures, close the desktop app and projector, then run **Stop Theater.cmd**. Closing the desktop window alone leaves the local server running.

## License and components

Theater Simple source is [MIT licensed](LICENSE). Node.js, Electron/Chromium, PDF.js, and `ws` retain their own licenses. PDF.js 6.4.299 is generated from the pinned npm dependency; its fonts, CMaps, ICC profiles, WebAssembly assets, and notices are copied unchanged. See [third-party notes](docs/third-party.md) and [licenses](licenses).

Microsoft PowerPoint, Zoom, and Soniox are separate products and services and are not bundled.
