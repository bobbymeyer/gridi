# roadmap

## decisions

| Decision | Alternative rejected | Reason |
| --- | --- | --- |
| A pulse carries a context that each line merges into | Line assignments fixed at draw time | Live key change needs the same mechanism; draw-time assignment is the case where nothing has changed it |
| Degrees past the end of a scale extend into the next octave | Fold, clamp | A 9th reading as the 2nd an octave up is what a musician expects. Both others are available per Note node |
| One project BPM, per-emitter polyrhythm ratios | Independent free-running BPMs per emitter | They drift apart with nothing to pull them back, and cannot be re-anchored together when the tempo changes mid-performance |
| Channels carry `{out, ch, transpose, velocity}` | A list of channel integers | One line can then feed a bass part and a doubling pad with different weight, which the flat form cannot express |
| Outputs are named slots A–D, bound per machine | Device ids stored in the patch | Web MIDI ids differ between machines, so a patch would arrive elsewhere pointing at nothing |
| Waves travel the lines; an LFO names no destination | Output, channel and CC number on the LFO node | Routing belongs to the line whatever moves along it; the LFO would have been the one node ignoring that |
| Note-offs are queued until nearly due | Both note-offs sent when the notes are scheduled | A note-off is a channel and a pitch, so a retriggered pitch needs its predecessor released first |
| A pulse takes musical time to walk a line, a cell at a time | Geometry as pure layout, timing from the emitter and a line delay only | Reversed. Layout that costs nothing is a diagram; layout that costs time is a score, and the patch becomes something you compose by moving. The line delay stays as a trim |
| A cell is a note value the patch sets, default 1/8 | A fixed value, or seconds per cell | The whole point is that the distance is musical, and one setting rescales an entire patch. Bar and beat rules follow it, so the field reads as time |
| A latched key is read when a note sounds | Read when its pulse left the emitter, as it was | Travel time can be bars. Read at the emitter, a chord change reached a note only after the note had already sounded in the old key, so the harmony drifted off the bar |
| Library patches are ordinary patch files in `patches/`, built by scripts in `tools/` | Patches written into the source, as the demo is | A library entry has to be openable, shareable and editable like anything else the app saves. The scripts stay because an offset is a distance now, and five of those is arithmetic |
| A patch is one JSON file, dropped or pasted onto the canvas to open | A patch browser, or a server to host them | The file is the unit people already know how to send each other. A library is something to build once there is a reason to have more than one open at a time |
| Audio time for scheduling, one held offset to MIDI time | Converting per message | The two clocks tick differently; converting per message read as an unsteady tempo |
| Vanilla ES modules, no build | A bundler and a framework | Nothing here needs one, and a static file server is the whole deployment |
| Voice count capped with oldest-first stealing | Unbounded polyphony | A long release against a fast clock reached 339 voices, past what the audio thread renders in real time |
| Repeated overloads counted over thirty seconds | Six, as it was before travel time | A loop laid out on the grid pays a delay per hop, so after the queue is dumped it needs seconds to build back up. In a six-second window the same broken patch blew up all evening without ever counting as repeated trouble |

## non-goals

| Not doing | Instead |
| --- | --- |
| Being an audio engine | The built-in voices are for sketching a patch. Heavy synthesis belongs in a DAW or hardware instrument over MIDI |
| Safari and iOS support for MIDI | No WebKit browser implements Web MIDI. Those browsers get the built-in voices and are told so |
| Sample-accurate MIDI | Web MIDI schedules in `performance.now()`; the offset to audio time is held steady rather than assumed exact |
