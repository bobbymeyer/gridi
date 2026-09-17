# Gridi — Grid Pulse Sequencer

Route-based MIDI generation. You place nodes on a grid, patch them together with
lines, and a pulse emitter sends clock pulses down the wires. Pulses trigger
whatever they arrive at: a MIDI note, a synth voice, a parameter change, or more
routing logic.

It is built for people who already patch — tracing signal flow through a tangle
of cables is the texture of the instrument, not a problem to design away.

- **Web Audio** for in-browser synthesis.
- **Web MIDI** for output to a DAW or hardware.

These are separate APIs doing separate jobs. Web Audio does not send MIDI and
Web MIDI does not make sound; Gridi uses both, sharing one clock.

## Running it

No build step and no dependencies. Serve the directory and open it:

```sh
npm start          # python3 -m http.server 8080
open http://localhost:8080
```

Any static server works. Web MIDI needs a **secure context**, so use
`localhost` or https — `file://` will not do, and ES modules will not load from
it either.

```sh
npm test           # 81 unit tests, no dependencies
```

The synth is also checked by ear, or rather by measurement. Open
`/tests/audio-check.html` in a browser: it renders the Voice node's real audio
graph through an `OfflineAudioContext` and measures what comes out — oscillator
tuning, each waveform's harmonics against theory, the envelope's shape, filter
response, velocity scaling and headroom. 16 checks, no dependencies, since
Web Audio needs a browser and the node suite deliberately does not.

## The first five minutes

The app opens on a demo patch. Press **space** or **Play**. You will hear it
through the built-in voices straight away; MIDI is optional.

| Do this | To |
|---|---|
| Click a node type on the left, then click the grid | Place a node (hold shift to place several) |
| Drag from a node's **right edge** onto another node | Patch them together |
| Click a node or a line | Edit it in the inspector |
| Drag empty grid · wheel · **F** | Pan · zoom · fit |
| **Space** · **Del** · **D** · **M** · **⌘Z** | Play · delete · duplicate · mute line · undo |

To reach a DAW, send to a virtual MIDI port — IAC Driver on macOS, loopMIDI on
Windows — and have the DAW listen on it. There is no direct app-to-app route.

## Node types

| Node | What it does |
|---|---|
| **Pulse** | Root clock. Emits on a beat at project BPM, and owns the feel: division, swing, polyrhythm ratio, humanise and Euclidean gating. Feel lives here, never in the grid geometry. |
| **Split** | Sends one pulse down every outgoing line at once. Optional stagger for flams. |
| **Logic** | Coincidence gate. Fires when pulses line up inside a window: AND, OR, XOR or N-of. |
| **Chance** | Lets a pulse through a set percentage of the time. Drift mode nudges the odds after each result. |
| **Router** | Sends each pulse down exactly one line — cycling, ping-pong, random, or random with no repeats. Melodic variation, as against Split's "all at once". |
| **Note** | Fires a **scale degree** as MIDI on every channel the line carries. Ratchets subdivide one trigger. |
| **Voice** | A subtractive Web Audio synth: two independent oscillators, a resonant low-pass with its own contour, and an ADSR. |
| **Param** | Rewrites a parameter instead of firing a note, then passes the pulse on. Can target another node, or the pulse itself. |
| **Key** | Rewrites scale and key for everything downstream, live. Latch mode writes the project key so the whole patch modulates. |

## The Voice node

Two oscillators, each with its own **waveform** (sine, triangle, square, sawtooth),
**octave**, **semitone** offset, fine **detune** in cents, and **level**. They mix
rather than sum, so adding the second one never pushes the output past the first.
Set one to zero level and it is not built at all.

Both run into a resonant low-pass whose **env depth** sweeps the cutoff up by a
number of octaves and back, then into an ADSR amplifier.

The **attack is linear and everything after it is exponential**. This is not
cosmetic: an exponential rise out of silence is heavily back-loaded — a 200ms
attack sits at a third of its level with 10% of its time left, which reads as a
late swell rather than an attack. Falls are the opposite; the ear expects
exponential, and linear decays sound artificial.

The gate closes after **gate** beats whatever stage the envelope has reached, so
a note cut short during its attack or decay releases from the level it actually
got to rather than jumping to the sustain level first.

Voice nodes make sound in the browser and send no MIDI; the channels a line
carries mean nothing to them. Note nodes are the MIDI side.

## Lines are objects, not drawings

A line is not a rendered edge with an arrow on it. It carries state, and that
state is what the pulse picks up as it passes:

| Property | Behaviour |
|---|---|
| **MIDI channels** | A line carries a *set* of channels, each with its own transpose and velocity. One pulse down that line fans out across all of them at once — splitter behaviour baked into the line. |
| **Scale and key** | Set on the line and cascading to everything it feeds, rather than configured per node. |
| **Delay** | In beats. The only thing that shifts timing. |
| **Mute** | Stops passing pulses without unpatching. |

Both channels and scale default to **inherit**: a line passes on whatever
arrived. Setting either one overrides it from that point downstream.

## Open questions, and how they were settled

The brief left four decisions open. Each is resolved here with a default that
can be changed, and the reasoning is recorded so it can be revisited.

**Is a line's assignment fixed at draw time, or mutable at runtime?**
Mutable, and the mechanism is the same one either way. A pulse carries a context
— channels, scale, key, velocity, transpose. Each line it crosses merges its own
assignments into that context, and a Key or Param node can rewrite it mid-flight.
Draw-time assignment is just the common case of a context nothing has changed.

**How do degrees past the end of the scale resolve?**
Configurable per Note node, defaulting to **Extend**: a 9th in a 7-note scale is
the 2nd, an octave up. `Fold` wraps within one octave, `Clamp` stops at the top
of the scale. Pentatonic scales wrap on five, so the same degree number means
different things in different scales — which is the point of writing in degrees.

**Multiple emitters at different rates?**
Supported. Every emitter has a division plus a polyrhythm ratio (3 steps in the
space of 2, say) against one project BPM. Independent free-running BPMs were
rejected: they drift apart with nothing to pull them back, and a shared tempo
with per-emitter ratios covers the musical cases while staying re-anchorable when
the tempo changes mid-performance.

**What data structure carries multiple channels on a line?**
The richer one: `{ ch, transpose, velocity }` per channel, not a list of ints.
It costs nothing and it means a single line can feed a bass part and a doubling
pad with different weight, which the flat form cannot express at all.

## How it is put together

```
src/
  music.js      scales, keys, scale-degree resolution
  voice.js      synth maths: oscillator tuning, ADSR and filter breakpoints
  rhythm.js     divisions, swing, Bjorklund Euclidean patterns
  model.js      the patch document: nodes, lines, serialisation, repair
  nodes.js      node type registry — declarative, the inspector builds itself from it
  engine.js     look-ahead scheduler and pulse propagation
  audio.js      Web Audio voices and the clock
  midi.js       Web MIDI output
  geometry.js   grid maths, orthogonal routing, hit testing
  render.js     canvas renderer
  ui.js         palette and inspector
  main.js       input, transport, persistence, frame loop
```

**Timing.** Nothing plays "now". A scheduler tick looks ~140ms ahead, works out
which emitters fire in that window, walks the graph from each, and hands absolute
AudioContext times to the audio and MIDI back ends. Main-thread stalls do not
make it swing. Tempo changes re-anchor at the current beat rather than rewinding.

The visual pulse is decoupled from all of that: the dot is launched *backwards*
from its arrival time, so it lands exactly when the note sounds. On a line with a
delay, you watch it crawl for the whole delay.

**Coincidence.** Logic gates collect arrivals into a window, evaluate when the
window closes, and fire at the window's *first* arrival — so a gate does not drag
behind the beat. Since everything is scheduled ahead of the audio clock, firing
at a time that has already passed in queue order is still in the future.

**Feedback loops** are allowed, and terminate on a hop limit.

**Randomness** is seeded per patch, so a chance-heavy patch replays identically.

`engine.js`, `model.js`, `music.js`, `rhythm.js`, `voice.js` and `geometry.js`
have no DOM, audio or MIDI dependencies, which is what makes the test suite
possible: the engine runs against a fake clock and stub outputs, and asserts on
the notes it would have sent. The envelope maths sits in `voice.js` rather than
inside the audio graph for the same reason — ADSR bugs live in the awkward cases
(a note released mid-attack, zero sustain, a decay longer than the note itself),
and those are painful to find by ear.

`buildVoice` in `audio.js` takes its context and destination as arguments, so the
exact graph that plays live is the one the browser check renders offline.

## Browser support

| | Web Audio | Web MIDI |
|---|---|---|
| Chrome, Edge, Opera | yes | yes |
| Firefox 108+ | yes | yes |
| Safari, and every iOS browser | yes | **no** |

Every iOS browser runs WebKit, so none of them has Web MIDI. Gridi is
Chromium-first; without MIDI it still plays through the built-in voices, and says
so rather than failing silently.

## Aesthetics

Swiss International Typographic Style: Helvetica, flush left, uppercase
micro-labels on a wide track, heavy rules, four flat colours, no gradients and no
rounded corners. The modular grid is drawn rather than implied, and the patch
cables obey it — lines turn right angles along the grid instead of curving.
Dark mode included, because nobody performs under a white screen.

## Not yet built

- Node groups and sub-patches.
- MIDI clock in/out and external sync.
- CC output from Param nodes (they modulate in-app parameters only).
- An LFO. Modulation is step-wise today: a Param node changes a value when a
  pulse arrives, so filter sweeps and vibrato come out as staircases.
- Filter types beyond low-pass.
- Recording or exporting the output.
