# CoolDrive on mobile + the App Store

The game now detects mobile devices and switches to a touch/tilt control scheme.
It's also a PWA (installable, offline-capable) and Capacitor-ready so you can ship it
to the App Store with your Apple Developer account.

## Mobile controls (what changed)

On a touch device (`pointer: coarse` / mobile user-agent) the game adds `body.mobile`
and uses:

- **Steering = gyroscope.** Tilt the phone left/right like a wheel. iOS requires a
  permission tap, which happens automatically when you press **DRIVE** (a user gesture).
  Calibration is captured from however you're holding it; tune it in Settings
  (**Tilt sensitivity**, **Invert tilt**, **Recenter tilt**).
- **Gas / brake = invisible screen halves.** Hold the **right half** = gas, **left half**
  = brake. Multi-touch, so you can hold both.
- **Handbrake = bottom strip.** Hold the bottom ~20% of the screen.
- **Boost** = the small ⚡ button (top center). **Settings** = the ⚙ gear (top right).
- Faint zone labels fade in for the first few seconds, then disappear.
- A "rotate to landscape" overlay shows in portrait.

If tilt steering is backwards on your device, toggle **Invert tilt** in Settings (the
beta/gamma axis sign varies by device/orientation — the invert + recenter cover it).

## Test on a real phone (before any App Store work)

The desktop browser can't emulate the gyroscope, so test on an actual phone:

```bash
npm start                 # serves on http://<your-mac-ip>:5173
```
On your phone (same Wi-Fi), open `http://<your-mac-ip>:5173`. Note: iOS only grants the
motion sensor over **HTTPS or localhost** — over plain `http://LAN-ip` Safari may block
`DeviceOrientation`. Easiest fix: deploy to your Coolify domain (HTTPS) and test there,
or use a quick tunnel (`cloudflared tunnel --url http://localhost:5173`).

## Install as a home-screen app (PWA, no App Store)

Open the deployed HTTPS site on the phone → **Share → Add to Home Screen**. It launches
fullscreen, landscape, and works offline after the first load. (Apple does **not** list
PWAs in the App Store — for that, use Capacitor below.)

## The native iOS app (Capacitor) — already set up ✅

The `ios/` Xcode project is built and **verified to compile and run in the iOS Simulator**
(the game renders fullscreen, landscape, with audio bundled). Already done for you:
- Capacitor installed; `www/` is the web bundle (assembled by `npm run build:web`).
- `ios/App/` Xcode project generated — bundle id `io.cooldrive.app`, name **CoolDrive**.
- **Landscape-only**, **status bar hidden** (fullscreen), and **`NSMotionUsageDescription`**
  (the gyroscope permission) all set in `ios/App/App/Info.plist`.
- three.js and the MP3 radio are bundled, so the app runs **fully offline** — no hosting,
  no HTTPS needed (`capacitor://localhost` is a secure context, so the gyro works too).

### After you change the game (rebuild the app's bundle)
```bash
npm run ios          # = build:web + cap sync ios + open Xcode
# or, without opening Xcode:  npm run ios:sync
```

### Run it on your own iPhone
1. `npm run ios` (opens the project in Xcode).
2. Select the **App** target → **Signing & Capabilities** → pick your **Team** (your Apple
   Developer account). If `io.cooldrive.app` is taken, change the **Bundle Identifier** to
   your own reverse-domain id (and update `appId` in `capacitor.config.json` to match).
3. Plug in your iPhone, choose it as the run destination, press **▶ Run**.
   (The Simulator has **no gyroscope** — test tilt steering on the real device.)

### Share it — TestFlight (the iOS way to distribute without a full release)
Up to 10,000 testers via an email invite or a public link.
1. **App icons** (one-time): export a 1024×1024 PNG from `icon.svg`, then
   `npm install -D @capacitor/assets && npx capacitor-assets generate --ios`.
2. In Xcode set the destination to **Any iOS Device (arm64)** → **Product → Archive**.
3. When the Organizer opens: **Distribute App → TestFlight & App Store Connect → Upload**.
4. In **App Store Connect → CoolDrive → TestFlight**: once processed, add testers —
   **Internal** (your own devices, instant) or **External** with the **public link** to
   share with anyone. Testers install the free **TestFlight** app and open your link.

### Full App Store release (optional, later)
From the same archive: **Distribute App → App Store Connect**, fill in the store listing
(screenshots, description, privacy answers) in App Store Connect, and **Submit for Review**.

## iOS notes
- **Gyro permission:** handled by the DRIVE tap (`DeviceOrientationEvent.requestPermission`),
  which works in WKWebView. If a device refuses it, install the `@capacitor/motion` plugin
  and we can route steering through the native sensor instead.
- **WebGL + Web Audio + localStorage** all work in WKWebView — no changes needed.
- **No CDN dependency:** three.js is vendored in `vendor/` and the importmap points at it,
  so the app runs fully offline / inside the app bundle.
- **Safe areas / notch:** `viewport-fit=cover` is set; if the notch overlaps a control we
  can add `env(safe-area-inset-*)` padding.

## Android (bonus)
The same setup works for Android: `npm install @capacitor/android && npx cap add android`,
then build in Android Studio for the Play Store.
