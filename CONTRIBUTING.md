# Contributing

Thanks for helping. duet is small on purpose, so the most useful contributions are fixes for real devices and real browsers.

## Set up

```sh
pnpm install      # installs and builds
pnpm typecheck
pnpm test
```

The tests never touch a device or open Chrome. The phone is simulated by a fake adb (see `test/phone.test.ts`), and `dumpsys` parsing is tested against captured output in `test/parse.test.ts`.

## The guard misreads my phone

The guard reads `dumpsys` output, which differs between Android versions and vendors. If `duet phone status` says the phone is locked when it is not (or the reverse), or cannot tell what is in front:

1. Run `duet phone status` and include the output in an issue, with the phone model and Android version.
2. Include the matching raw lines, which contain no personal data:

```sh
adb shell "dumpsys window | grep -E 'Keyguard|Lockscreen|mCurrentFocus|mRotation'"
adb shell "dumpsys activity activities | grep -E 'ResumedActivity|KeyguardShowing'"
adb shell "dumpsys power | grep mWakefulness"
```

A fix usually means teaching a parser in `src/phone/parse.ts` one more format, plus a test with that output. When in doubt, the guard should fail closed.

## Changes

- Keep commands doing one thing, and keep them printing one JSON object.
- If you add or rename a command or an option, update `README.md`. `test/readme.test.ts` fails when the README shows a command the CLI does not have.
- Add a test that fails without your change.
- Don't add anything that clears, uninstalls or resets things on the phone. duet has to stay safe on someone's own device.

## Never commit

Keystores, `.env` files, run folders (`runs/`, `.duet/`), browser profiles or APKs. `.gitignore` covers them; please don't force-add them.
