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

```sh
npm test
```

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

## patches

A patch is one JSON file: nodes, lines, tempo, grid, key. Name it in the left
rail; **Save** names the file after it.

| To open one | How |
| --- | --- |
| A file | Drop it anywhere on the canvas, or press **Open** |
| Its text | Paste it onto the canvas |

Opening replaces the canvas and goes on the undo stack. ⌘Z puts back what was
there.

Files are stamped `"app": "gridi"`. Anything that is not a patch is declined,
not opened. Files saved before the stamp are recognised by their shape and
still open.

Device bindings are not in the file. A patch names output slots A–D; each
machine binds its own devices.

## MIDI

| Control | Where | Does |
| --- | --- | --- |
| Enable MIDI | header | Requests access. Needs a user gesture and a secure context. |
| A B C D | header | Picks which output slot the device list and Clk apply to |
| Device list | header | Binds a device to that slot |
| Clk A–D | header | Whether that output receives clock |
| Clock | header | Whether clock is sent at all |
| Panic | header | All notes off on every output |
| MIDI in device | header | The port clock and played notes arrive on |
| Sync | header | Follow the incoming clock instead of the project tempo |

Outputs are named slots. A patch stores the slot letter; each machine binds its
own devices, remembered between sessions.

Sent: note on, note off, control change, clock at 24 PPQN, start, stop,
continue, song position.

Received: clock, start, stop, continue, song position, note on.

On a single channel, note length is capped by the retrigger rate — two instances
of one pitch on one channel cannot overlap. Use different pitches or channels.

## controls

| Action | Control |
| --- | --- |
| Play / stop | Space, or Play |
| Place a node | Click a type in the left rail, then click the grid. Shift keeps placing. |
| Patch two nodes | Drag from a node's right edge onto another node |
| Select | Click a node or a line |
| Move a node | Drag it |
| Pan | Drag empty grid, or alt-drag |
| Zoom | Wheel |
| Fit to patch | F |
| Set what a cell is worth | Grid, in the header |
| Open a patch | Drop the file on the canvas, or paste its text |
| Delete selection | Del or Backspace |
| Duplicate node | D |
| Mute selected line | M, or double-click the line |
| Undo / redo | ⌘Z / ⇧⌘Z |
| Save patch | ⌘S, or Save |
| Cancel | Escape |

New, Demo, Save, Open and the theme toggle are in the left rail. Patches
autosave to local storage.

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

1. Give it a name in the left rail.
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
voices, Web MIDI for output and input.

`npm test` runs 241 tests under `node --test`. `engine`, `model`, `music`,
`rhythm`, `voice`, `sync`, `lfo`, `limits` and `geometry` have no DOM, audio or
MIDI dependencies and are tested directly; the engine runs against a fake clock
and stub outputs. The synth is checked in a browser at
`tests/audio-check.html`.

Web MIDI: Chrome, Edge, Opera, Firefox 108+. Not Safari and not any iOS
browser, which all run WebKit — those get the built-in voices only.
