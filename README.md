# gridi

Route based midi generation.

## quickstart

```sh
npm start
```

```
http://localhost:8080
```

Web MIDI needs a secure context, so use `localhost` or https. Any static server
works; there is nothing to build.

It is published from `main` to <https://bobbymeyer.github.io/gridi/>, which is
the secure context the browser wants and the copy the embed below loads. That
needs Pages switched on once, under Settings → Pages → Build and deployment →
Source: **GitHub Actions**; the workflow cannot do it for itself.

```sh
npm test
```

## embedding

gridi builds itself into an element, so it can run somewhere that is not its
own page — a note on bobbymeyer.com, for instance.

```js
// Before the import, so the module does not start itself against #app.
window.__gridiEmbedded = true;
const { initGridi, destroyGridi } = await import('https://bobbymeyer.github.io/gridi/src/main.js');

initGridi(element, {
  embedded: true,        // theme the mount, not the host page's <html>
  mark: false,           // drop the lockup, keep the transport
  storagePrefix: 'note:' // its own patch, not the one you are working on
});

destroyGridi();          // stops the clock, the audio and the MIDI ports
```

Every lookup is scoped to the mount, so an embedded copy cannot collect the
host page's elements. Its stylesheet is a whole application's worth of chrome
though — a `*` reset, rules on `html, body` — so mount it in a shadow root and
let the two documents keep their own styling. `tests/embed.html` does exactly
that, and is the check that neither side reaches the other.

Give the mount a height. gridi fills it, and lays itself out to the width it
finds there rather than the window's, so the same copy works in a column of
text and on a phone.

Embedded, gridi waits to be clicked into before it answers the keyboard, the
wheel or a paste, and lets go the moment you click out — a reader is reading,
and a figure that swallows space, ⌘S and the scroll wheel has taken the page
over. On its own page it takes all three from the start.

The SoundFont it ships with is thirty-two megabytes, and it is fetched on the
first press of play rather than on load, so a page that merely mentions gridi
costs its readers nothing.

Open `http://localhost:8080/tests/audio-check.html` for the synth checks, which
need a browser.

## the grid

A grid cell is worth a note value. A pulse crosses one cell in that much
musical time, so a line's length is how long its pulses take to walk it.
Moving a node retimes the patch.

| Setting | Effect |
| --- | --- |
| Grid | What one cell is worth: 1/1 to 1/32, plus 1/4T, 1/8T, 1/16T. Default 1/16. |

The field is ruled in three weights: light for the cell, medium for the beat,
heavy for the bar. They follow the grid setting.

Select a line to read its length in cells and what that comes to in beats.

| Node | What distance does to it |
| --- | --- |
| Split | Fans out on one instant; each branch lands by its own length. Level branches arrive together, a row apart flams. |
| Logic | Its feeds must be drawn the same length, or the pulses it catches never coincide. |
| Param, Node scope | Writes when the pulse passes it; the target reads when its own pulse arrives. Place it near its target, or use Signal scope, which rides with the pulse. |
| Key, latched | Writes the project key. Notes read it when they sound, so a chord change lands on the bar however far the pulses have to travel. |

## nodes

| Node | In | Out | Does |
| --- | --- | --- | --- |
| Pulse | — | many | Emits on a beat at project BPM. Owns the feel and the starting key. |
| MIDI In | — | many | A note played on an attached keyboard sends a pulse from here. |
| Split | 1 | many | Sends one pulse down every outgoing line at once. |
| Logic | many | many | Fires when incoming pulses line up inside a window. |
| Chance | 1 | many | Lets a pulse through a set percentage of the time. |
| Router | 1 | many | Sends each pulse down a single outgoing line. |
| Note | 1 | many | Fires a scale degree as MIDI on every channel the line carries. |
| Voice | 1 | many | Two oscillators, a resonant filter and an ADSR, in the browser. |
| LFO | 1 | many | Sends a moving value down its lines many times a beat. |
| Param | 1 | many | Changes a value instead of firing a note, then passes the pulse on. |
| Key | 1 | many | Rewrites scale and key for everything downstream. |

### Pulse

| Control | Range |
| --- | --- |
| Active | on / off |
| Division | 1/1, 1/2, 1/4, 1/8, 1/16, 1/32, 1/2T, 1/4T, 1/8T, 1/16T, 1/4., 1/8. |
| Swing | 0–60%, delays every second step |
| poly steps / in the time of | 1–16 each, steps against divisions |
| Humanize | 0–40 ms |
| Euclid | hits, steps, rotate |
| Key from | project / this node |
| Base ch | 1–16 |
| Velocity | 1–127 |

### MIDI In

| Control | Range |
| --- | --- |
| Listen on | 0–16, zero is omni |
| Played note | Key, Transpose, Gate |
| Centre | 0–127, the note that means no transposition |
| Use velocity | on / off |
| Base ch | 1–16 |

### Split, Logic, Chance, Router

| Node | Control | Range |
| --- | --- | --- |
| Split | Stagger | 0–0.5 beat between branches |
| Logic | Mode | AND, OR, N, XOR |
| Logic | Needs | 1–8, in N mode |
| Logic | Window | 1–120 ms |
| Chance | Pass | 0–100% |
| Chance | Mode | Free, Drift |
| Router | Mode | Cycle, Ping, Rand, No rpt |

### Note

| Control | Range |
| --- | --- |
| Degree | −21 to 22 |
| Octave | −1 to 8 |
| Overflow | Extend, Fold, Clamp |
| Velocity | 0–127, zero follows the line |
| Length | 0.02–4 beats |
| Ratchet | 1–8 |
| Send MIDI | on / off |
| Audible | on / off, the built-in blip |

### Voice

| Control | Range |
| --- | --- |
| Degree, Octave, Overflow | as Note |
| Wave A / B | sine, triangle, square, sawtooth |
| Octave A / B | −3 to 3 |
| Semitones A / B | −12 to 12 |
| Detune A / B | −50 to 50 cents |
| Level A / B | 0–1 |
| Cutoff | 80–12000 Hz |
| Reso | 0.1–20 |
| Env depth | 0–4 octaves |
| Attack | 0.001–2 s |
| Decay | 0.005–2 s |
| Sustain | 0–1 |
| Release | 0.005–3 s |
| Gate | 0.02–4 beats |
| Level | 0–1 |
| Voices | 1–32, oldest stolen past the limit |

### LFO

| Control | Range |
| --- | --- |
| Shape | Sine, Triangle, Ramp, Saw, Square, Random, Drift |
| Cycle | 1/16, 1/8, 1/4, 1/2, 1 bar, 2 bars, 4 bars, 8 bars |
| Phase | 0–100% of a turn |
| Depth | 0–100% |
| From / To | 0–127 each |
| Steps | 1–48 values per beat |
| Reset on pulse | on / off |
| Base ch | 1–16 |

An LFO is patched into a Param node, which sends the value. Note, Voice, Logic,
Chance and Router ignore waves; Split, Key and Param act on them.

### Param

| Control | Range |
| --- | --- |
| Scope | Node, Signal, CC |
| Target / Param | in Node scope |
| Param | Velocity, Transpose, Degree shift, in Signal scope |
| Controller | 0–127, in CC scope |
| Mode | Seq, Rand, Walk, Add |
| Values | space separated, in Seq mode |
| Amount | in Add and Walk modes |
| Min / Max | outside Seq mode |

### Key

| Control | Range |
| --- | --- |
| Mode | Set, Cycle, Rand |
| Key / Scale | in Set mode |
| Changes | `root:scale` pairs, e.g. `0:minPent 5:major` |
| Transpose | −24 to 24 semitones |
| Latch | writes the project key |

## lines

A line carries state, not just a connection.

| Property | Behaviour |
| --- | --- |
| Channels | A set, each with its own output, transpose and velocity. One pulse fans out across all of them. |
| Channel mode | Inherit passes on what arrived; Set here overrides from this line down. |
| Scale and key | Same two modes. Set here retunes everything the line feeds. |
| Travel | Read-only. The line's length in cells, and what that comes to in beats. |
| Extra delay | 0–4 beats on top of the travel time, for anything the grid cannot say. |
| Mute | Stops passing pulses without unpatching. |

Scales: Major, Nat Minor, Harm Minor, Mel Minor, Dorian, Phrygian, Lydian,
Mixolydian, Locrian, Maj Pent, Min Pent, Blues, Whole Tone, Chromatic.

Degree overflow: `Extend` carries past the end of the scale into the next
octave, `Fold` wraps inside one octave, `Clamp` stops at the top.

## library

**Library** is the second tab in the header, and it is the patch's tab as well
as the shelf's: the patch's name and what can be done to it — new, demo, save,
open, sounds — sit over the patches that ship with Gridi, each with what it is.
Picking one opens it like any other patch, undo included, and the strip stays
where it is, so the shelf is still there to try the next one from.

Gridi opens on Bossa Nova out of that library, so a first visit arrives at a
patch doing the thing the app is for rather than at an empty grid. **Demo** is
the other starting point: a patch of built-in voices, which needs no SoundFont
to make a sound.

| Patch | BPM | What it is |
| --- | --- | --- |
| Bossa Nova | 132 | Comp, bass, melody and a latched key on ii-V-I. The clave is five lines of different lengths out of one Split. |
| Samba | 96 | Caixa, surdo, tamborim, agogô and a bass. The surdo's line runs a beat further than the rest, which is what puts it on two and four. |
| House | 124 | Four to the floor, offbeat bass and a stab. The open hat shares the kick's clock and is drawn an eighth longer. |
| Hip-Hop | 88 | Boom-bap kit with swung hats. One clock a bar, three kicks at their own distances. |
| Ambient | 60 | Five loops of 5, 7, 11, 13 and 16 beats, after the tape loops on *Music for Airports*. They come back into line once every 22 hours. |

The figures the percussion patches use, in sixteenths from the downbeat:

| Figure | Hits |
| --- | --- |
| Bossa clave, 3-2 | 0, 6, 12, 20, 28, over two bars |
| Samba tamborim | 0, 3, 6, 10, 12, 14 |
| Hip-hop kick | 0, 7, 10 |

Drum voices are pinned with a chromatic line rooted at C, so a Note node's
degree is a General MIDI note number and the key never moves them.

Patches live in `patches/`, listed in `patches/index.json`. Add one by saving a
patch into that folder and adding a line to the index. The ones that ship were
built by the scripts in `tools/`, because an offset is a distance and solving
several of them is arithmetic:

```sh
node tools/build.mjs
```

## soundfont

Gridi ships with **GeneralUser GS 2.0.3 by S. Christian Collins**, and fetches
it on the first press of play. 261 instruments and 13 drum kits in 32MB — too
much to spend on somebody who has not asked to hear anything yet, which is what
loading it on boot spent.

<https://www.schristiancollins.com/generaluser>

His licence is in `soundfont/LICENSE.txt`, unaltered. It permits use in
software projects and redistribution, and asks that nobody link directly to his
download files — which is why the copy is in this repository rather than
fetched from his site. If you get use out of it,
[buy him a coffee](https://buymeacoffee.com/schristiancollins).

Drop any other `.sf2` on the canvas to play through that instead.

| | |
| --- | --- |
| Format | SoundFont 2, sixteen or twenty-four bit. Compressed `.sf3` is not read |
| Stereo | A zone naming one half of a pair plays both, placed left and right. A font that names both itself keeps its own panning |
| A dropped font | Kept in IndexedDB, so it survives a reload. **forget it**, in the Sounds panel, goes back to the bundled one |
| Channel 10 | Looked up in bank 128, where a General MIDI font keeps its kits |
| Modulators | Velocity and key number, over the two default routings. A font's own replace a default that reads and writes the same things |
| Not read | Modulators sourced from the wheel, the pedals, aftertouch or the bender, since none of them reach the internal player. Reverb and chorus sends, which Gridi has nowhere to put. Samples that live in a synthesiser's ROM, which a file holds the header of and none of the sound |

Velocity goes through the font rather than around it: it reaches loudness and
filter cutoff by the routings the font carries, so an instrument gets darker as
well as quieter as you play softer.

Samples are decoded when a preset is first played and kept after, so a
thirty-megabyte font costs the file plus the few sounds a patch uses.

With no font at all, Note nodes audition through a single triangle oscillator.
That is a click track for building a patch, not an instrument.

## sounds

**Sounds**, on the library tab, lists the channels a patch plays on, worked out
from the graph, and sets a General MIDI program for each. Gridi sends them as
program changes 50ms before the first note, so a receiving module is on the
right sound before it has anything to play.

| | |
| --- | --- |
| Numbers | 0–127, as they go down the wire. Every printed GM chart counts from 1 |
| Channel 10 | Offered as kits rather than instruments |
| Leave as it is | No entry, no program change: the device keeps whatever it had |

Bank select is not sent, so a module with more than 128 sounds needs its bank
chosen on the device.

What the library asks for:

| Patch | ch 1 | ch 2 | ch 3 | ch 4 | ch 10 |
| --- | --- | --- | --- | --- | --- |
| Bossa Nova | | Acoustic Bass | Acoustic Guitar (nylon) | Flute | |
| Samba | | Acoustic Bass | | | Standard Kit |
| House | | Synth Bass 1 | Electric Piano 1 | | Electronic Kit |
| Hip-Hop | | Electric Bass (finger) | | Vibraphone | Standard Kit |
| Ambient | Pad 2 (warm) | | | | |

Ambient also sends CC 74 from an LFO, which is filter cutoff by convention.

## patches

A patch is one JSON file: nodes, lines, tempo, grid, key. Name it on the
library tab; **Save** names the file after it.

| To open one | How |
| --- | --- |
| A file | Drop it anywhere on the canvas, or press **Open** |
| A SoundFont | Drop the `.sf2` on the canvas too, replacing the bundled one |
| Its text | Paste it onto the canvas |

Opening replaces the canvas and goes on the undo stack. ⌘Z puts back what was
there.

Files are stamped `"app": "gridi"`. Anything that is not a patch is declined,
not opened. Files saved before the stamp are recognised by their shape and
still open.

Device bindings are not in the file. A patch names output slots A–D; each
machine binds its own devices.

## MIDI

Every control below is on the **MIDI in & out** tab, the second of the two in
the header.

| Control | Does |
| --- | --- |
| Enable MIDI | Requests access. Needs a user gesture and a secure context. |
| A B C D | Picks which output slot the device list and Clk apply to |
| Device list | Binds a device to that slot |
| Clk A–D | Whether that output receives clock |
| Clock | Whether clock is sent at all |
| Panic | All notes off on every output |
| MIDI in device | The port clock and played notes arrive on |
| Sync | Follow the incoming clock instead of the project tempo |

Outputs are named slots. A patch stores the slot letter; each machine binds its
own devices, remembered between sessions.

Sent: note on, note off, control change, program change, clock at 24 PPQN,
start, stop, continue, song position.

Received: clock, start, stop, continue, song position, note on.

On a single channel, note length is capped by the retrigger rate — two instances
of one pitch on one channel cannot overlap. Use different pitches or channels.

## controls

| Action | Control |
| --- | --- |
| Play / stop | Space, or Play |
| Place a node | Click a type in the left rail, then click the grid. Shift keeps placing. |
| Show the node names | The chevron beside **nodes**. The rail keeps to its colours until then, and remembers which way it was left. |
| Fold the inspector away | The chevron in its head |
| Project settings, the library, MIDI ports | The three tabs in the header |
| Patch two nodes | Drag from a node's right edge onto another node |
| Select | Click a node or a line |
| Move a node | Drag it |
| Pan | Drag empty grid, or alt-drag |
| Zoom | Wheel |
| Fit to patch | F |
| Set what a cell is worth | Grid, in the project tab |
| Open a patch | Drop the file on the canvas, or paste its text |
| Open a patch that ships with Gridi | The library tab |
| Choose what each channel plays | Sounds, on the library tab |
| Play through a SoundFont | Drop a .sf2 on the canvas |
| Delete selection | Del or Backspace |
| Duplicate node | D |
| Mute selected line | M, or double-click the line |
| Undo / redo | ⌘Z / ⇧⌘Z |
| Save patch | ⌘S, or Save |
| Cancel | Escape |

New, Demo, Save, Open and Sounds sit with the patch name on the library tab.
The theme toggle is at the far end of the tab strip, being about neither the
patch nor the machine. The transport — play and the bar count — is the rule
between the settings and the grid, and holds nothing else. Patches autosave to
local storage.

Embedded in someone else's page, every key and the wheel above waits until the
app has been clicked into, and stops again when it is clicked out of.

## limits

Past these, Gridi drops what it cannot carry and says so in a banner.

| Limit | Ceiling |
| --- | --- |
| Scheduler events | 2000 per tick, 8000 per second sustained |
| MIDI messages | 2000 per second, per device |
| Sounding voices | 64 across the patch |
| Patch size | 400 nodes, 800 lines |

Repeated overloads stop the transport. Note-offs and clock are never dropped.

## task recipes

### drive a DAW

1. Open a virtual MIDI port: IAC Driver on macOS, loopMIDI on Windows.
2. Press **Enable MIDI**, pick slot **A**, choose that port.
3. Set the DAW to receive on it, and to external sync if it should follow the
   tempo.
4. Select the line feeding your Note nodes, set channels to **Set here**, pick
   the channels.

### drive two instruments from one pulse

1. Bind slot **A** and slot **B** to different devices.
2. Select the line, **Set here**, pick output **A** and its channels.
3. Switch the output selector to **B** and pick its channels.
4. Give the B channels a transpose if the second instrument sits in another
   register.

### send a filter sweep

1. Place an **LFO** and a **Param** node, and patch LFO into Param.
2. On the Param node, set Scope to **CC** and Controller to the number the
   instrument listens on — 74 is filter cutoff by convention.
3. Select the line between them, **Set here**, pick the output and channel.
4. On the LFO, set Cycle to the sweep length and From/To to the range.
5. Patch a Pulse into the LFO to restart the sweep in time.

### put two parts in step

1. Patch a **Split** into two Note nodes.
2. Put both Note nodes in the same row as each other. Equal lengths, so their
   pulses arrive together.
3. Drag one of them a row down and play it again: the line got longer, so that
   part is now late. Select the line to see by how much.
4. Use the **Grid** setting to scale the whole patch at once — 1/16 halves every
   travel time, 1/4 doubles it.

### share a patch

1. Give it a name on the library tab.
2. **Save**. The file lands in your downloads, named after the patch.
3. Send the file, or its text.
4. They drop it on their canvas, or paste it there.

### follow another sequencer

1. Choose the master's port under **MIDI in**.
2. Press **Sync**. The tempo readout follows the master and the project BPM is
   left alone.
3. Press play on the master.

### play the patch from a keyboard

1. Choose the keyboard's port under **MIDI in**.
2. Place a **MIDI In** node and patch it into a Note node.
3. Set Played note to **Key** to retune the patch from the pitch played,
   **Transpose** to shift it, **Gate** to ignore the pitch.
4. Start the transport; played notes need it running.

## tech

Vanilla ES modules. No build, no dependencies. Web Audio for the built-in
voices and the SoundFont player, Web MIDI for output and input. The SoundFont
parser is `src/sf2.js` and touches no browser API, so it is read and checked
outside one.

`npm test` runs 336 tests under `node --test`. `engine`, `model`, `music`,
`rhythm`, `voice`, `sync`, `lfo`, `limits` and `geometry` have no DOM, audio or
MIDI dependencies and are tested directly; the engine runs against a fake clock
and stub outputs. The synth is checked in a browser at
`tests/audio-check.html`.

Web MIDI: Chrome, Edge, Opera, Firefox 108+. Not Safari and not any iOS
browser, which all run WebKit — those get the built-in voices only.
