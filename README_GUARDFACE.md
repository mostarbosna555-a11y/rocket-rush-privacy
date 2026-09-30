# 🛡️ GuardFace — anti-theft face guard for Android

GuardFace watches your lock screen. When **someone who isn't you** tries to unlock the phone,
it silently photographs them with the front camera, compares their face to yours, and if it
does **not** match it **locks the phone immediately** and **emails you the intruder's photo**.

This is a real, buildable Android app — Kotlin, CameraX, Google ML Kit face detection, Device
Admin, and Gmail SMTP for the alert email.

---

## ⚠️ Honest limitations (read this)

Android deliberately prevents normal apps from doing a couple of things you might have wanted:

| What you asked | What Android actually allows |
|---|---|
| "They can't unlock it at all" | The real lock screen (PIN/pattern/biometric) stays Android's job. GuardFace reacts to a **failed** unlock attempt — it can't replace the OS lock screen. |
| "Automatically shut the whole phone down" | A regular app **cannot power the phone off** — that needs root or a system/OEM app. The strongest lawful response is an **instant Device-Admin lock** (`lockNow()`), which is what GuardFace does. It can also factory-wipe on request (not enabled by default). |
| "Face recognition, third party" | ✅ Uses Google ML Kit (on-device, offline). See the accuracy note below. |

**Face-match accuracy:** the recogniser turns your face's landmark geometry into a signature and
compares with cosine similarity. That's solid for a hobby/anti-theft guard but it is **not**
bank-grade biometrics. To upgrade, drop a MobileFaceNet/FaceNet `.tflite` model into
`FaceEngine.signatureFor()` — the rest of the app doesn't change.

Only install this on **your own phone**. It's a personal anti-theft tool, not something to run
on anyone else's device.

---

## How it works

1. **Device Admin** — you grant GuardFace admin rights so it can lock the phone.
2. Android notifies `AdminReceiver.onPasswordFailed()` on every wrong unlock attempt.
3. `Guardian.runIntruderCheck()`:
   - `IntruderCamera` takes a **silent** front-camera photo (no preview needed),
   - `FaceEngine` (ML Kit) makes a face signature and compares it with your enrolled one,
   - if it's **not you** → `lockNow()` + `MailSender` emails you the photo over Gmail SMTP.
4. `SentinelService` is a foreground service that keeps the app alive so the callbacks fire.

## Setup (in the app)

1. Enter the **alert email** (where intruder photos go).
2. Enter a **sender Gmail + Gmail App Password** (Google Account → Security → 2-Step
   Verification → App passwords — it's a 16-char password, *not* your normal one).
3. **Enroll your face** (face the front camera, tap capture).
4. **Enable Device Admin**, then **Start protection**. Use **Run a test** to try it.

## Build it yourself

```bash
# needs JDK 17+ and the Android SDK (platform 34, build-tools 34)
export ANDROID_HOME=/path/to/android-sdk
./gradlew :app:assembleDebug
# APK -> app/build/outputs/apk/debug/app-debug.apk
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

No SDK locally? Push to GitHub and let GitHub Actions build it — see
`.github/workflows/android.yml` (produces the APK as a downloadable artifact).

## Project layout

```
app/src/main/java/com/guardface/sentinel/
  MainActivity.kt      setup UI (enroll, settings, permissions)
  Settings.kt          SharedPreferences store
  FaceEngine.kt        ML Kit face signature + matching
  IntruderCamera.kt    silent front-camera capture (own LifecycleOwner)
  Guardian.kt          the intruder-check brain (capture → match → lock + email)
  AdminReceiver.kt     device admin; fires on failed unlock
  SentinelService.kt   foreground keep-alive service
  MailSender.kt        Gmail SMTP alert with photo attachment
  BootReceiver.kt      re-arms after reboot
```
