# duet

Lets an AI coding agent test a feature the way a QA person would: on a **real Android phone** and in a **visible browser** at the same time, with a human able to watch each step.

duet is not a new testing framework. It is a harness around adb and Puppeteer that gives an agent (such as Claude Code) small, safe commands, records every step, and keeps device logs close at hand so the agent can work out *why* something failed, fix it and run the steps again.

> Status: early. The phone actor works. The browser actor, scenarios, the HTML report and the MCP server are next.

## Why

Some bugs only exist on a real device, in the middle of a multi-person flow. For example, a viewer on a phone turns it sideways to watch a presenter's shared screen full screen, and the full-screen view closes itself 100 ms after opening. Unit tests and type checks pass. A screenshot shows "nothing happened". The device log shows the view opened and then closed.

duet is built for that loop: act, look, read the logs, fix, run it again.

## The phone actor

```sh
pnpm install && pnpm build
export DUET_PACKAGE=com.example.yourapp   # the app under test

duet phone status                 # who is in front, locked or not, would duet act?
duet phone launch --shot          # start the app and take a screenshot
duet phone ui                     # elements on screen: label, type, centre
duet phone tap --text "Join"      # tap by visible text or accessibility label
duet phone tap 362 1452           # tap by coordinates on the last screenshot
duet phone logs mark              # remember "now" on the device clock
duet phone tap --text "Full screen" --shot
duet phone logs --since-mark --grep "rotation|Dialog"
duet phone rotation               # { rotation: 1, degrees: 90, landscape: true }
duet phone install app-release.apk --resign   # re-sign with the debug key, keep app data
```

Every command prints one JSON object, so an agent can read the result directly. Every step is appended to `.duet/run/events.jsonl` with its screenshot or log file, for the run report.

### Safe on someone's own phone

A test phone is often the developer's own phone, in use while the agent works. Before each command duet reads what is in front and whether the phone is awake and unlocked:

| | your app in front | home screen | another app, locked, asleep, shade down |
|---|---|---|---|
| look (screenshot, ui, wait-for) | yes | yes | no |
| launch (open-link, launch) | yes | yes | no |
| act (tap, swipe, type, keys) | yes | no | no |

Anything it cannot read counts as unsafe. Screenshots are refused too when another app is in front, so the agent never captures someone's messages. `install` never uninstalls, since that would wipe the app's data. `logs` reads logcat without clearing it. `--no-guard` turns all of this off, for a dedicated lab device.

### Screenshots the model can tap on

A model sees a large screenshot scaled down (a 1080x2340 capture may reach it as 923x2000), so coordinates it reads off the image are not device pixels. duet saves screenshots already scaled to fit (1568 px on the long edge by default), records the scale, and maps `tap X Y` back to device pixels. If the screen rotated since that screenshot, the tap is refused and the agent is asked to take a new one.

### Known limits

- `uiautomator` cannot read a screen that never goes idle (live video, endless animation), and does not see some overlays drawn above the app's views. Use a screenshot and coordinates there.
- `type` sends ASCII only (an `adb input` limit).
- Android only for now.

## Requirements

Node 22.12+, adb (Android platform-tools), a phone with USB debugging on. `install --resign` needs `apksigner` (Android build-tools) and Java.

## License

MIT
