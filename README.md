# Hello World Android App

A minimal Android app that displays a web page with a counter button. Works offline.

## What it does

Opens a single page with a **+1** button. Every tap increments the counter.

## Build & install on your phone

### Requirements

- [Android Studio](https://developer.android.com/studio) (free)
- An Android phone with **USB debugging** enabled

### Steps

1. **Clone this repo**
   ```
   git clone https://github.com/Nateowami/blank-sheet.git
   ```

2. **Open in Android Studio**
   - Launch Android Studio → *Open* → select the `blank-sheet` folder
   - Wait for Gradle sync to finish (first time may take a few minutes)

3. **Connect your phone**
   - On your phone: *Settings → About phone → tap "Build number" 7 times* to unlock Developer Options
   - Then: *Settings → Developer options → enable USB debugging*
   - Plug the phone into your computer with a USB cable
   - Accept the "Allow USB debugging?" prompt on the phone

4. **Run the app**
   - In Android Studio, select your device from the device dropdown (top toolbar)
   - Click the green **Run ▶** button
   - The app installs and opens automatically on your phone

### Alternative: build the APK manually

If you have the Android SDK and Gradle installed:
```
./gradlew assembleDebug
```
The APK will be at `app/build/outputs/apk/debug/app-debug.apk`.

Install it with:
```
adb install app/build/outputs/apk/debug/app-debug.apk
```