# duet sample

A small, open stand-in for a live session, used to demo duet: a **host** presents a browser tab from a web page, and a **viewer** watches it in an Android app and can make it full screen.

- `server/`: a relay. The host page (`host.html`) captures the shared tab and sends JPEG frames over a WebSocket; the server passes the latest frame to every viewer. It is not WebRTC, and does not need to be: the point is two actors in one test.
- `app/`: the viewer, an Expo app (`dev.duet.sample`). Open `duetsample://room/demo`, join, and the host's tab appears on the stage. "Full screen" turns the phone sideways.

## Run it

```sh
cd sample/server && npm install && npm start          # http://localhost:8080
adb reverse tcp:8080 tcp:8080                         # the phone reaches it as localhost
cd sample/app && npm install && npx expo prebuild -p android
cd android && ./gradlew :app:assembleRelease -PreactNativeArchitectures=arm64-v8a
duet phone install android/app/build/outputs/apk/release/app-release.apk
```

## The planted bug

The `demo/rotation-bug` branch has a real-world bug in it on purpose. In landscape the phone is wider than 600 dp, so the room switches to a two-pane layout. The stage moves to a different place in the component tree and remounts, and the "full screen" state lived inside the stage. So the full-screen view closes itself and the phone rotates back, about a frame after it opened. A screenshot shows nothing happened; the device log shows it opened and closed.

The fix (on `main`) keeps that state in the room, which survives the layout switch.
