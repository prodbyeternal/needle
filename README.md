<div align="center">
  <div style="font-family: Outfit, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; font-size: 32px; font-weight: 700; letter-spacing: 0.42em;">
    N E E D L E
  </div>
  <p><strong>A tactile vinyl-style music player for local audio files.</strong></p>
</div>

## About

NEEDLE is a desktop music player built around the feeling of using a physical record deck. Instead of presenting music as a simple list with a play button, it gives tracks a turntable interface: a spinning platter, tonearm cueing, RPM changes, pitch control, scratching, transport controls, waveform display, library management, and visual ambience from cover art.

The app is designed for local music playback. Songs are loaded from files or imported into a saved library, then played through a Web Audio engine with vinyl-inspired controls and optional effects.

## What It Does

NEEDLE lets you:

- Load audio files by dragging them onto the player.
- Import songs from your Music folder or selected folders.
- Save imported tracks to a local library.
- Play, pause, stop, reverse, and eject tracks.
- Move the tonearm to cue or seek through a song.
- Scratch the platter interactively.
- Change RPM between 16, 33, 45, and 78.
- Adjust pitch with a fine pitch slider.
- Add surface noise/crackle for a more vinyl-like sound.
- View scrolling waveform information.
- Display track metadata such as title, artist, BPM, and key.
- Estimate BPM and musical key locally.
- Update displayed BPM/key based on RPM and pitch changes.
- Use cover art as a blurred background atmosphere.
- Customize the interface with light/dark mode, color presets, and a custom accent color.
- Apply audio effects from the FX panel.

## Main Features

### Turntable Playback

The core interface behaves like a digital turntable. The platter spins according to motor state, RPM, direction, and pitch. The tonearm controls cueing and playback position, while the transport section handles play/pause, reverse, stop, and eject.

### Local Library

Tracks can be imported and saved locally inside NEEDLE's library. Library entries show cover art, title, artist, album, and duration. Saved tracks can be loaded again later or removed from the library with confirmation.

### BPM and Key Analysis

NEEDLE analyzes tracks on the user's machine instead of depending on an online BPM database. It estimates tempo and musical key from the audio itself, then adjusts the displayed values when the playback speed changes through RPM or pitch.

### Effects

The control section includes a dedicated effects view for shaping playback. Effects include EQ and time/modulation-style controls such as reverb, chorus, and delay.

### Visual Customization

The interface supports both light and dark base themes, plus accent color moods. Users can choose from built-in presets or set a custom color. Accent colors affect controls, highlights, glows, screen styling, and other interactive UI elements.

### Cover Art Backdrop

When a track has cover art, NEEDLE uses it as a subtle blurred backdrop behind the player. The image is kept soft and low-contrast so it adds atmosphere without reducing UI readability.

### Onboarding

On first launch, NEEDLE shows a setup flow that introduces the player, asks how the user plans to use it, offers music import options, and lets the user choose the initial look of the app.

## Supported Audio Formats

NEEDLE scans and imports common audio formats:

- MP3
- WAV
- FLAC
- OGG
- M4A
- AAC
- AIFF

## Keyboard Controls

| Action | Default Key |
| --- | --- |
| Motor on/off | Space |
| Play/pause | P |
| Stop/reset | S |
| Reverse direction | R |
| Eject record | E |
| Toggle library | L |
| Toggle settings | , |

Keyboard bindings can be changed from Settings.

## Tech Stack

- Electron
- Web Audio API
- Canvas rendering
- IndexedDB and localStorage for local app state
