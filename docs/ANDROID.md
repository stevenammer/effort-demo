# Android shell

This directory adds a Capacitor 7 Android shell around the public, static walkthrough. It does not add an account, a backend, analytics, a remote runtime URL or network permission.

## Decisions

- The package id is `org.effort.publicdemo`, a deliberately generic public-demo id. Change it before releasing a store build if the owner has a registered reverse-DNS id.
- Capacitor serves only its bundled files at `https://localhost`. `capacitor.config.json` has no `server.url`, cleartext traffic is disabled, and the manifest doesn't request `INTERNET`.
- `scripts/prepare-android-web.mjs` creates the ignored `android-web/` staging directory. It copies the existing root `index.html`, `public/`, `sw.js`, and `shell-manifest.js` without transforming them. Keeping `/public/` is intentional: the current offline worker hashes and serves that layout.
- The Android `ACTION_SEND` target intentionally accepts `text/plain` only. It combines Android's optional title and text, bounds the result to the same 4,000 characters used by the browser service-worker target, then opens `https://localhost/public/?share=…`. `public/app.js` already consumes that `share` query parameter, so capture semantics remain in the existing web code.
- The adaptive icon and Android 12 splash use the dark surface and light mark colors from `public/favicon.svg`. `effort_mark.xml` is a simple vector approximation of the public `e.` mark, because Android adaptive icons cannot directly use the SVG text element.
- This is a shell for the public walkthrough. Browser storage and downloaded backups remain device-local. A share opens a prefilled capture and isn't saved until the person explicitly saves it.

## Parent build steps

Run these from the repository root on a machine with Node 20.20+, Android Studio or the Android SDK, JDK 17, and network access for the initial Capacitor install. The first command updates `package-lock.json`; review and commit that lockfile with the shell.

```sh
npm install
npm run android:prepare
npx cap sync android
cd android && ./gradlew assembleDebug
```

The APK will be at `android/app/build/outputs/apk/debug/app-debug.apk`. To open the native project instead, run:

```sh
npx cap open android
```

Whenever a web-shell file changes, repeat `npm run android:prepare` and `npx cap sync android` before rebuilding. Do not point `server.url` at a preview, production site, or another remote host. That would defeat the local-only shell guarantee.

## Required verification by the parent

This sandbox cannot run Node, Gradle, Android SDK, or Git commands. Run these commands after installing dependencies:

```sh
npm run test:android-shell
npm test
npm run check:syntax
npm run check:public
npm run android:prepare
npx cap sync android
cd android && ./gradlew assembleDebug
```

Manual emulator or device checks:

1. Launch the app in airplane mode after installation. The walkthrough should open and its existing offline status should become available after the service worker initializes.
2. Use Android's share sheet from a text source and select E.F.F.O.R.T. The capture dialog should contain the shared text, but no capture should exist until Save is tapped.
3. Reload the app, make a capture, and use its existing backup flow. Confirm the capture and downloaded backup remain local.
4. Inspect Android Studio's Network Inspector while opening and sharing. The shell should make no remote request. `https://localhost` is Capacitor's in-app asset origin, not a remote server.

## Generated files

`android/capacitor.settings.gradle`, `android/app/capacitor.build.gradle`, `android/capacitor-cordova-android-plugins/`, `android-web/`, and Gradle build output are generated or local artifacts and are intentionally ignored. `npx cap sync android` creates the Capacitor-generated files from the tracked configuration and dependencies.
