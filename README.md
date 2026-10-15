# duet

Lets an AI coding agent test a feature the way a QA person would: on a **real Android phone** and in a **visible browser** at the same time, with a person able to watch every step.

duet is not a testing framework. It is a small harness around adb and Puppeteer. It gives an agent (Claude Code, through MCP or a CLI) safe, one-step-at-a-time commands, records every step with its screenshot, and keeps device logs at hand, so the agent can find out *why* something failed, fix the code and run the same steps again.

## Why

Some bugs only show up on a real device, in the middle of a flow with more than one person in it.

A viewer on a phone watches a presenter's shared screen and taps "Full screen". The phone turns sideways, and the full-screen view closes itself about 100 ms later. Unit tests and type checks pass. A screenshot after the tap shows that nothing happened. The device log shows what did happen: the view opened, the layout switched to two panes because the sideways phone is wider than 600 dp, the stage remounted and lost its "full screen" state, and the view closed.

Finding that takes two actors (someone presenting from a browser, someone watching on a phone), a real rotation, and the log. duet is built for that loop: act, look, read the log, fix, run it again.

## What it does

- **Phone actor**: a real Android device over adb. Screenshots sized for the model, tap by text or by screenshot coordinates, deep links, typing, keys, rotation, logcat since a mark, install over the existing app with re-signing. A guard checks what is in front before every action (see below).
- **Browser actors**: any number of named, visible Chrome windows ("host", "guest"), each with its own profile. Click by label, fill fields, wait for text, step banners on the page, a fake camera and microphone, and screen sharing of a chosen tab with no picker.
- **Scenarios**: a YAML file whose steps are the same commands, one actor per line. Run it, and duet stops at the first failure and collects each actor's screenshot and each phone's log.
- **Report**: an HTML page per run, with each step, its screenshots and log excerpts, and the failure first.
- **MCP server**: every command as a tool, with screenshots returned as images.

## Quick start

```sh
git clone <this repo> && cd duet
pnpm install && pnpm build
alias duet="node $PWD/bin/duet.js"
export DUET_PACKAGE=com.example.yourapp      # the app under test
```

Phone:

```sh
duet phone status                    # what is in front, locked or not, would duet act
duet phone launch --shot             # start the app, return a screenshot
duet phone ui                        # elements on screen: label, type, centre
duet phone tap --text "Join"         # by visible text or accessibility label
duet phone tap 362 1452              # by coordinates on the last screenshot
duet phone logs mark                 # remember "now" on the device clock
duet phone tap --text "Full screen"
duet phone rotation --expect landscape --timeout 3000
duet phone logs --since-mark --grep "Dialog|rotation"
duet phone install app-release.apk --resign    # re-sign with the debug key, keep app data
```

Browser:

```sh
duet browser open host http://localhost:8080 --capture-title "Slides"
duet browser new-tab host --title "Slides" --text "Slide 1"
duet browser click host --text "Present your screen"
duet browser wait-for host --text "Presenting"
duet browser screenshot host
duet browser close host
```

Each browser keeps running between commands. Every command attaches, does one thing, records it and lets go, so an agent can move between the browser and the phone freely.

Every command prints one JSON object. Every step is appended to `.duet/run/events.jsonl` (or `--run-dir`), with its screenshot or log file. `duet report` turns that folder into `report.html`.

### With Claude Code (MCP)

```json
{
  "mcpServers": {
    "duet": {
      "command": "node",
      "args": ["/path/to/duet/bin/duet.js", "mcp"],
      "env": { "DUET_PACKAGE": "com.example.yourapp" }
    }
  }
}
```

The tools mirror the CLI (`phone_tap`, `phone_logs`, `browser_click`, `scenario_run`, `report_build`, ...). Screenshots come back as images in the tool result, sized so that coordinates the model reads off them can be passed straight to `phone_tap`.

## Scenarios

```yaml
name: Full screen survives turning the phone sideways
actors:
  host:
    browser:
      url: ${SAMPLE_URL:-http://localhost:8080}
      captureTitle: Slides for the phone
  viewer:
    phone:
      package: dev.duet.sample
steps: |
  host: new-tab --title "Slides for the phone" --text "Slide 1"
  host: click --text "Present your screen"
  viewer: reverse 8080
  viewer: open-link "duetsample://room/demo"
  viewer: tap --text "Join demo"
  viewer: logs mark
  viewer: tap --text "Full screen"
  viewer: rotation --expect landscape --timeout 3000
  pause: 1500
  viewer: rotation --expect landscape
  viewer: logs --since-mark --grep duet-sample
```

```sh
duet scenario check examples/fullscreen-on-a-phone.yaml    # validate, touches no device
duet scenario run examples/fullscreen-on-a-phone.yaml      # runs/<time>-<name>/report.html
```

Steps are the commands an agent already uses, so a sequence worked out by hand can be saved as a scenario and replayed after every fix. `note:` lines become headings in the report. `${VAR}` comes from the environment; an unset variable is an error unless it has a `:-fallback`.

## Safe on someone's own phone

A test phone is often the developer's own phone, in use while the agent works. Before each command duet reads what is in front, and whether the phone is awake and unlocked:

| | your app in front | home screen | another app, locked, asleep, shade down |
|---|---|---|---|
| look (screenshot, ui, wait-for) | yes | yes | no |
| launch (open-link, launch) | yes | yes | no |
| act (tap, swipe, type, keys) | yes | no | no |

Anything it cannot read counts as unsafe. Screenshots are refused too when another app is in front, so the agent never captures someone's messages. `install` never uninstalls, because that would wipe the app's data and sign-in. `logs` reads logcat without clearing it; it covers the whole device (system lines such as rotation changes are often the clue), so pass `--app` to keep only your app's lines. `--no-guard` turns the checks off, for a dedicated lab device.

## How it compares

Plenty of tools already let an agent drive one surface. [Maestro MCP](https://maestro.dev/mcp) lets an agent write and run YAML flows on an emulator or simulator, [Playwright MCP](https://github.com/microsoft/playwright-mcp) drives a browser, and there are many adb-based Android MCP servers ([Android-MCP](https://github.com/CursorTouch/Android-MCP), [adb-mcp](https://github.com/FlashZ/adb-mcp) and others). Use them if one surface is enough.

duet is for the case they leave to you: **several actors in one scenario** (a host in a browser, a viewer on a phone), run on a **real phone that may be someone's own**, **watchable** while it runs, with the **device log** next to every failure.

## Things that bit us

- A model sees a large screenshot scaled down (a 1080x2340 capture can arrive as 923x2000), so coordinates read off it are not device pixels. duet saves screenshots pre-scaled (1568 px long edge by default), records the scale and maps taps back. If the screen has rotated since the screenshot, the tap is refused.
- "Nothing happened" is often wrong. A view that opens and closes within 100 ms never shows up in a screenshot; the log has it.
- `--use-fake-ui-for-media-stream` skips Chrome's screen-share picker entirely and shares a fake green test pattern, so `--auto-select-tab-capture-source-by-title` never comes into play. duet auto-accepts only the camera and microphone when a capture tab is named.
- macOS reports a Chrome window behind other windows as hidden, and Chrome then runs its timers once a second. A host sharing frames dropped to 1 per second while the person watched the phone. duet turns that throttling off.
- `uiautomator` cannot read a screen that never goes idle (live video, endless animation), and does not see some overlays. Fall back to a screenshot and coordinates.
- A release APK signed with a different key will not install over the existing app. Re-sign it with the key the installed copy uses rather than uninstalling.

## The sample

`sample/` is a small, open stand-in for a live session (a host page, a relay server, an Expo viewer app) with the full-screen rotation bug planted on the `demo/rotation-bug` branch. See [sample/README.md](sample/README.md).

## Limits

- Android only, one phone per scenario actor, Chrome only.
- `type` sends ASCII only (an `adb shell input` limit).
- The guard reads `dumpsys` output, whose format varies by Android version and vendor. It fails closed when it cannot parse something; please report a device it misreads.

## Requirements

Node 22.12+, adb (Android platform-tools), Google Chrome, and a phone with USB debugging on. `install --resign` needs `apksigner` (Android build-tools) and Java.

## License

MIT
