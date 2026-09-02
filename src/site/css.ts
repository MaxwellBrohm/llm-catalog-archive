/**
 * The whole stylesheet, as one string, written once to style.css at the site root.
 *
 * MaxOS design language: near-black grounds, orange as the only live colour,
 * warm white text, everything on an 8px grid, one radius scale. Roughly 90%
 * blacks and 9% orange, which is why removals are rendered in the muted ramp
 * rather than in red: a second hue would break the palette. The +/- gutter
 * glyph carries the distinction on its own, so the diff stays readable without
 * colour at all.
 *
 * No client JavaScript anywhere. The only interactive element is <details>,
 * which the browser implements.
 */
/**
 * SELF-HOSTED, NOT @import'ed FROM GOOGLE. The stylesheet used to open with an
 * @import of fonts.googleapis.com, which made every page load a third-party
 * request, handed every reader's IP to Google with no disclosure, and put a
 * dependency this project does not control in front of a site whose whole claim
 * is that what it serves is what it stored. three.js was vendored for exactly
 * that reason and the typefaces were not.
 *
 * These are variable fonts, so one file per family covers the whole weight
 * range and `font-weight` is declared as a range rather than a value.
 * `font-display: swap` keeps text readable while they load, and `unicode-range`
 * lets a browser skip the latin-ext file for pages that never need it.
 */
export const STYLESHEET = `@font-face {
  font-family: 'Space Grotesk';
  font-style: normal;
  font-weight: 300 700;
  font-display: swap;
  src: url('fonts/space-grotesk-latin-ext-wght-normal.woff2') format('woff2-variations');
  unicode-range: U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF;
}
@font-face {
  font-family: 'Space Grotesk';
  font-style: normal;
  font-weight: 300 700;
  font-display: swap;
  src: url('fonts/space-grotesk-latin-wght-normal.woff2') format('woff2-variations');
  unicode-range: U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD;
}
@font-face {
  font-family: 'Inter';
  font-style: normal;
  font-weight: 100 900;
  font-display: swap;
  src: url('fonts/inter-latin-ext-wght-normal.woff2') format('woff2-variations');
  unicode-range: U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF;
}
@font-face {
  font-family: 'Inter';
  font-style: normal;
  font-weight: 100 900;
  font-display: swap;
  src: url('fonts/inter-latin-wght-normal.woff2') format('woff2-variations');
  unicode-range: U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD;
}
@font-face {
  font-family: 'JetBrains Mono';
  font-style: normal;
  font-weight: 100 800;
  font-display: swap;
  src: url('fonts/jetbrains-mono-latin-ext-wght-normal.woff2') format('woff2-variations');
  unicode-range: U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF;
}
@font-face {
  font-family: 'JetBrains Mono';
  font-style: normal;
  font-weight: 100 800;
  font-display: swap;
  src: url('fonts/jetbrains-mono-latin-wght-normal.woff2') format('woff2-variations');
  unicode-range: U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD;
}

:root {
  --void: #050505;
  --panel-0: #0b0b0d;
  --panel-1: #121215;
  --panel-2: #1a1a1e;
  --line: #232329;
  --text: #f6f1ea;
  --text-dim: #9a958f;
  --text-faint: #6b6862;
  --orange: #ff6a00;
  --orange-hot: #ff8c2e;
  --orange-wash: rgba(255, 106, 0, 0.08);
  --radius-sm: 4px;
  --radius: 8px;
  --display: 'Space Grotesk', 'Helvetica Neue', Helvetica, Arial, sans-serif;
  --ui: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
  --mono: 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}

* { box-sizing: border-box; }

html { -webkit-text-size-adjust: 100%; }

body {
  margin: 0;
  background: var(--void);
  color: var(--text);
  font-family: var(--ui);
  font-size: 15px;
  line-height: 1.6;
}

a { color: var(--orange-hot); text-decoration: none; }
a:hover { text-decoration: underline; }
a:focus-visible { outline: 2px solid var(--orange); outline-offset: 2px; border-radius: var(--radius-sm); }

.wrap { max-width: 1080px; margin: 0 auto; padding: 0 24px; }

.site-head {
  border-bottom: 1px solid var(--line);
  background: var(--panel-0);
}
.site-head .wrap {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 24px;
  padding-top: 16px;
  padding-bottom: 16px;
}
.brand {
  font-family: var(--display);
  font-weight: 700;
  font-size: 16px;
  letter-spacing: 0.01em;
  color: var(--text);
}
.brand:hover { color: var(--orange-hot); text-decoration: none; }
.site-head .wrap { padding-bottom: 0; }
.site-head nav { display: flex; flex-wrap: wrap; gap: 24px; font-size: 13px; margin-right: auto; }
.site-head nav a {
  color: var(--text-dim);
  padding: 8px 0 16px;
  border-bottom: 2px solid transparent;
}
.site-head nav a:hover { color: var(--orange-hot); text-decoration: none; }
/*
 * The current section is marked with the one live colour rather than with a
 * background, because a filled tab reads as a control and the nav is a table of
 * contents. aria-current carries the same fact for a reader who cannot see it.
 */
.site-head nav a.on { color: var(--text); border-bottom-color: var(--orange); }
.site-head .util { display: flex; gap: 16px; font-size: 12px; padding-bottom: 16px; }
.site-head .util a { color: var(--text-faint); }
.site-head .util a:hover { color: var(--orange-hot); }

/* Visible only once it has focus, which is the whole job. */
.skip {
  position: absolute;
  left: -9999px;
  top: 0;
  background: var(--orange);
  color: var(--void);
  padding: 8px 16px;
  border-radius: 0 0 var(--radius) 0;
  font-size: 13px;
  z-index: 10;
}
.skip:focus { left: 0; }

main { padding: 40px 0 80px; }

.eyebrow {
  font-family: var(--mono);
  font-size: 11px;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--orange);
  margin: 0 0 8px;
}

h1 {
  font-family: var(--display);
  font-weight: 700;
  font-size: 32px;
  line-height: 1.2;
  margin: 0 0 8px;
  overflow-wrap: anywhere;
}
h1.sha-title { font-family: var(--mono); font-size: 28px; letter-spacing: -0.01em; }

h2 {
  font-family: var(--display);
  font-weight: 500;
  font-size: 18px;
  margin: 0 0 16px;
}
h2.path { font-family: var(--mono); font-size: 16px; overflow-wrap: anywhere; }

.lede { color: var(--text-dim); font-size: 14px; margin: 0 0 32px; }

.sha-full {
  font-family: var(--mono);
  font-size: 12px;
  color: var(--text-faint);
  overflow-wrap: anywhere;
  margin: 0 0 24px;
}

.subject {
  font-family: var(--mono);
  font-size: 13px;
  color: var(--text-dim);
  background: var(--panel-0);
  border: 1px solid var(--line);
  border-left: 2px solid var(--orange);
  border-radius: var(--radius-sm);
  padding: 8px 16px;
  margin: 0 0 32px;
  overflow-wrap: anywhere;
}

.panel {
  background: var(--panel-0);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  padding: 24px;
  margin: 0 0 24px;
}

.facts { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 16px; margin: 0 0 24px; }
.fact { background: var(--panel-1); border-radius: var(--radius-sm); padding: 16px; min-width: 0; }
.fact dt {
  font-size: 11px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--text-faint);
  margin: 0 0 8px;
}
.fact dd { margin: 0; font-family: var(--mono); font-size: 14px; overflow-wrap: anywhere; }
.fact dd.big { font-size: 20px; }
.fact dd .plus { color: var(--orange); }
.fact dd .minus { color: var(--text-dim); }

.badge {
  display: inline-block;
  font-family: var(--mono);
  font-size: 10px;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  border-radius: var(--radius-sm);
  padding: 0 8px;
  line-height: 20px;
  vertical-align: 2px;
}
.badge-origin { background: var(--orange-wash); color: var(--orange-hot); border: 1px solid rgba(255, 106, 0, 0.32); }
.badge-observed { background: var(--panel-2); color: var(--text-dim); border: 1px solid var(--line); }
.badge-added { background: var(--orange-wash); color: var(--orange-hot); border: 1px solid rgba(255, 106, 0, 0.32); }
.badge-modified { background: var(--panel-2); color: var(--text-dim); border: 1px solid var(--line); }
.badge-retracted { background: var(--orange); color: var(--void); border: 1px solid var(--orange); font-weight: 500; }

.retracted-note {
  background: var(--panel-1);
  border: 1px solid var(--orange);
  border-radius: var(--radius);
  padding: 16px 24px;
  margin: 0 0 24px;
}
.retracted-note p { margin: 0 0 8px; }
.retracted-note p:last-child { margin-bottom: 0; }
.retracted-note .reason { font-family: var(--mono); font-size: 13px; color: var(--text-dim); overflow-wrap: anywhere; }

.artifact { border-top: 1px solid var(--line); padding-top: 32px; margin-top: 32px; }
.artifact:first-of-type { border-top: 0; padding-top: 0; margin-top: 0; }

details.headers { margin: 0 0 24px; }
details.headers > summary {
  cursor: pointer;
  font-size: 13px;
  color: var(--text-dim);
  list-style: none;
  padding: 8px 0;
}
details.headers > summary::-webkit-details-marker { display: none; }
details.headers > summary::before { content: '+ '; color: var(--orange); font-family: var(--mono); }
details.headers[open] > summary::before { content: '- '; }
details.headers > summary:hover { color: var(--orange-hot); }

table.kv { width: 100%; border-collapse: collapse; font-family: var(--mono); font-size: 12px; }
table.kv th, table.kv td { text-align: left; padding: 8px 16px 8px 0; border-bottom: 1px solid var(--line); vertical-align: top; }
table.kv th { color: var(--text-faint); font-weight: 400; white-space: nowrap; }
table.kv td { color: var(--text); overflow-wrap: anywhere; }

.diff {
  background: var(--panel-0);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  overflow-x: auto;
  padding: 8px 0;
  margin: 0 0 16px;
}
.dl { display: flex; align-items: flex-start; font-family: var(--mono); font-size: 12px; line-height: 1.7; }
.dl .g {
  flex: 0 0 32px;
  text-align: center;
  user-select: none;
  color: var(--text-faint);
  border-right: 1px solid var(--line);
  position: sticky;
  left: 0;
  background: inherit;
}
.dl code { display: block; white-space: pre; padding: 0 16px; min-width: 0; }
.dl-context { background: var(--panel-0); color: var(--text-dim); box-shadow: inset 2px 0 0 transparent; }
.dl-add { background: var(--orange-wash); color: var(--text); box-shadow: inset 2px 0 0 var(--orange); }
.dl-add .g { color: var(--orange); border-right-color: rgba(255, 106, 0, 0.4); font-weight: 500; }
.dl-remove { background: var(--panel-2); color: var(--text-dim); box-shadow: inset 2px 0 0 #4a4a52; }
.dl-remove .g { color: var(--text); font-weight: 500; }
.dl-hunk { background: var(--panel-1); color: var(--text-faint); box-shadow: inset 2px 0 0 transparent; }
.dl-hunk .g { color: var(--text-faint); }
.cut { color: var(--orange); }

.note { font-size: 12px; color: var(--text-faint); margin: 0 0 24px; }

table.changes { width: 100%; border-collapse: collapse; font-size: 13px; }
table.changes th {
  text-align: left;
  font-size: 11px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--text-faint);
  font-weight: 500;
  padding: 0 16px 8px 0;
  border-bottom: 1px solid var(--line);
}
table.changes td { padding: 12px 16px 12px 0; border-bottom: 1px solid var(--line); vertical-align: top; }
table.changes td.mono, table.changes th.mono { font-family: var(--mono); font-size: 12px; overflow-wrap: anywhere; }
table.changes tr:hover td { background: var(--panel-0); }
.count-add { color: var(--orange); }
.count-remove { color: var(--text-dim); }

.day { margin: 40px 0 16px; }
.day:first-of-type { margin-top: 0; }
.day h2 { font-family: var(--mono); font-size: 13px; color: var(--text-faint); letter-spacing: 0.08em; margin: 0 0 8px; }

ol.events { list-style: none; margin: 0; padding: 0; }
li.event {
  background: var(--panel-0);
  border: 1px solid var(--line);
  border-left: 2px solid var(--orange);
  border-radius: var(--radius);
  padding: 16px 24px;
  margin: 0 0 16px;
}
li.event .claim {
  font-family: var(--display);
  font-weight: 500;
  font-size: 16px;
  line-height: 1.45;
  margin: 0 0 8px;
  overflow-wrap: anywhere;
}
li.event .event-meta {
  font-family: var(--mono);
  font-size: 12px;
  color: var(--text-faint);
  margin: 0;
  overflow-wrap: anywhere;
}
li.event table.kv { margin-top: 16px; }
.badge-type { background: var(--panel-2); color: var(--text-dim); border: 1px solid var(--line); }

/*
 * The leaks desk. The sourcing tier and the ledger outcome are the two labels a
 * reader has to be able to tell apart at a glance, so they are the only badges
 * that get their own colour: everything else on the desk is a neutral chip. The
 * tier is about the artifact rather than about confidence, so the artifact tier
 * is the one that gets the live colour and the two weaker tiers stay muted.
 */
.badge-tier { background: var(--panel-2); color: var(--text-dim); border: 1px solid var(--line); }
.badge-confirmed-artifact { border-color: var(--orange); color: var(--orange); }
.badge-outcome-confirmed { border: 1px solid var(--orange); color: var(--orange); background: transparent; }
.badge-outcome-refuted { border: 1px dashed var(--line); color: var(--text-faint); background: transparent; }
.badge-outcome-open { background: var(--panel-2); color: var(--text-dim); border: 1px solid var(--line); }

/*
 * A chip is a filter, and the publication has exactly two axes to filter on:
 * the micro-category an item was derived as, and the lab its catalogue id maps
 * to. Matte slab, faint orange edge on the live one, and a monospace label
 * because everything to the left of the number is a machine-readable key rather
 * than a word this project chose.
 */
.chips { display: flex; flex-wrap: wrap; gap: 8px; margin: 0 0 24px; }
.chip {
  display: inline-flex;
  align-items: baseline;
  gap: 8px;
  background: var(--panel-1);
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  padding: 8px 16px;
  font-family: var(--mono);
  font-size: 12px;
  color: var(--text);
  line-height: 1.2;
}
.chip:hover { border-color: var(--orange); color: var(--text); text-decoration: none; }
.chip .chip-kind { color: var(--text-dim); }
.chip code { font-family: inherit; font-size: inherit; }
h1.sha-title code, .sha-full code, table.changes td code { font-family: inherit; font-size: inherit; color: inherit; }
.chip:hover .chip-kind { color: var(--orange-hot); }
.chip-on {
  border-color: var(--orange);
  background: var(--orange-wash);
  box-shadow: inset 2px 0 0 var(--orange);
}
.chip-on .chip-kind { color: var(--orange-hot); }
/* An empty category keeps its page and its chip, and recedes rather than goes. */
.chip-empty { color: var(--text-faint); background: transparent; }
.chip-empty .chip-kind { color: var(--text-faint); }
.chip-held {
  color: var(--text-faint);
  background: transparent;
  border-style: dashed;
  font-size: 11px;
  padding: 4px 8px;
}
li.event .chips { margin: 8px 0 0; }

/* The live-thread rail. Quiet days are the reason it is unconditional. */
ul.rail { list-style: none; margin: 0 0 16px; padding: 0; }
ul.rail li {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 8px 16px;
  padding: 8px 0;
  border-bottom: 1px solid var(--line);
}
ul.rail li:last-child { border-bottom: 0; }
ul.rail a { font-family: var(--mono); font-size: 13px; overflow-wrap: anywhere; }
.rail-meta { font-family: var(--mono); font-size: 11px; color: var(--text-faint); }

/*
 * A refusal is not a claim, so it does not get the orange edge every claim card
 * carries. Dashed, muted, and unmistakably a statement about our own parser.
 */
li.event.refusal { border-left: 2px dashed var(--text-faint); }
li.event.refusal .claim { font-family: var(--ui); font-size: 14px; color: var(--text-dim); }
.badge-refusal { background: transparent; color: var(--text-faint); border: 1px dashed var(--text-faint); }

a.badge-type { color: var(--text-dim); }
a.badge-type:hover { border-color: var(--orange); color: var(--orange-hot); text-decoration: none; }

/*
 * The front page: a reading column and a rail, at 900px and up.
 *
 * The stream is FIRST in the DOM and the rail second, so a phone gets the news
 * before the navigation with no order override. an align-items of start keeps the
 * rail from stretching to the height of a 150-item stream.
 */
.split { display: grid; grid-template-columns: minmax(0, 1fr) 320px; gap: 40px; align-items: start; }
.split-main { min-width: 0; }
.split-side { min-width: 0; }
.split-side .panel { padding: 16px; }
.split-side .panel h2 { font-size: 15px; margin-bottom: 8px; }
.split-side .note { margin-bottom: 16px; }
.split-main .day:first-of-type { margin-top: 0; }

.filterbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 16px;
  padding: 16px 0 24px;
  border-top: 1px solid var(--line);
  border-bottom: 1px solid var(--line);
  margin: 0 0 32px;
}
.filterbar-label {
  font-family: var(--mono);
  font-size: 11px;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--orange);
}
.filterbar .chips { margin: 0; }

ul.rail-types { list-style: none; margin: 0; padding: 0; }
ul.rail-types li {
  display: flex;
  align-items: baseline;
  gap: 8px;
  font-family: var(--mono);
  font-size: 12px;
  padding: 4px 0;
  border-bottom: 1px solid var(--line);
}
ul.rail-types li:last-child { border-bottom: 0; }
ul.rail-types a { overflow-wrap: anywhere; }
ul.rail-types .rail-n { margin-left: auto; color: var(--text-dim); }
/* A category the archive holds nothing of recedes; it never disappears. */
ul.rail-types li.off a { color: var(--text-faint); }
ul.rail-types li.off .rail-n { color: var(--text-faint); }

/*
 * Reading text, as opposed to the annotation the rest of the site is made of.
 *
 * Everything else here is a label, a count or a claim, and 12px monospace-ish
 * annotation is the right register for those. The About page is the one place
 * with paragraphs a reader is meant to read end to end, and a 1080px-wide
 * 12px paragraph is not a reading surface at any hour.
 */
.prose p { font-size: 15px; line-height: 1.7; color: var(--text-dim); max-width: 68ch; margin: 0 0 16px; }
.prose p:last-child { margin-bottom: 0; }
.prose code { color: var(--text); }

.grid-sources { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 16px; }
.source-card {
  background: var(--panel-0);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  padding: 16px;
}
.source-card a { font-family: var(--mono); font-size: 13px; overflow-wrap: anywhere; }
.source-card p { margin: 8px 0 0; font-size: 12px; color: var(--text-faint); }

footer.site-foot {
  border-top: 1px solid var(--line);
  padding: 24px 0;
  font-size: 12px;
  color: var(--text-faint);
}
footer.site-foot a { color: var(--text-dim); }

.table-scroll { overflow-x: auto; }

/* Copy-paste shell blocks on the API page. Scrolls in its own box rather than
   wrapping, because a wrapped curl line pasted into a terminal is a broken
   command and the whole page is a promise that these run as written. */
.shell {
  margin: 0 0 16px;
  padding: 12px 14px;
  background: var(--panel-0);
  border: 1px solid var(--line);
  border-left: 2px solid var(--orange);
  border-radius: var(--radius-sm);
  overflow-x: auto;
  font-family: var(--mono);
  font-size: 13px;
  line-height: 1.7;
  color: var(--text);
  white-space: pre;
}
.shell:last-child { margin-bottom: 0; }
.tierlist { margin: 0; padding: 0; list-style: none; }
.tierlist li { padding: 12px 0; border-top: 1px solid var(--line); }
.tierlist li:first-child { border-top: 0; }
.tierlist .tiername { font-family: var(--display); font-weight: 700; color: var(--text); display: block; }
.tierlist .tierwhat { color: var(--text-dim); font-size: 14px; }

/*
 * THE FRONT DOOR.
 *
 * Two states of one block, and the order they are written in is the order they
 * take effect. Un-mounted is the real one: the stage has no box at all and the
 * tab list is a plain grid of links, which is what a reader without scripting,
 * without WebGL, or on a phone gets, and it is a complete index on its own.
 * The is-mounted class is added by wall.js only after a frame has been drawn.
 *
 * The list is never removed from the DOM in either state. Under is-mounted it
 * is transparent and lifted over the canvas, where a screen reader still reads
 * it and :focus-within brings it back into view the moment a keyboard reaches
 * it, because the canvas takes no focus and offers none.
 */
.wall { margin: 0 0 32px; }
.wall-frame { position: relative; }
.wall-stage {
  display: none;
  position: relative;
  height: clamp(400px, 58vh, 600px);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  overflow: hidden;
  background: var(--void);
}
/*
 * Mounted, the stage steps outside the 1080px measure the prose is set in.
 * That is not decoration: the tabs have to be wide enough to read a
 * 30-character catalogue id off, and at the text measure four columns come out
 * near 200px each. It stops 16px short of each viewport edge rather than using
 * 100vw, because 100vw includes the scrollbar and the page is not allowed to
 * scroll sideways.
 */
.wall.is-mounted .wall-frame {
  width: min(100vw - 32px, 1400px);
  margin-left: calc(50% - min(50vw - 16px, 700px));
}
.wall.is-mounted .wall-stage {
  display: block;
  width: 100%;
  /*
   * A starting value only. src/site/wall-js.ts overwrites this from the space
   * actually left below the stage's own top, because a clamp whose floor is
   * 420px resolves to 420px at the gate's minimum height and pushes the bottom
   * row of tabs past the fold, where a locked camera cannot reach it.
   */
  height: clamp(300px, 62vh, 640px);
}
.wall-stage canvas { display: block; width: 100%; height: 100%; }


/* ===========================================================================
 * THE WIRE
 *
 * Git history is this project's database, so the stream is drawn as a conductor
 * with the CAPTURES as nodes on it. The device is structural rather than
 * decorative: a node is a commit and a source, which is the key every claim here
 * is addressed by, and the distance between two nodes is how much that capture
 * actually changed. A busy capture clusters, a quiet one leaves the wire bare,
 * and the page's rhythm becomes the archive's rhythm instead of a constant.
 *
 * Depth comes from lighting a 2px conductor rather than from a second WebGL
 * scene. The front door already spends the page's 3D budget, and a canvas down
 * here would compete with it and cost every reader another 700 KB.
 * =========================================================================== */
.wire {
  list-style: none;
  margin: 0;
  padding: 0 0 0 34px;
  position: relative;
}
.wire::before {
  content: "";
  position: absolute;
  left: 8px;
  top: 6px;
  bottom: 6px;
  width: 2px;
  border-radius: 2px;
  background: linear-gradient(180deg, var(--orange) 0%, #6b3410 14%, var(--line) 46%, var(--line) 100%);
  box-shadow: 0 0 0 1px #000, 1px 0 0 rgba(255, 255, 255, 0.045), -1px 0 6px rgba(255, 106, 0, 0.16);
}

.capture { position: relative; margin: 0 0 34px; }
.capture:last-child { margin-bottom: 0; }

/* The stud. A bevel, a core and a cast shadow, so it reads as sitting ON the
 * conductor rather than beside it. */
.capture::before {
  content: "";
  position: absolute;
  left: -30px;
  top: 7px;
  width: 11px;
  height: 11px;
  border-radius: 50%;
  background: radial-gradient(circle at 34% 30%, #ffb680 0%, var(--orange) 42%, #7a3100 100%);
  box-shadow:
    0 0 0 3px var(--void),
    0 0 0 4px #3a1c07,
    0 1px 2px rgba(0, 0, 0, 0.9),
    0 0 10px rgba(255, 106, 0, 0.4);
}

.capture-head {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 12px;
  padding-bottom: 10px;
  border-bottom: 1px solid var(--line);
  margin-bottom: 16px;
}
/* The sha at display size, because it is the archive's primary key and not a
 * footnote. Printing it small was the page treating its own evidence as fine
 * print. */
.capture-sha {
  font-family: var(--mono);
  font-size: 19px;
  font-weight: 500;
  letter-spacing: 0.02em;
  color: var(--text);
  text-decoration: none;
  border-bottom: 1px solid transparent;
}
.capture-sha:hover { border-bottom-color: var(--orange); color: var(--orange); }
.capture-source { font-family: var(--mono); font-size: 12px; color: var(--orange); text-decoration: none; }
.capture-source:hover { text-decoration: underline; }
.capture-when { font-family: var(--mono); font-size: 12px; color: var(--text-faint); margin-left: auto; }
.capture-more { font-size: 12px; color: var(--text-faint); margin: 12px 0 0; }

/* ---- dispatches: the things a person came to read --------------------- */
.dispatches { list-style: none; margin: 0; padding: 0; }
.dispatch { margin: 0 0 20px; }
.dispatch:last-child { margin-bottom: 0; }
.dispatch-claim {
  font-family: var(--display);
  font-weight: 500;
  font-size: 21px;
  line-height: 1.34;
  letter-spacing: -0.011em;
  margin: 10px 0 8px;
  color: var(--text);
  overflow-wrap: anywhere;
  max-width: 62ch;
}
.dispatch-meta { font-family: var(--mono); font-size: 12px; color: var(--text-faint); margin: 0; }
/*
 * A QUOTED URL IS NOT A HEADLINE. The claim sentences are verbatim and must
 * stay that way, but several of them end in a quoted https:// run, and setting
 * that in 21px display type made the dispatch read as a broken headline. The
 * TEXT is unchanged; only its typography is, which is the same licence the
 * rendered diff takes when it masks an address.
 */
.dispatch-claim .url {
  font-family: var(--mono);
  font-size: 0.66em;
  font-weight: 400;
  color: var(--text-dim);
  letter-spacing: 0;
  overflow-wrap: anywhere;
}

/* ===========================================================================
 * THE TAPE
 *
 * 207 of 391 items are price movements. As cards they were what made the page
 * feel infinite, and they also said each one was a story, which is false: a
 * listed price moving is telemetry. One capture's movements collapse into a
 * monospace tape, many rows in the height one card used, carrying both of the
 * artifact's own numbers and the direction between them.
 *
 * Inset rather than raised: a readout recessed into the page, which is the one
 * surface here that is not a card.
 * =========================================================================== */
.tape {
  margin: 4px 0 0;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: linear-gradient(180deg, #08080a 0%, var(--panel-0) 100%);
  box-shadow: inset 0 2px 10px rgba(0, 0, 0, 0.75), inset 0 0 0 1px rgba(255, 255, 255, 0.015);
  overflow-x: auto;
}
/*
 * FIXED LAYOUT, and the model column is the one allowed to give way. The first
 * build let the subject column size to its content, which pushed the two
 * columns that carry the actual payload, the new value and the change, off the
 * right edge behind an overflow scroll. A tape whose numbers are off-screen is
 * a worse card.
 */
.tape table {
  width: 100%;
  table-layout: fixed;
  border-collapse: collapse;
  font-family: var(--mono);
  font-size: 12.5px;
}
.tape col.c-field { width: 26%; }
.tape col.c-from, .tape col.c-to { width: 26%; }
.tape col.c-arrow { width: 6%; }
.tape col.c-pct { width: 17%; }
.tape caption {
  caption-side: bottom;
  text-align: left;
  padding: 8px 14px 12px;
  font-family: var(--body);
  font-size: 11.5px;
  color: var(--text-faint);
}
.tape thead th {
  text-align: left;
  padding: 9px 14px;
  font-size: 10px;
  letter-spacing: 0.13em;
  text-transform: uppercase;
  color: var(--text-faint);
  font-weight: 500;
  border-bottom: 1px solid var(--line);
  white-space: nowrap;
}
.tape td {
  padding: 7px 14px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.032);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
/* The id is the row's subject, so it keeps its full value in the title even
 * when the column clips it. */
/* The model id, said once for the whole group. */
.tape-model th {
  text-align: left;
  padding: 12px 14px 5px;
  font-weight: 500;
  font-size: 12px;
  color: var(--text);
  border-bottom: 0;
  overflow-wrap: anywhere;
  white-space: normal;
}
.tape tbody tr.tape-model:first-child th { padding-top: 8px; }
.tape-row td:first-child { padding-left: 26px; }
.tape tbody tr:last-child td { border-bottom: 0; }
.tape tbody tr:hover td { background: rgba(255, 106, 0, 0.045); }

.tape-field { color: var(--text-faint); }
.tape-from { color: var(--text-faint); }
.tape-to { color: var(--text); }
/* No ellipsis here: the cell holds one glyph, and text-overflow was appending
 * a "…" to it, so the tape read "▼…" on every row. */
.tape-arrow {
  padding: 7px 4px;
  color: var(--text-faint);
  overflow: visible;
  text-overflow: clip;
  text-align: center;
}
.tape-pct { text-align: right; color: var(--text-dim); }
/*
 * Direction is carried by the glyph and by WEIGHT, not by a second hue. The
 * palette is one live colour on black on purpose, and a green-and-red tape
 * would break it and would also be the first thing on this site to encode
 * meaning in colour alone.
 */
.tape-up .tape-arrow, .tape-up .tape-pct { color: var(--orange); }
.tape-down .tape-arrow, .tape-down .tape-pct { color: var(--text-dim); }

/* ---- the day mark ------------------------------------------------------ */
.day-mark {
  font-family: var(--mono);
  font-size: 12px;
  letter-spacing: 0.16em;
  color: var(--text-faint);
  margin: 0 0 20px;
  display: flex;
  align-items: center;
  gap: 14px;
}
.day-mark::after { content: ""; flex: 1; height: 1px; background: var(--line); }

@media (prefers-reduced-motion: reduce) {
  .capture::before { box-shadow: 0 0 0 3px var(--void), 0 0 0 4px #3a1c07; }
}

@media (max-width: 640px) {
  .wire { padding-left: 24px; }
  .capture::before { left: -22px; }
  .dispatch-claim { font-size: 18px; }
  .capture-sha { font-size: 16px; }
  .capture-when { margin-left: 0; }
}


/*
 * THE RESPONSIVE FLOOR. Long values here are catalogue ids, model names and
 * URLs, none of which contain spaces, so anything that renders one has to be
 * told it may break inside a word. Measured at 375px before this: the body
 * scrolled to 629px, from the headline rows, the entity chips and inline code.
 */
.chip, .chips a, code {
  max-width: 100%;
  overflow-wrap: anywhere;
  word-break: break-word;
}
.chip { display: inline-flex; flex-wrap: wrap; }

.headlines { border-color: var(--line); }
.headline-list { list-style: none; margin: 0; padding: 0; }
.headline {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 8px;
  padding: 12px 0;
  border-top: 1px solid var(--line);
}
.headline:first-child { border-top: 0; }
/*
 * min-width:0 is the load-bearing half. A flex item defaults to min-width:auto,
 * so a long sentence refuses to shrink below its content and pushes the row
 * wider than the viewport: measured at 375px the body scrolled to 629px. The
 * basis stays generous on wide screens and the row stacks below 560px.
 */
.headline-claim { flex: 1 1 24ch; min-width: 0; color: var(--text); overflow-wrap: anywhere; }
.headline-when { color: var(--text-dim); font-size: 12px; white-space: nowrap; }

@media (max-width: 560px) {
  .headline { flex-direction: column; align-items: flex-start; gap: 6px; }
  .headline-claim { flex: 1 1 auto; }
}

.wall-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(232px, 1fr));
  gap: 8px;
}
.wall-list a {
  display: block;
  padding: 12px 14px;
  background: var(--panel-0);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  color: var(--text);
}
.wall-list a:hover { border-color: var(--orange); text-decoration: none; }
.wall-kind {
  display: block;
  font-family: var(--mono);
  font-size: 10px;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: var(--orange);
}
.wall-label {
  display: block;
  font-family: var(--mono);
  font-size: 13px;
  color: var(--text);
  overflow-wrap: anywhere;
  margin: 4px 0;
}
.wall-meta { display: block; font-family: var(--mono); font-size: 11px; color: var(--text-faint); }
.wall-note { margin: 12px 0 0; }

/*
 * The breakout lives on the FRAME, not on the stage, so this list inherits the
 * same box and covers the canvas completely when a keyboard reaches it. Put on
 * the stage instead, the revealed list would be a 1080px panel floating inside
 * a 1400px wall with slabs showing past both of its edges.
 */
.wall.is-mounted .wall-list {
  position: absolute;
  inset: 0;
  margin: 0;
  padding: 16px;
  overflow: auto;
  align-content: start;
  background: var(--void);
  border-radius: var(--radius);
  opacity: 0;
  pointer-events: none;
}
.wall.is-mounted .wall-list:focus-within { opacity: 1; pointer-events: auto; }

@media (max-width: 900px) {
  .split { grid-template-columns: 1fr; gap: 24px; }
  .split-side { margin-top: 16px; }
}

@media (max-width: 640px) {
  h1 { font-size: 24px; }
  /*
   * The masthead on a phone. Wrapping is allowed and the vertical padding on
   * each link is cut, because the desktop padding is what draws the active
   * underline clear of the text and on two wrapped rows it becomes 90px of
   * header above the first word of news.
   */
  .site-head .wrap { gap: 4px 16px; align-items: center; padding-top: 12px; }
  .site-head nav { gap: 4px 16px; font-size: 13px; width: 100%; }
  .site-head nav a { padding: 4px 0 6px; }
  .site-head .util { padding-bottom: 12px; gap: 16px; }
  .brand { font-size: 15px; }
  main { padding: 24px 0 48px; }
  .lede { margin-bottom: 24px; }
  .filterbar { padding: 12px 0 16px; margin-bottom: 24px; }
  /*
   * The front door's tab list on a phone, where the 3D never mounts. It becomes
   * a chip row rather than a card grid, because the deliberate ordering on this
   * page is news above navigation and twelve cards would be a full screen of
   * links before the first item.
   *
   * The count and the stamp come off the chip, and they are the only thing on
   * this page that a narrow viewport removes. They are not lost: the identical
   * numbers, with the identical origin/observed label, are in the Live threads
   * rail further down THIS page and on each thread page the chips link to. A
   * chip still names its entity and its kind, which is what makes it a link
   * worth following.
   */
  .wall-list { display: flex; flex-wrap: wrap; gap: 4px; }
  .wall-list a { padding: 5px 8px; }
  .wall-list .wall-meta { display: none; }
  .wall-list .wall-kind, .wall-list .wall-label { display: inline; }
  .wall-list .wall-label { margin: 0 0 0 5px; font-size: 11px; }
  .wall-list .wall-kind { font-size: 9px; }
  li.event { padding: 16px; }
  h1.sha-title { font-size: 20px; }
  .wrap { padding: 0 16px; }
  .panel { padding: 16px; }
}

/* The client-side filter, drawn over a list that is complete without it. */
.filter {
  display: flex;
  align-items: baseline;
  gap: 12px;
  margin: 0 0 16px;
}
.filter-input {
  flex: 1 1 auto;
  max-width: 420px;
  padding: 8px 12px;
  font: inherit;
  font-family: 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.85rem;
  color: var(--text);
  background: var(--panel-1);
  border: 1px solid var(--line);
  border-radius: var(--radius);
}
.filter-input:focus {
  outline: 2px solid var(--orange);
  outline-offset: 1px;
}
.filter-input::placeholder { color: var(--muted); }
.filter-count {
  font-family: 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.75rem;
  color: var(--muted);
}
`;
