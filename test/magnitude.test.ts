import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { countUnits, shrinkVerdict } from '../src/magnitude.js';
import { loadSources } from '../src/config.js';
import type { Source } from '../src/config.js';

const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);

const shipped = (): Source[] =>
  loadSources(JSON.parse(fs.readFileSync('meta/sources.json', 'utf8'))).sources;

const sourceFor = (id: string): Source => shipped().find((s) => s.id === id)!;

/** A source with a named shrink limit, so a test can state the boundary it means. */
const withLimit = (id: string, maxShrinkPct: number): Source => ({
  ...sourceFor(id),
  magnitudeGuard: { maxShrinkPct },
});

const json = sourceFor('openrouter-models');
const xml = sourceFor('anthropic-sitemap');
const text = sourceFor('claude-llms-txt');

const records = (n: number): Uint8Array =>
  bytes(JSON.stringify({ data: Array.from({ length: n }, (_, i) => ({ id: `m${i}` })) }));

const urls = (n: number): Uint8Array =>
  bytes(`<urlset>${Array.from({ length: n }, (_, i) => `<url><loc>https://x/${i}</loc></url>`).join('')}</urlset>`);

const lines = (n: number): Uint8Array => bytes(Array.from({ length: n }, (_, i) => `line ${i}`).join('\n'));

describe('countUnits', () => {
  it('counts a json source at the length of its required key path array', () => {
    expect(countUnits(json, records(417))).toBe(417);
  });

  it('reports null for a json body that no longer parses', () => {
    expect(countUnits(json, bytes('{"data":['))).toBeNull();
  });

  it('reports null for a json body whose required key path is not an array', () => {
    expect(countUnits(json, bytes('{"data":{"a":1}}'))).toBeNull();
  });

  it('counts a top level json array when there is no required key path', () => {
    expect(countUnits({ ...json, invariants: { ...json.invariants, requiredKeyPath: null } }, bytes('[1,2,3]'))).toBe(3);
  });

  it('counts a top level json object at its key count when there is no required key path', () => {
    expect(
      countUnits({ ...json, invariants: { ...json.invariants, requiredKeyPath: null } }, bytes('{"a":1,"b":2}')),
    ).toBe(2);
  });

  it('counts an xml sitemap at its url elements', () => {
    expect(countUnits(xml, urls(522))).toBe(522);
  });

  it('counts an atom feed at its entry elements', () => {
    expect(countUnits(sourceFor('openai-status'), bytes('<feed><entry/><entry/><entry/></feed>'))).toBe(3);
  });

  // `<atom:entry>` is an entry. A namespaced feed counting zero would leave the
  // guard unable to fire on the source whose collapse it most needs to catch.
  it('counts a namespaced entry element', () => {
    expect(countUnits(sourceFor('openai-status'), bytes('<atom:feed><atom:entry/></atom:feed>'))).toBe(1);
  });

  it('reports null for an xml body with no record elements at all', () => {
    expect(countUnits(xml, bytes('<urlset></urlset>'))).toBeNull();
  });

  // A JSON body of bare `null` parses, so the try/catch never sees it, and the
  // optional chaining is the only thing between it and a TypeError.
  it('reports null for a json body that is the literal null', () => {
    expect(countUnits(json, bytes('null'))).toBeNull();
  });

  it('reports null for a json body that is a bare string', () => {
    expect(
      countUnits({ ...json, invariants: { ...json.invariants, requiredKeyPath: null } }, bytes('"a string"')),
    ).toBeNull();
  });

  it('reports null for a json body that is a bare null and has no required key path', () => {
    expect(countUnits({ ...json, invariants: { ...json.invariants, requiredKeyPath: null } }, bytes('null'))).toBeNull();
  });

  it('reports null for a json body that is a number', () => {
    expect(countUnits({ ...json, invariants: { ...json.invariants, requiredKeyPath: null } }, bytes('7'))).toBeNull();
  });

  // Every real Atom entry in the archive is a bare `<entry>`, so an attribute
  // is exactly the case a regex written against the archive gets wrong.
  it('counts an entry element that carries an attribute', () => {
    expect(countUnits(sourceFor('openai-status'), bytes('<feed><entry xml:base="x"></entry></feed>'))).toBe(1);
  });

  it('counts a self closing entry element that carries an attribute', () => {
    expect(countUnits(sourceFor('openai-status'), bytes('<feed><entry foo="bar"/></feed>'))).toBe(1);
  });

  // `<entryPoint>` is not an entry. Without the terminator alternation the
  // count picks up every element whose name merely starts with one of the three.
  it('does not count an element whose name merely starts with a record name', () => {
    expect(countUnits(sourceFor('openai-status'), bytes('<feed><entryPoint/><urlset/></feed>'))).toBeNull();
  });

  it('counts a text source at its lines', () => {
    expect(countUnits(text, lines(120))).toBe(120);
  });
});

describe('shrinkVerdict', () => {
  it('does not hold the first snapshot of a source, because there is no baseline', () => {
    expect(shrinkVerdict(json, records(1), null)).toEqual({ held: false });
  });

  it('does not hold growth, however large', () => {
    expect(shrinkVerdict(json, records(4000), records(100))).toEqual({ held: false });
  });

  it('does not hold an unchanged count', () => {
    expect(shrinkVerdict(json, records(417), records(417))).toEqual({ held: false });
  });

  it('holds a json source that lost more than a quarter of its records', () => {
    const got = shrinkVerdict(withLimit('openrouter-models', 25), records(74), records(100));
    expect(got).toEqual({
      held: true,
      reason: 'magnitude guard: 100 to 74 units is a 26.0% removal, over the 25% limit',
    });
  });

  // The boundary reads as "this much is still fine", so exactly the limit passes.
  it('accepts a removal of exactly the configured limit', () => {
    expect(shrinkVerdict(withLimit('openrouter-models', 25), records(75), records(100))).toEqual({ held: false });
  });

  it('holds one record past the configured limit', () => {
    expect(shrinkVerdict(withLimit('openrouter-models', 25), records(74), records(100)).held).toBe(true);
  });

  it('reads the limit from the source rather than a constant', () => {
    expect(shrinkVerdict(withLimit('openrouter-models', 50), records(74), records(100))).toEqual({ held: false });
  });

  it('holds an xml sitemap that lost most of its urls', () => {
    expect(shrinkVerdict(xml, urls(100), urls(522)).held).toBe(true);
  });

  it('holds a text source that lost most of its lines', () => {
    expect(shrinkVerdict(text, lines(10), lines(120)).held).toBe(true);
  });

  // The 616-page deletion scenario, which is the case the guard was written
  // for and the one health can never see: it parses, it carries its canary, it
  // sits inside the size band, and it has simply lost its content.
  it('holds a sitemap that fell from 522 urls to 6', () => {
    expect(shrinkVerdict(xml, urls(6), urls(522))).toEqual({
      held: true,
      reason: 'magnitude guard: 522 to 6 units is a 98.9% removal, over the 25% limit',
    });
  });

  it('does not hold when the stored baseline has no countable units', () => {
    expect(shrinkVerdict(json, records(1), bytes('not json at all'))).toEqual({ held: false });
  });

  it('does not hold when the new body has no countable units', () => {
    expect(shrinkVerdict(json, bytes('not json at all'), records(500))).toEqual({ held: false });
  });

  // A zero baseline reaches the growth check rather than a clause of its own,
  // and the growth check is the only thing standing between it and a 0/0
  // division that reports a NaN% removal as a hold.
  it('does not hold when the baseline counted zero', () => {
    expect(shrinkVerdict(json, records(0), records(0))).toEqual({ held: false });
  });

  it('does not hold a zero baseline even at a zero limit', () => {
    expect(shrinkVerdict(withLimit('openrouter-models', 0), records(0), records(0))).toEqual({ held: false });
  });
});

describe('src/magnitude.ts stays pure', () => {
  const imports = (): string[] =>
    [...fs.readFileSync('src/magnitude.ts', 'utf8').matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]!).sort();

  it('imports exactly one module, and it is a type source', () => {
    expect(imports()).toEqual(['./config.js']);
  });

  it('imports nothing that touches a disk, a process, a network or a repository', () => {
    const forbidden = ['node:fs', 'node:child_process', './fetch.js', './git.js'];
    expect(imports().filter((i) => forbidden.includes(i))).toEqual([]);
  });
});
