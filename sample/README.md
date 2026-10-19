# duet samples

Small, open apps for the duet demos. No outside accounts or services: a Node server on your computer, and the phone reaches it through `adb reverse`.

- `server/`: the servers for the demos.
  - `server.mjs`, a room relay. The host page (`/`) captures a shared browser tab and sends JPEG frames over a WebSocket; the server passes the latest frame to every viewer. It is not WebRTC, and does not need to be: the point is two actors in one test.
  - `server.mjs` also does sign in with your phone. The sign-in page (`/pair`) shows a 6-digit code and waits; the pair app approves it. `PAIR_BUG=1` plants a bug: the server checks the code, then signs in the newest waiting browser instead of the one with that code.
  - `community.mjs`, a small community on port 8765: posts, comments and profiles, kept in memory. Its page (`/?post=1&as=maya`) is one post as Maya sees it in her browser, with new comments appearing as they are posted. `COMMUNITY_BUG=1` plants a bug: each comment keeps the name its author had when writing it, so a rename never reaches comments already posted.
- `app/`: the room viewer, an Expo app (`dev.duet.sample`). Open `duetsample://room/demo`, join, and the host's tab appears on the stage. "Full screen" turns the phone sideways. The full-screen bug is planted on the `demo/rotation-bug` branch.
- `pair-app/`: the duet pair app, an Expo app (`dev.duet.pair`). Enter the code from the browser, then Approve. `duetpair://pair?code=123456` opens it with the code filled in, as scanning a QR code would.
- `community-app/`: the Acme Community app, an Expo app (`dev.duet.community`), signed in as Alex. A feed, posts with comments, and a Profile tab where Alex can change their display name. Your own comments show the name from your profile.

## Run them

You need Node 22+, adb, Java 17 or newer and the Android SDK (`ANDROID_HOME` set, or `sdk.dir` in `android/local.properties` after prebuild). From the repository root:

```sh
# the relay and sign-in server, on http://localhost:8080 (add PAIR_BUG=1 to plant the sign-in bug)
(cd sample/server && npm install && npm start)
# or the community server, on http://localhost:8765 (add COMMUNITY_BUG=1 to plant the rename bug)
(cd sample/server && npm run community)

# build and install an app (sample/app, sample/pair-app or sample/community-app), in another terminal
cd sample/pair-app && npm install
npx expo prebuild -p android
(cd android && ./gradlew :app:assembleRelease -PreactNativeArchitectures=arm64-v8a)
duet phone install android/app/build/outputs/apk/release/app-release.apk
cd ../..

# the scenarios
duet scenario run examples/comment-after-rename.yaml     # Maya in a browser, Alex in the community app
duet scenario run examples/sign-in-with-phone.yaml       # two browsers and the pair app
duet scenario run examples/fullscreen-on-a-phone.yaml    # a host browser and the room viewer
```

Release builds are signed with the debug key, so they install over earlier builds without losing data. Each scenario runs `adb reverse` for its server's port itself. The community server keeps everything in memory, so restart it before each run of its scenario: a second run would find Alex already renamed.

## See the bugs

- **Rename:** restart the community server with `COMMUNITY_BUG=1 npm run community`. The scenario then fails at "maya: wait-for Alex Rivera": the phone shows the new name on Alex's comment, and Maya's browser still shows "Alex". No app rebuild needed, the bug is on the server.
- **Sign-in:** restart the server with `PAIR_BUG=1 npm start`. The scenario then fails at "laptop: wait-for Signed in as Phone owner": the phone approved the laptop's code, and the desktop was signed in. No app rebuild needed, the bug is on the server.
- **Full screen:** build `sample/app` from the `demo/rotation-bug` branch. The scenario then fails at "rotation --expect landscape", and the report shows the log lines where full screen opens, the stage remounts, and full screen closes.

Add `--record --pace 900` to a run to get a captioned video of every actor. `scripts/make-demo-video.mjs` turns a failing and a passing run into the sign-in and full-screen videos in `docs/media`, and `scripts/make-demo-cut.py` makes the short comment demo.

`app/`, `pair-app/` and `community-app/` started from Expo's blank TypeScript template; their `LICENSE` files are that template's license.
