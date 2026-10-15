# The bug that only existed sideways

*How an AI agent, a real phone and a second browser found a bug that every automated check missed, and the small tool I built from it.*

## The feature

I was building a live room in a React Native app: a host presents from a laptop, members watch on their phones. The feature that week was simple to describe. A member can make the host's shared screen full screen, with the phone turned sideways.

Unit tests passed and type checks passed. None of that said anything about what happens on a real phone, during a rotation, inside a live call.

## Two actors, driven by an agent

I let Claude Code test it the way a QA person would, but scripted and in a loop.

**The host** was a visible Chrome window driven by Puppeteer. A script signed in to the staff console, joined the session and pressed "Present your screen". Chrome flags made that work with nobody at the keyboard: a fake camera and microphone, and screen sharing pointed at a tab the script had opened itself, chosen by its title. A banner on the page said what the agent was doing at each step, so I could watch.

**The member** was my own phone over USB. The agent installed a build, opened the room with a deep link (`adb shell am start -d "<scheme>://live/<id>"`), registered, and took screenshots to check the shared screen was on the stage.

Then the actual test: tap the expand button, take a screenshot, read the rotation.

## "Nothing happened"

The first tap did nothing. The screenshot was unchanged, and the rotation stayed at 0.

A person would tap again, or decide the button was broken. The agent cleared logcat before the tap, and afterwards grepped it for orientation and dialog events. The log told a different story from the screenshot:

1. the app rotated to landscape,
2. the full-screen dialog opened,
3. about 100 ms later the dialog closed and the app rotated back to portrait.

The view hadn't failed to open. It opened and closed itself, faster than any screenshot could catch.

## The cause

The agent went from the log to the room's layout code. A phone turned sideways is wider than 600 dp, and at that width the room switched to its tablet layout with two panes. The stage moved to a different place in the React tree, so React unmounted it and mounted a new one. The "full screen is open" state lived inside the stage, so the new stage started with it closed, closed the dialog, and asked for portrait again.

So the feature did exactly what it asked for, and that very action tore it down. You only see that on a real device that actually rotates.

The fix was small: keep the full-screen state in the room component, which survives the layout switch. The agent rebuilt the APK, re-signed it with the debug key the installed copy used (so it installed over the old one without losing the sign-in), reinstalled, rejoined and retested. Sideways full screen stayed open, and both the close button and Back brought the phone back to portrait with the session still running. A second pass padded the picture so the status bar no longer drew over the slide.

## What made it work

- **The loop, not the check.** Act, look, read the logs, fix, run again. The agent's first look said "nothing happened" and was wrong. The log was right.
- **Two actors at once.** The bug needed a host actually sharing and a member actually watching. A single-device test would have needed a fake host, and a fake is where bugs like this hide.
- **Being able to watch.** Banners in the browser and screenshots per step meant I could follow along and stop it.
- **A phone that is not a lab device.** It was my personal phone, and I was sometimes using it. The agent checked what was in front and whether the phone was locked before every tap, and left it alone if I was in another app.

## Turning it into a tool

Afterwards I rebuilt the approach from scratch, with no company code, as [duet](../README.md): a CLI and an MCP server that give an agent the same powers with guard rails. Rebuilding it surfaced things I had got wrong or not noticed:

- **The fake share was probably not my slides.** Chrome's `--use-fake-ui-for-media-stream` skips the screen-share picker entirely and returns a fake green test pattern, so `--auto-select-tab-capture-source-by-title` never takes effect. My original run used both flags, so the "slides" on the phone were most likely Chrome's test pattern. The bug didn't care what was on screen, but a test should share what it says it shares. duet now auto-accepts only the camera and microphone when a capture tab is named, and the sample scenario checks that the shared track is a tab.
- **A hidden window is a slow window.** On macOS a Chrome window behind other windows counts as hidden, and Chrome runs its timers once a second. The host's frames dropped to one a second while I was watching the phone. duet launches Chrome with that throttling off.
- **Coordinates lie.** The model sees a large screenshot scaled down (1080x2340 can arrive as 923x2000), so a point read off the image is not a device pixel. duet saves screenshots pre-scaled to a known size, records the scale and maps taps back. It refuses a tap if the screen has rotated since the screenshot.
- **Clearing logcat on someone's phone is rude.** duet marks the device clock instead, and reads only what came after.
- **A guard that fails open is not a guard.** If duet cannot read whether the phone is locked, or what is in front, it treats that as unsafe. It also refuses screenshots while another app is in front, so it never captures someone's messages.

The repo includes a small, open sample (a host page, a relay and an Expo viewer app) with the same bug planted on a branch, and a two-actor scenario that catches it.

## What it is not

duet is glue around adb and Puppeteer, not a testing framework. Plenty of tools already let an agent drive a single phone or a single browser, and Maestro's MCP server already lets an agent write and run flows on one device. What duet adds is the part I needed: several actors in one scenario, on a real phone that may be someone's own, with the log next to every failure.
