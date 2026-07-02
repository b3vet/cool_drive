// Increment the iOS build number (CURRENT_PROJECT_VERSION) in the Xcode project.
// TestFlight/App Store require a higher build number for every upload.
//   npm run bump          -> increments the build number by 1 (all configs)
// Marketing version (MARKETING_VERSION, e.g. 1.0) is left alone — bump that by hand
// in Xcode when you cut a new public version.
import { readFile, writeFile } from 'node:fs/promises';

const PBX = 'ios/App/App.xcodeproj/project.pbxproj';
const re = /CURRENT_PROJECT_VERSION = (\d+);/g;

let text;
try {
  text = await readFile(PBX, 'utf8');
} catch (e) {
  console.error(`Could not read ${PBX} — is the iOS project set up? (npx cap add ios)`);
  process.exit(1);
}

const nums = [...text.matchAll(re)].map((m) => Number(m[1]));
if (nums.length === 0) {
  console.error('No CURRENT_PROJECT_VERSION found in the Xcode project.');
  process.exit(1);
}

const next = Math.max(...nums) + 1;
text = text.replace(re, `CURRENT_PROJECT_VERSION = ${next};`);
await writeFile(PBX, text);

const marketing = (text.match(/MARKETING_VERSION = ([\d.]+);/) || [])[1] || '?';
console.log(`Build number bumped to ${next}  (app version ${marketing} (${next})). Ready to Archive → TestFlight.`);
