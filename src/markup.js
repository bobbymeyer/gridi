/**
 * The app's own DOM.
 *
 * It used to live in index.html, which was fine while there was one way to run
 * gridi. There are two now — its own page, and embedded in a note on
 * bobbymeyer.com — and markup kept in a static file cannot be handed to a
 * container that is not that file. Two copies would drift the first time a
 * control moved, so there is one, here, and index.html is the shell that asks
 * for it.
 *
 * Ids are kept exactly as they were. Every lookup in main.js is scoped to the
 * mount rather than to the document, so an embedded copy cannot collect the
 * host page's elements, nor it theirs.
 */

/**
 * The lockup: the name and the strapline, and nothing that does anything.
 *
 * All the embed drops, because the page it is sitting in has said what it is
 * showing already. Everything else in the header stays.
 */
const MARK = `    <div class="head__mark">
      <b>gridi</b>
      <span>grid pulse sequencer</span>
    </div>

`;

/**
 * The header is three tabs over one row of controls.
 *
 * Tempo, grid and key belong to the patch. The ports belong to the machine the
 * patch is being played on, and change when the room changes rather than when
 * the piece does. Laid out across one long header the two kinds of setting
 * looked like one kind; a tab each says which is which, and hands the canvas
 * back the height the second row was taking. The library is the third: a shelf
 * of patches is a thing to look along, which a panel over the canvas was the
 * wrong shape for.
 *
 * The transport left the header with them. Play and the bar count belong
 * against the thing they are running — the grid — rather than up in the
 * settings, so they sit on their own rule directly above it, with the patch
 * and what can be done to it at the other end of the same line.
 */
const BODY = `

  <header class="head">
    <div class="tabs" role="tablist" aria-label="Settings">
      <button class="tab" type="button" id="tab-project" role="tab" aria-selected="true" aria-controls="panel-project">project</button>
      <button class="tab" type="button" id="tab-library" role="tab" aria-selected="false" aria-controls="panel-library" tabindex="-1">library</button>
      <button class="tab" type="button" id="tab-midi" role="tab" aria-selected="false" aria-controls="panel-midi" tabindex="-1">MIDI in &amp; out</button>
    </div>

    <div class="panels">
      <div class="panel" id="panel-project" role="tabpanel" aria-labelledby="tab-project">
        <div class="mod">
          <span class="micro">tempo</span>
          <div class="mod__row">
            <input class="bpm-input" id="bpm" type="number" min="20" max="300" step="1" value="104" aria-label="Beats per minute">
            <span class="micro">bpm</span>
          </div>
        </div>

        <div class="mod">
          <span class="micro">grid</span>
          <div class="mod__row">
            <select class="field" id="grid" aria-label="Note value of one grid cell" title="What one grid cell is worth: how long a pulse takes to cross it"></select>
            <span class="micro">per cell</span>
          </div>
        </div>

        <div class="mod">
          <span class="micro">project key</span>
          <div class="mod__row">
            <select class="field" id="root" aria-label="Key"></select>
            <select class="field" id="scale" aria-label="Scale"></select>
          </div>
        </div>
      </div>

      <div class="panel panel--library" id="panel-library" role="tabpanel" aria-labelledby="tab-library" hidden></div>

      <div class="panel" id="panel-midi" role="tabpanel" aria-labelledby="tab-midi" hidden>
        <div class="mod mod--grow">
          <span class="micro">MIDI outputs</span>
          <div class="mod__row">
            <button class="btn" id="midi-enable">enable MIDI</button>
            <div class="seg" id="slot-picker" role="group" aria-label="Output slot"></div>
            <select class="field" id="midi-out" aria-label="Device for the selected output" style="max-width:130px" disabled></select>
            <button class="btn" id="slot-clock" aria-pressed="true" title="Send clock to this output">clk A</button>
            <button class="btn" id="clock-out" aria-pressed="true" title="Send MIDI clock, start and stop at all, so receiving gear follows Gridi's tempo">clock</button>
            <button class="btn btn--red" id="panic" title="All notes off">panic</button>
          </div>
        </div>

        <div class="mod">
          <span class="micro">MIDI in</span>
          <div class="mod__row">
            <select class="field" id="midi-in" aria-label="MIDI input device" style="max-width:120px" disabled></select>
            <button class="btn" id="sync-ext" aria-pressed="false" title="Follow the incoming MIDI clock instead of the project tempo">sync</button>
          </div>
        </div>
      </div>
    </div>
  </header>

  <div class="guard" id="guard" hidden role="status">
    <div class="guard__mark">limit</div>
    <div class="guard__body">
      <b id="guard-title"></b>
      <p id="guard-detail"></p>
      <p class="guard__scope" id="guard-scope"></p>
    </div>
    <button class="guard__close" id="guard-close" aria-label="Dismiss">&times;</button>
  </div>

  <div class="transport">
    <button class="btn-play" id="play" aria-pressed="false">play</button>

    <div class="mod">
      <span class="micro">position</span>
      <div class="readout"><span id="position">001.1</span></div>
    </div>

    <div class="patch">
      <span class="micro">patch</span>
      <input class="field patch__name" id="patch-name" type="text" maxlength="60" placeholder="Untitled" aria-label="Patch name, used for the saved file">
      <div class="patch__buttons">
        <button class="btn" id="new">new</button>
        <button class="btn" id="sounds">sounds</button>
        <button class="btn" id="demo">demo</button>
        <button class="btn" id="export">save</button>
        <button class="btn" id="import">open</button>
        <button class="btn" id="theme" title="Toggle theme">dark</button>
      </div>
    </div>
  </div>

  <div class="body">
    <nav class="rail" aria-label="Node palette">
      <div class="rail__head">
        <button class="disclose" type="button" id="rail-toggle" aria-expanded="false" aria-controls="palette" title="Show the node names">
          <span class="chev" aria-hidden="true"></span>
          <span class="visually-hidden">Node names</span>
        </button>
        <b class="rail__label">nodes</b>
      </div>
      <div id="palette"></div>
      <p class="rail__note">
        Drag from a node's right edge onto another node to patch them.
        Lines carry the channels and the key.
      </p>
    </nav>

    <section class="stage">
      <canvas id="canvas" tabindex="0" aria-label="Patch grid"></canvas>
      <div class="stage__placing" id="placing" hidden></div>
      <div class="sheet" id="sheet" hidden role="dialog" aria-modal="true" aria-labelledby="sheet-title">
        <div class="sheet__head">
          <b id="sheet-title">sounds</b>
          <button class="sheet__close" id="sheet-close" aria-label="Close">&times;</button>
        </div>
        <div class="sheet__body" id="sheet-list"></div>
      </div>

      <div class="stage__drop" id="drop" hidden>
        <b>drop to open</b>
        <span>a patch saved from Gridi, or a .sf2 SoundFont</span>
      </div>
      <div class="stage__hint">
        <span><b>space</b> play</span>
        <span><b>right edge</b> patch</span>
        <span><b>drag empty</b> pan</span>
        <span><b>wheel</b> zoom</span>
        <span><b>del</b> remove</span>
        <span><b>F</b> fit</span>
        <span><b>drop a file</b> open</span>
      </div>
    </section>

    <aside class="pane" aria-label="Inspector">
      <div class="pane__head">
        <button class="disclose disclose--pane" type="button" id="pane-toggle" aria-expanded="true" aria-controls="inspector" title="Minimise the inspector">
          <span class="chev" aria-hidden="true"></span>
          <span class="visually-hidden">Inspector</span>
        </button>
        <b class="pane__label">inspector</b>
        <span id="sel-kind">nothing</span>
      </div>
      <div class="pane__body" id="inspector"></div>
      <div class="pane__actions">
        <button class="btn" id="duplicate">duplicate</button>
        <button class="btn btn--red" id="delete">delete</button>
      </div>
    </aside>
  </div>

  <footer class="foot">
    <span class="foot__dot" id="run-dot" data-on="false"></span>
    <span id="status"><b>Ready.</b> Press play.</span>
    <span class="foot__sep"></span>
    <span class="foot__log" id="log">—</span>
    <span class="foot__sep"></span>
    <label class="foot__level">
      <span>level</span>
      <input type="range" id="volume" min="0" max="1" step="0.01" value="0.8" aria-label="Output level">
    </label>
    <span class="foot__sep"></span>
    <span id="counts">0 nodes · 0 lines</span>
  </footer>

`;

const FILE_INPUT = `<input type="file" id="file" accept="application/json,.json" hidden>`;

/**
 * The markup for one instance.
 *
 * `mark` is the lockup above. A page that has already said what it is showing
 * does not need gridi to say it again directly underneath, so the embed asks
 * for it without.
 *
 * The file input comes along rather than sitting outside the app, so that
 * tearing the mount down takes it with it.
 */
export function appMarkup({ mark = true } = {}) {
  const head = mark ? MARK : '';
  return BODY.replace('<header class="head">\n', `<header class="head">\n${head}`) + FILE_INPUT;
}
