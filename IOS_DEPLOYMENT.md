# CoolDrive — iOS Deployment Runbook

**Living document.** Follow it top-to-bottom for each App Store release. Copy-paste blocks are
marked `▸ PASTE`. When something changes (new screenshots, new copy, a review note), update the
relevant section and add a dated entry to the **[Version Log](#version-log)** at the bottom so we
keep a versioned history of the game across its lifetime.

## App facts (rarely change)

| Field | Value |
|---|---|
| App name | **CoolDrive** |
| Bundle ID | `b3vet.cooldrive.app` |
| Apple Team ID | `U2WFNLXV3S` |
| Marketing version | `1.0` (`MARKETING_VERSION` in the Xcode project) |
| Build number | bumped by `npm run bump` (`CURRENT_PROJECT_VERSION`) |
| Tech | three.js game in a Capacitor **WKWebView** shell, fully offline |
| Data collected | **None** (no accounts, ads, IAP, analytics, or network calls) |
| Orientation | Landscape only |

---

## 0. One-time prerequisites (do once, ever)

- [ ] **Apple Developer Program** membership active ($99/yr), signed into Xcode (Settings → Accounts).
- [ ] In Xcode → target **App** → **Signing & Capabilities**: **Automatically manage signing** is ON and the **Team** is set to `U2WFNLXV3S`. This makes Xcode mint the distribution certificate + provisioning profile automatically.
- [ ] Build with a **current Xcode (26.x)** — from **28 April 2026** Apple requires apps to be built against the **iOS 26 SDK or later**. Update Xcode before then or uploads will be blocked.
- [ ] **Decision — iPhone only, or iPhone + iPad?** The project currently targets **both** (`TARGETED_DEVICE_FAMILY = "1,2"`). If iPad stays enabled, Apple **requires a 13" iPad screenshot set** and the game must play acceptably on iPad (note: tilt-steer is awkward on iPad — touch controls still work). **Recommended for launch: iPhone-only.** To switch: Xcode → target → **General → Supported Destinations**, remove iPad (or set `TARGETED_DEVICE_FAMILY = "1"`). Decide before your first screenshots.

---

## 1. One-time App Store Connect setup — **and the "it's an App, not a Game" fix**

Do this once when the app record is first created (or now, to correct the category).

1. Go to **[App Store Connect](https://appstoreconnect.apple.com) → Apps**.
2. If the app record doesn't exist yet: **( + ) → New App** →
   - Platform: **iOS**
   - Name: **CoolDrive**
   - Primary Language: **English (U.S.)**
   - Bundle ID: **`b3vet.cooldrive.app`** (pick from the list; created by Xcode's automatic signing)
   - SKU: any private string, e.g. **`cooldrive-ios-001`** (never shown to users)
3. **Set the category to Games** — this is what makes it list as a *game*, not a generic app:
   - Open the app → left sidebar → **App Information** (this is **app-level**, not per-version).
   - Under **Category**:
     - **Primary Category → Games**
     - Then choose up to two **Games subcategories** → **Racing** (primary genre) and **Arcade** (secondary).
   - **Save.**
   - > Category lives in App Information and is editable later, but if a version is *in review* the change may not take effect until that submission clears. Set it correctly **before** submitting.
4. Fill the rest of **App Information**:
   - **Content Rights**: "No, it does not contain, show, or access third-party content."
   - **Age Rating**: see [§5](#5-age-rating).

---

## 2. Per-release: build & upload

Run from the repo root:

```bash
npm run bump        # increments the iOS build number (CURRENT_PROJECT_VERSION)
npm run ios         # builds the web bundle, cap sync, and opens Xcode
```

Then in **Xcode**:

1. Top toolbar: set the run destination to **Any iOS Device (arm64)** (you cannot archive with a Simulator selected).
2. **Product → Archive.** Wait for it to finish; the **Organizer** window opens automatically.
3. Select the new archive → **Distribute App** → **App Store Connect** → **Upload** → step through signing/summary → **Upload**.
4. Wait for the "Upload successful" and then for the build to finish **processing** in App Store Connect (a few minutes to ~1 hour; you'll get an email).

> **Alternative upload:** export the `.ipa` and use the **Transporter** app (free, Mac App Store) instead of the Organizer.
>
> **Export compliance:** already handled — `ITSAppUsesNonExemptEncryption=false` is set in `Info.plist`, so App Store Connect won't ask the encryption question each upload.

---

## 3. Per-release: fill the version page (all the copy to paste)

App Store Connect → your app → the **iOS App** version (create a new version with **( + ) Version or Platform** if needed, e.g. `1.0`). Fill every field:

### Name — max 30 chars
```
CoolDrive
```
*(ASO alternative if you want keywords in the name: `CoolDrive: Drift & Roam` — 23 chars.)*

### Subtitle — max 30 chars
▸ PASTE
```
Endless low-poly drift racer
```

### Promotional Text — max 170 chars (editable anytime, no new build needed)
▸ PASTE
```
Chase the horizon in an endless neon world. Drift, link combos, and roam procedurally generated roads that never end — no ads, no timers, no internet needed.
```

### Description — max 4000 chars
▸ PASTE
```
CoolDrive is a low-poly arcade drift game about one simple joy: sliding a car sideways through an endless, hand-crafted-looking world that generates itself forever as you drive.

There is no finish line. Point the car at the horizon and go. Roads, towns, circuits, and glowing landmarks stream into view procedurally, so every drive is different and the map never runs out.

DRIFT FOR SCORE
Break traction, hold the slide, and link corner after corner to build a combo multiplier. Shave past obstacles for close-call bonuses and chain direction changes for style. Bank a clean run for a new best.

AN ENDLESS WORLD
Cruise a living open world with a rolling day-night cycle — golden hour, cool dawn, and neon night — plus rain, ambient traffic-free freedom, and an in-game radio to score your drive.

THINGS TO FIND
Wild drift circuits with timed ring runs, neon boost gates, slalom courses, skidpads, a drift gymkhana park, and towering lookouts that rise above the fog. Unlock achievements as you go.

PICK YOUR RIDE
Three cars, each with its own feel — the balanced Falcon GT, the low and slippery Night Viper, and the heavy, big-sliding Brute V8.

PLAY YOUR WAY
Tilt your phone to steer, or use on-screen controls. Two handling profiles: raw and twitchy, or forgiving with assist.

BUILT TO RESPECT YOU
- Fully offline — plays anywhere, no internet required
- No ads, no in-app purchases, no timers
- No accounts and no data collection

Just you, the car, and an endless road. Go find the drift.
```

### Keywords — max 100 chars, comma-separated, **no spaces after commas**
▸ PASTE
```
drift,driving,racing,arcade,car,cars,neon,endless,drive,race,relax,offline,retro,roam,lowpoly
```

### What's New in This Version — max 4000 chars
- **First release (1.0):** not required; you may leave it or use a short launch note.
- **Updates:** write per-version notes. For the current build:
▸ PASTE (current)
```
Big performance and thermal update: smoother frame rate, cooler running on long sessions, sharper visuals on the default setting, adaptive quality that scales to your device, and nicer shadows. Plus an optional on-screen performance overlay in Settings.
```

### URLs, Copyright, Version
- **Support URL:** *(required — a reachable page; the CoolDrive web build, a simple landing page, or a support email page works)* — e.g. `https://cooldrive.<your-domain>` — **fill this in.**
- **Marketing URL:** *(optional)* — same site or blank.
- **Copyright:** `© 2026 Berke Ucvet` *(adjust to your legal name/company)*.
- **Version:** `1.0` (must match/precede the uploaded build's marketing version).

### Build
- In the **Build** section, click **( + )** and select the processed build (e.g. **1.0 (9)**).

---

## 4. Screenshots

Capture from the game in **landscape** (it's a landscape game).

- **Required set: 6.9" iPhone** → **2868 × 1320 px** (landscape). *(A 6.5" set at 2778 × 1284 is also accepted in lieu of 6.9".)* App Store Connect scales this down for smaller iPhones — you don't upload every historical size.
- **iPad:** only if the app still supports iPad (see the §0 decision) → **13" iPad**, **2752 × 2064 px** (landscape).
- **Count:** 1–10 per size. Aim for **4–6** strong shots: a drift with smoke, the neon-night city, a ring run, a lookout/landmark, the car select.
- **Format:** PNG or JPG, no transparency.
- **App preview video (optional):** up to 3 per size, 15–30 s.

**Tip:** grab clean frames from the running game (device screen recording, or the web build at the exact device resolution) and crop to the exact pixel size. Turn the performance overlay **off** for marketing shots (Settings → Performance overlay).

---

## 5. Age rating

App Information → **Age Rating → Edit**. Apple's 2025 system uses tiers **4+, 9+, 13+, 16+, 18+**.
Answer the questionnaire honestly for a mild cartoon driving game:

- Cartoon/Fantasy Violence, Realistic Violence, Sexual Content, Profanity, Horror, Gambling, etc. → **None**.
- Unrestricted web access → **No** (it's offline). In-app controls to limit content → **No / N/A**.
- Social-media capability (question being added mid-2026) → **No**.

**Expected result: 4+.**

---

## 6. App privacy ("nutrition label")

App Store Connect → **App Privacy** → **Get Started**:

- **"Do you or your third-party partners collect data from this app?"** → **No, we do not collect data from this app.**
- **Save.** No further questions branch; the product page will show **"Data Not Collected."**

> Keep this accurate. If a future version ever adds analytics, ads, accounts, or any network telemetry, this must be updated.

### Privacy manifest (contingency)
Apple may reject an upload if a "required-reason" API is used without a `PrivacyInfo.xcprivacy`.
CoolDrive only bundles `@capacitor/haptics`, so it may not trigger this — **but if your upload is
rejected for a missing/invalid privacy manifest**, add this file to the **App** target in Xcode
(right-click the `App` group → *Add Files* → create `PrivacyInfo.xcprivacy`, and ensure **Target
Membership → App** is checked):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>NSPrivacyTracking</key><false/>
  <key>NSPrivacyTrackingDomains</key><array/>
  <key>NSPrivacyCollectedDataTypes</key><array/>
  <key>NSPrivacyAccessedAPITypes</key>
  <array>
    <dict>
      <key>NSPrivacyAccessedAPIType</key>
      <string>NSPrivacyAccessedAPICategoryUserDefaults</string>
      <key>NSPrivacyAccessedAPITypeReasons</key>
      <array><string>CA92.1</string></array>
    </dict>
  </array>
</dict>
</plist>
```

---

## 7. Submit for review

1. On the version page, confirm: build selected, screenshots, description/keywords, **Age Rating**, **App Privacy**, category = **Games/Racing**.
2. **Release option** (bottom of the version page):
   - **Automatically release** after approval, or
   - **Manually release** (you press the button), or
   - **Scheduled** on a date.
   - *(Phased release — the 1%→100% over 7 days rollout — applies only to **updates**, not a brand-new app's first release.)*
3. Click **Add for Review → Submit for Review**.
4. **Review time:** Apple states ~90% of submissions are reviewed within **24 hours**; allow a buffer around launch dates. For time-critical fixes you can request **Expedited Review**.

---

## 8. Avoiding a rejection (WebView-wrapped game)

The one real risk for a Capacitor app is **Guideline 4.2** ("beyond a repackaged website"). CoolDrive is a
self-contained offline game, which is exactly what passes — just make sure the review build proves it:

- [ ] It **runs fully in Airplane Mode** (all assets bundled; no loading a remote URL). This is the strongest defense.
- [ ] It presents as a native game: **Games** category, game screenshots, native icon + launch screen, no browser chrome/address bar, correct safe-area + orientation handling.
- [ ] It has **lasting entertainment value** (endless world, modes, cars, achievements) — it does.
- [ ] Guideline **2.5.6** (must use WebKit) is satisfied automatically — Capacitor uses **WKWebView**.

If a reviewer still flags 4.2, reply in **Resolution Center**: emphasize it's a fully offline, self-contained native game (not a website wrapper), and note it runs with no network.

---

## Quick per-release checklist

```
[ ] npm run bump                     # new build number
[ ] npm run ios                      # build web + sync + open Xcode
[ ] Xcode: Any iOS Device → Product → Archive
[ ] Organizer → Distribute App → App Store Connect → Upload
[ ] Wait for build to finish processing (email)
[ ] App Store Connect: new version → paste Name/Subtitle/Promo/Description/Keywords/What's New
[ ] Select the build
[ ] Screenshots (6.9" iPhone landscape; iPad if supported)
[ ] Age Rating (→ 4+), App Privacy (Data Not Collected), Category (Games/Racing)
[ ] Release option → Add for Review → Submit
[ ] git: bump + changes committed & pushed
```

---

## Version Log

Newest first. Add an entry per submitted build.

### 1.0 (build 9) — 2026-07 — *pending submission*
- **Focus:** performance & thermal optimization pass + first App Store submission prep.
- Time-scheduled shadows (every-frame car shadow, no flicker), Lambert shading tiers, fog-distance
  culling, adaptive quality governor (fps + native `ProcessInfo.thermalState`), sharpened default
  ("Medium (recommended)"), soft shadows on all tiers, reload-safe quality switch, mobile
  performance overlay toggle in Settings.
- Added `ITSAppUsesNonExemptEncryption=false` to skip the per-upload export prompt.
- App Store Connect: set **Primary Category = Games / Racing + Arcade** (was listing as an app).
- **To verify at submission:** iPad support decision (§0), Support URL filled, screenshots recaptured.

### 1.0 (build 8) — 2026-07
- Prior archive of the optimization work (superseded by build 9).

<!-- Template for future entries:
### <marketing version> (build <n>) — <YYYY-MM> 
- Focus:
- Changes:
- What's New text used:
- Notes / review outcome:
-->
