# Radio music

Drop your `.mp3` (or `.ogg`/`.m4a`) song files in this folder, then register each one
as a radio station in `src/audio.js`:

```js
export const RADIO_STATIONS = [
  { name: 'CoolDrive FM', generative: true },          // built-in synth station
  { name: 'Night Run',    url: './audio/night-run.mp3' },
  { name: 'Sunset Cruise', url: './audio/sunset.mp3' },
  // ...up to as many as you like
];
```

- Tracks **loop** by default. Add `stream: true` for a live internet-radio stream (no loop).
- The radio widget's `›` button cycles through every station (each song = one station).
- No CORS setup needed — songs play through a plain `<audio>` element, so they work from
  this folder, a CDN, or object storage.
- Keep bitrate ~128–192 kbps to keep files small.
