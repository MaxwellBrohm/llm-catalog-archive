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
export const STYLESHEET = `@import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;700&family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap');

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
.site-head nav { display: flex; gap: 16px; font-size: 13px; }
.site-head nav a { color: var(--text-dim); }
.site-head nav a:hover { color: var(--orange-hot); }

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

@media (max-width: 640px) {
  h1 { font-size: 24px; }
  h1.sha-title { font-size: 20px; }
  .wrap { padding: 0 16px; }
  .panel { padding: 16px; }
}
`;
