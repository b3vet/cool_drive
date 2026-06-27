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

## Ship to the App Store with Capacitor

Capacitor wraps the existing web game in a native iOS shell (WKWebView) and gives you an
Xcode project to submit. Near-zero rewrite.

### Prerequisites
- A Mac with **Xcode** installed.
- Your **Apple Developer** account (you have this).
- Node.js (you have this).

### One-time setup (run on your Mac, in this folder)
```bash
npm install @capacitor/core @capacitor/cli @capacitor/ios
npm run build:web          # assembles ./www (the webDir Capacitor uses)
npx cap add ios            # creates the ios/ native project
```
`capacitor.config.json` is already here (appId `io.cooldrive.app`, appName `CoolDrive`,
webDir `www`) — change `appId` to your reverse-domain bundle id.

### Each time you change the game
```bash
npm run ios                # = build:web + cap sync ios + cap open ios
```
This rebuilds `www`, copies it into the iOS project, and opens Xcode.

### In Xcode (one-time configuration)
1. **Signing & Capabilities** → select your **Team** (your Apple Developer account).
   Set a unique **Bundle Identifier**.
2. **General → Deployment Info → Device Orientation**: check **Landscape Left** and
   **Landscape Right** only (uncheck portrait) so it's landscape-locked.
3. **Info.plist** → add **`NSMotionUsageDescription`** with a string like
   *"Used to steer the car by tilting your device."* — required for the gyroscope.
4. **App icons / splash:** generate them from `icon.svg` (export a 1024×1024 PNG first):
   ```bash
   npm install -D @capacitor/assets
   npx capacitor-assets generate --ios   # uses a 1024px source icon
   ```
5. Pick your device (or a simulator — note the simulator has no gyroscope, so steering
   won't work there; test tilt on a real device) and press **Run**.

### Submit
- **Product → Archive** → **Distribute App → App Store Connect**.
- In **App Store Connect**: create the app record, add screenshots, description, and
  submit for review.

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
