# duet sample

A small, open stand-in for a live session, used to demo duet: a **host** presents a browser tab from a web page, and a **viewer** watches it in an Android app and can make it full screen.

- `server/`: a relay. The host page (`host.html`) captures the shared tab and sends JPEG frames over a WebSocket; the server passes the latest frame to every viewer. It is not WebRTC, and does not need to be: the point is two actors in one test.
- `app/`: the viewer, an Expo app (`dev.duet.sample`). Open `duetsample://room/demo`, join, and the host's tab appears on the stage. "Full screen" turns the phone sideways.

## Run it

You need Node 22+, adb, Java 17 or newer and the Android SDK (`ANDROID_HOME` set, or `sdk.dir` in `app/android/local.properties` after prebuild).

```sh
# the relay and the host page, on http://localhost:8080
cd sample/server && npm install && npm start

# the viewer app (in another terminal)
cd sample/app && npm install
npx expo prebuild -p android
(cd android && ./gradlew :app:assembleRelease -PreactNativeArchitectures=arm64-v8a)
duet phone install android/app/build/outputs/apk/release/app-release.apk

# the two-actor scenario, from the repository root
duet scenario run examples/fullscreen-on-a-phone.yaml
```

The release build is signed with the debug key, so it installs over an earlier build without losing data. The scenario runs `adb reverse tcp:8080 tcp:8080` itself, so the phone reaches the relay as `localhost`.

To see the bug, build from the `demo/rotation-bug` branch instead: the scenario then fails at "rotation --expect landscape", and the report shows the log lines where full screen opens, the stage remounts, and full screen closes.

`app/` started from Expo's blank TypeScript template; `app/LICENSE` is that template's license.

## The planted bug

The `demo/rotation-bug` branch has a real-world bug in it on purpose. In landscape the phone is wider than 600 dp, so the room switches to a two-pane layout. The stage moves to a different place in the component tree and remounts, and the "full screen" state lived inside the stage. So the full-screen view closes itself and the phone rotates back, about a frame after it opened. A screenshot shows nothing happened; the device log shows it opened and closed.

The fix (on `main`) keeps that state in the room, which survives the layout switch.
