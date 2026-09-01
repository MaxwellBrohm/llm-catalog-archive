import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { git } from '../src/git.js';
import {
  CREDENTIAL_PATTERN_NAMES,
  scanForSecrets,
  secretVerdict,
  shannonBits,
} from '../src/secrets.js';

const enc = (s: string) => new TextEncoder().encode(s);

/**
 * A synthetic credential, generated here rather than pasted from anywhere.
 *
 * THE KEY THAT MOTIVATED THIS MODULE APPEARS NOWHERE IN THIS REPOSITORY, and
 * a test fixture is the easiest place for it to end up: a fixture is committed
 * to the same public history the gate exists to protect, and a gate tested
 * with the secret it was built to stop would have archived it after all.
 *
 * The generator is a deterministic LCG reading its HIGH bits, so the tests are
 * reproducible and the token still has a credential's shape. Measured against
 * the real thing: the live xAI key was 80 characters, 39 distinct, 5.05 bits
 * per character; `synthetic(80, 7)` is 80 characters, 40 distinct, 5.12 bits.
 * Close enough to stand in, and generated rather than copied.
 */
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

export function synthetic(n: number, seed: number): string {
  let x = seed >>> 0;
  let out = '';
  for (let i = 0; i < n; i++) {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    out += ALPHABET[(x >>> 16) % ALPHABET.length];
  }
  return out;
}

export const KEY80 = synthetic(80, 7);

/**
 * The shape the live incident arrived in: a JSON assignment and a bare
 * occurrence, in one body. `intro\n` is six bytes, so the `"apiKey"` starts at
 * byte 7 and the `xai-` inside it at byte 18, and those offsets are asserted
 * rather than computed by the test.
 */
const incidentBody = (): Uint8Array => enc(`intro\n{"apiKey": "xai-${KEY80}"}\nxai-${KEY80}\n`);

describe('the synthetic credential still has a credential shape', () => {
  it('generates a token of the length the live incident carried', () => {
    expect(KEY80.length).toBe(80);
  });

  it('generates a token above every entropy floor in the module', () => {
    expect(shannonBits(KEY80)).toBeCloseTo(5.1202, 3);
  });
});

describe('shannonBits', () => {
  it('scores a string of one repeated character at zero bits', () => {
    expect(shannonBits('aaaa')).toBe(0);
  });

  it('scores an evenly alternating pair at exactly one bit', () => {
    expect(shannonBits('abab')).toBe(1);
  });

  it('scores the empty string at zero without needing a guard for it', () => {
    expect(shannonBits('')).toBe(0);
  });

  // The three measurements the floors are set from. Documentation placeholders
  // and hyphen-joined prose land in the threes; a credential lands above five.
  it('scores the commonest placeholder at 3.29 bits', () => {
    expect(shannonBits('YOUR_API_KEY_HERE')).toBeCloseTo(3.2928, 3);
  });

  it('scores a hyphen-joined sentence fragment at 3.70 bits', () => {
    expect(shannonBits('console-or-through-api')).toBeCloseTo(3.6978, 3);
  });

  it('scores a hyphenated documentation example at 3.69 bits', () => {
    expect(shannonBits('realtime-client-secret-abc123')).toBeCloseTo(3.6899, 3);
  });
});

/**
 * The finding is the whole point of the module's shape. It travels into a log
 * line, into `meta/status.json` and into a written report, and all three are
 * committed to the public repository the gate exists to protect.
 */
describe('scanForSecrets, what a finding may contain', () => {
  it('reports the pattern, the count and the offset and nothing else', () => {
    expect(scanForSecrets(incidentBody())).toEqual([
      { pattern: 'xai-api-key', count: 2, firstOffset: 18 },
      { pattern: 'generic-api-key-assignment', count: 1, firstOffset: 7 },
    ]);
  });

  // The absence claim below is only worth something because this one says the
  // scan really did find the token it is then asserted not to quote.
  it('finds both occurrences of the credential it is about to not quote', () => {
    expect(scanForSecrets(incidentBody())[0]?.count).toBe(2);
  });

  it('never puts the matched text into its own findings', () => {
    expect(JSON.stringify(scanForSecrets(incidentBody())).includes(KEY80)).toBe(false);
  });

  it('never puts even a fragment of the matched text into its findings', () => {
    expect(JSON.stringify(scanForSecrets(incidentBody())).includes(KEY80.slice(0, 12))).toBe(false);
  });

  it('reports nothing at all for a body with no credential in it', () => {
    expect(scanForSecrets(enc('# Docs\n\nSet your key with the XAI_API_KEY environment variable.\n'))).toEqual([]);
  });

  /**
   * The offset is a BYTE offset, and a character index reported as one sends
   * an operator to the wrong place. The prefix here is five three-byte
   * characters, so the character index is 5 and the byte offset is 15.
   */
  it('reports the offset in bytes rather than in characters', () => {
    expect(scanForSecrets(enc(`一丁丂七丄xai-${KEY80}`))[0]?.firstOffset).toBe(15);
  });
});

/**
 * Both directions, on the numbers actually measured in xAI's live `llms.txt`.
 * Without the floors every one of these prefixes flags prose, and a gate that
 * flags prose is a gate somebody switches off.
 */
describe('scanForSecrets, the length and entropy floors', () => {
  it('does not flag the commonest placeholder in provider documentation', () => {
    expect(scanForSecrets(enc('curl -H "Authorization: Bearer xai-YOUR_API_KEY_HERE"'))).toEqual([]);
  });

  it('does not flag a hyphen-joined sentence fragment that starts with a prefix', () => {
    expect(scanForSecrets(enc('Get one from the xai-console-or-through-api page.'))).toEqual([]);
  });

  it('does not flag a long documentation example that starts with a prefix', () => {
    expect(scanForSecrets(enc('The xai-realtime-client-secret-abc123 value goes here.'))).toEqual([]);
  });

  it('does not flag a long run of one repeated character', () => {
    expect(scanForSecrets(enc(`xai-${'X'.repeat(80)}`))).toEqual([]);
  });

  it('does not flag a high-entropy token shorter than the pattern allows', () => {
    expect(scanForSecrets(enc(`xai-${synthetic(30, 21)}`))).toEqual([]);
  });

  it('flags a high-entropy token at exactly the length the pattern allows', () => {
    expect(scanForSecrets(enc(`xai-${synthetic(40, 3)}`))).toEqual([
      { pattern: 'xai-api-key', count: 1, firstOffset: 0 },
    ]);
  });

  /**
   * The entropy boundary, which needs a token whose entropy is EXACTLY the
   * floor rather than near it. Sixteen distinct characters each appearing the
   * same number of times gives exactly log2(16) bits, and every term is a
   * power of two so the sum is exact rather than close.
   *
   * The floor reads as "this much randomness is still credential-shaped", so
   * a token sitting on it is flagged. Without this the comparison can be
   * loosened from `<` to `<=` and nothing notices.
   */
  const AT_FLOOR = 'ABCDEFGHIJKLMNOP'.repeat(3);

  it('generates a boundary token of exactly four bits, so the test below is about the boundary', () => {
    expect(shannonBits(AT_FLOOR)).toBe(4);
  });

  it('flags a token sitting exactly on the entropy floor', () => {
    expect(scanForSecrets(enc(`xai-${AT_FLOOR}`))).toEqual([
      { pattern: 'xai-api-key', count: 1, firstOffset: 0 },
    ]);
  });

  it('does not flag the literal prefix on its own, however often it appears', () => {
    expect(scanForSecrets(enc('sk- sk- sk- xai- xai- glpat- AKIA AIza xoxb- ghp_'))).toEqual([]);
  });
});

/**
 * One `it` per pattern, because a list of nine checked by one loop is one
 * assertion that any single broken entry can still pass.
 */
describe('scanForSecrets, each issuer format', () => {
  const only = (body: string): string[] => scanForSecrets(enc(body)).map((f) => f.pattern);

  it('names the xAI format', () => {
    expect(only(`xai-${synthetic(80, 7)}`)).toEqual(['xai-api-key']);
  });

  it('names the Anthropic format', () => {
    expect(only(`sk-ant-api03-${synthetic(80, 31)}`)).toEqual(['anthropic-api-key']);
  });

  it('names the OpenAI format', () => {
    expect(only(`sk-${synthetic(48, 37)}`)).toEqual(['openai-api-key']);
  });

  // Otherwise a single Anthropic key is reported twice under two names, and a
  // count that says two credentials when there is one is a lie an operator
  // acts on.
  it('does not also report an Anthropic key under the OpenAI name', () => {
    expect(only(`sk-ant-api03-${synthetic(80, 31)}`)).not.toContain('openai-api-key');
  });

  it('names the AWS access key id format', () => {
    expect(only(`AKIA${synthetic(16, 19).toUpperCase()}`)).toEqual(['aws-access-key-id']);
  });

  it('names the GitHub personal token format', () => {
    expect(only(`ghp_${synthetic(36, 5)}`)).toEqual(['github-token']);
  });

  it('names the GitHub OAuth token format', () => {
    expect(only(`gho_${synthetic(36, 41)}`)).toEqual(['github-token']);
  });

  it('names the GitHub fine-grained token format', () => {
    expect(only(`github_pat_${synthetic(82, 43)}`)).toEqual(['github-token']);
  });

  it('names the Google format', () => {
    expect(only(`AIza${synthetic(35, 9)}`)).toEqual(['google-api-key']);
  });

  it('names the Slack bot token format', () => {
    expect(only(`xoxb-${synthetic(40, 47)}`)).toEqual(['slack-token']);
  });

  it('names the Slack user token format', () => {
    expect(only(`xoxp-${synthetic(40, 53)}`)).toEqual(['slack-token']);
  });

  it('names the GitLab format', () => {
    expect(only(`glpat-${synthetic(20, 17)}`)).toEqual(['gitlab-pat']);
  });

  // The catch-all is the reason this is not merely a list of prefixes: it is
  // what would catch a provider who invents their own key format tomorrow.
  it('names an assignment to a key the module has never heard of', () => {
    expect(only(`{"api_key": "${synthetic(44, 59)}"}`)).toEqual(['generic-api-key-assignment']);
  });

  // The live incident was camelCase. A case-sensitive `api[_-]?key` misses it.
  it('matches the camelCase spelling the live incident used', () => {
    expect(only(`{"apiKey": "${synthetic(44, 59)}"}`)).toEqual(['generic-api-key-assignment']);
  });

  it('matches the hyphenated spelling of the same key name', () => {
    expect(only(`{"api-key": "${synthetic(44, 59)}"}`)).toEqual(['generic-api-key-assignment']);
  });

  /**
   * Minified JSON, which is what most of this archive actually is:
   * openrouter-models is 705 KB of it. A catch-all that needed a space after
   * the colon would miss every credential in every minified body, which is
   * most of the bodies the gate will ever see.
   */
  it('matches the assignment with no space around the colon at all', () => {
    expect(only(`{"apiKey":"${synthetic(44, 59)}"}`)).toEqual(['generic-api-key-assignment']);
  });

  // The other direction a formatter produces, and the one a `\S*` would eat.
  it('matches the assignment with whitespace before the colon', () => {
    expect(only(`{"apiKey" : "${synthetic(44, 59)}"}`)).toEqual(['generic-api-key-assignment']);
  });

  it('matches the assignment split across lines by a pretty-printer', () => {
    expect(only(`{"apiKey":\n    "${synthetic(44, 59)}"}`)).toEqual(['generic-api-key-assignment']);
  });

  it('checks exactly these nine formats, in this order', () => {
    expect(CREDENTIAL_PATTERN_NAMES).toEqual([
      'xai-api-key',
      'anthropic-api-key',
      'openai-api-key',
      'aws-access-key-id',
      'github-token',
      'google-api-key',
      'slack-token',
      'gitlab-pat',
      'generic-api-key-assignment',
    ]);
  });
});

describe('secretVerdict', () => {
  it('does not hold a body with no credential in it', () => {
    expect(secretVerdict(enc('# Docs\n'))).toEqual({ held: false });
  });

  it('holds a body carrying a credential', () => {
    const v = secretVerdict(incidentBody());
    expect(v.held).toBe(true);
  });

  it('gives a reason naming every pattern, its count and its offset', () => {
    const v = secretVerdict(incidentBody());
    expect(v.held === true && v.reason).toBe(
      'credential gate: xai-api-key x2 at byte 18, generic-api-key-assignment x1 at byte 7',
    );
  });

  it('never puts the matched text into the reason it commits', () => {
    const v = secretVerdict(incidentBody());
    expect(v.held === true && v.reason.includes(KEY80)).toBe(false);
  });
});

/**
 * The gate against the bytes this repository has actually stored.
 *
 * Two claims in one sweep would be one claim, so the archive scan and the
 * fixture scan are separate. The archive one is the load-bearing one: if any
 * committed capture tripped the gate, activating that source would take it
 * dark on its next run and the first anyone would know is a silent source.
 */
describe('the credential gate against the real archive', () => {
  const captures = (): string[] =>
    fs
      .readdirSync('raw', { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .flatMap((e) =>
        fs
          .readdirSync(path.join('raw', e.name))
          .filter((n) => n.startsWith('response.'))
          .map((n) => path.join('raw', e.name, n)),
      )
      .sort();

  it('has captures to scan, so the sweep below is not vacuous', () => {
    expect(captures().length).toBeGreaterThan(10);
  });

  it('finds no credential in any capture the collector has committed', () => {
    const tripped = captures().filter((p) => scanForSecrets(new Uint8Array(fs.readFileSync(p))).length > 0);
    expect(tripped).toEqual([]);
  });

  /**
   * The two challenge captures carry `cH`, `md`, `mdrd` and `__cf_chl_tk`
   * blobs that look secret-shaped to a reader. They are single-use, IP-bound,
   * minutes-long challenge nonces that authorise nothing, and the gate agrees.
   */
  it('finds no credential in either real challenge capture', () => {
    const tripped = ['trap-cf-challenge-udemy.html', 'trap-cf-challenge-indeed.html'].filter(
      (n) => scanForSecrets(new Uint8Array(fs.readFileSync(path.join('test/fixtures', n)))).length > 0,
    );
    expect(tripped).toEqual([]);
  });
});

/**
 * THE PRESIGNED S3 URL, WHICH IS THE SHAPE THAT PUT A REAL CREDENTIAL IN THIS
 * REPOSITORY IN THE FIRST PLACE.
 *
 * `trap-interstitial.html` arrived on 2026-08-26 carrying a real AWS access
 * key id twelve times, in the `X-Amz-Credential` parameter of presigned URLs
 * the neuron newsletter published for its own audio files. It has since been
 * redacted out of the fixture going forward, and history was left alone: an
 * access key id is the public half of the pair and AWS puts it in the headers
 * of every signed request by design, so it was not worth rewriting a published
 * history over.
 *
 * These tests deliberately do NOT read that fixture. Asserting against a real
 * third-party credential makes it part of the test contract, and then the
 * repository fights anyone who later tries to clean it up. Everything below is
 * generated by the same seeded LCG the rest of this file uses: a fake key id, a
 * fake signature, and the real URL shape.
 *
 * The shape still matters, because a presigned URL is not merely an
 * identifier. The signature beside the key id is a working read grant with an
 * expiry, so archiving one republishes access rather than a name. That is why
 * the AWS entropy floor sits at 3.4 rather than 4.0: sixteen characters cannot
 * exceed log2(16) = 4.0 bits however random they are, so no floor separates a
 * real key id from a memorable one, and holding is the safe direction.
 */
describe('the credential gate against a presigned S3 URL', () => {
  const KEY_ID = `AKIA${synthetic(16, 19).toUpperCase()}`;
  const SIGNATURE = synthetic(64, 23);

  const presigned = (n: number): string =>
    Array.from(
      { length: n },
      (_, i) =>
        `https://example-bucket.s3.amazonaws.com/audio/${i}.mp3?X-Amz-Algorithm=AWS4-HMAC-SHA256` +
        `&X-Amz-Credential=${KEY_ID}%2F20260826%2Fus-east-1%2Fs3%2Faws4_request` +
        `&X-Amz-Date=20260826T213824Z&X-Amz-Expires=604800&X-Amz-Signature=${SIGNATURE}`,
    ).join('\n');

  it('generates a key id of the length AWS actually issues', () => {
    expect(KEY_ID.length).toBe(20);
  });

  it('flags the key id in a presigned URL', () => {
    expect(scanForSecrets(enc(presigned(1)))).toEqual([
      { pattern: 'aws-access-key-id', count: 1, firstOffset: 102 },
    ]);
  });

  it('counts every presigned URL in a page that repeats one grant', () => {
    expect(scanForSecrets(enc(presigned(12)))[0]?.count).toBe(12);
  });

  // The offset is a byte offset and the URLs above are ASCII, so this fixes
  // the character-versus-byte question against a body that has both.
  it('reports the byte offset of the first grant on a page with multi-byte text above it', () => {
    // 102 in the bare URL, plus fifteen bytes of five three-byte characters
    // and a newline. The character index would be 108.
    expect(scanForSecrets(enc(`一丁丂七丄\n${presigned(1)}`))[0]?.firstOffset).toBe(118);
  });

  it('does not flag the same URL once the credential is redacted out of it', () => {
    expect(scanForSecrets(enc(presigned(12).replaceAll(KEY_ID, 'REDACTED')))).toEqual([]);
  });
});

/**
 * The same claim `src/magnitude.ts` and `src/predicate.ts` make about
 * themselves. A gate that reads a file or starts a process cannot be reasoned
 * about from its arguments.
 */
describe('src/secrets.ts stays pure', () => {
  const imports = (): string[] =>
    [...fs.readFileSync('src/secrets.ts', 'utf8').matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]!).sort();

  it('imports nothing at all', () => {
    expect(imports()).toEqual([]);
  });

  it('imports nothing that touches a disk, a process, a network or a repository', () => {
    const forbidden = ['node:fs', 'node:child_process', './fetch.js', './git.js'];
    expect(imports().filter((i) => forbidden.includes(i))).toEqual([]);
  });
});

/**
 * EVERY TRACKED FILE, NOT JUST THE COLLECTOR'S CAPTURES.
 *
 * The gate in `src/run.ts` scans response bodies at write time, which is the
 * path third-party bytes normally take into this repository. It is not the
 * only one. A FIXTURE is third-party bytes too, captured by hand and committed
 * by hand, and that is exactly how a real AWS access key id arrived here on
 * 2026-08-26 inside `trap-interstitial.html`: a route with no gate on it at
 * all. The write-time gate could never have caught it, because no collector
 * run ever produced that file.
 *
 * So this sweeps the whole tracked tree with the same patterns. It is the
 * cheap half of the job the write gate does, and it closes the hand-committed
 * route rather than trusting that nobody will use it again.
 *
 * The file list comes from `git ls-files` through the repository's own git
 * helper, so it is exactly what is committed: ignored files, `node_modules`
 * and build output are out of scope by construction rather than by a
 * hand-maintained skip list that would rot.
 */
describe('the credential gate against every tracked file', () => {
  const REPO = process.cwd();

  /**
   * Files permitted to carry something the gate flags, and why.
   *
   * EMPTY, AND IT SHOULD STAY THAT WAY. The only thing that ever belongs here
   * is a SYNTHETIC value some test needs as a source literal rather than as a
   * generated one. A real credential never belongs here: the fix for a real
   * one is to take it out of the file, which is what was done to
   * `trap-interstitial.html`. An entry is a deliberate, reviewed exception and
   * it has to say which pattern it is excusing, so it cannot quietly widen
   * into "this whole file is exempt".
   */
  const ALLOWLIST: Record<string, string[]> = {};

  const trackedFiles = (): string[] =>
    git(['ls-files'], REPO)
      .stdout.split('\n')
      .map((l) => l.trim())
      .filter((l) => l !== '');

  /** Every `<file>:<pattern>` the gate scores, minus what the allowlist excuses. */
  const sweep = (): { hits: string[]; bytes: number } => {
    const hits: string[] = [];
    let bytes = 0;
    for (const f of trackedFiles()) {
      const abs = path.join(REPO, f);
      if (!fs.existsSync(abs) || fs.statSync(abs).isDirectory()) continue;
      const body = new Uint8Array(fs.readFileSync(abs));
      bytes += body.byteLength;
      const excused = ALLOWLIST[f] ?? [];
      for (const finding of scanForSecrets(body)) {
        if (!excused.includes(finding.pattern)) hits.push(`${f}:${finding.pattern}`);
      }
    }
    return { hits, bytes };
  };

  // Three claims that together make a clean sweep a measurement rather than an
  // empty loop: the list is the real tracked set, it reaches the places
  // third-party bytes actually live, and it reads their bytes.
  it('lists the whole tracked tree rather than a handful of files', () => {
    expect(trackedFiles().length).toBeGreaterThan(100);
  });

  it('reaches the archive, the fixtures and the source alike', () => {
    const all = trackedFiles();
    for (const f of ['src/secrets.ts', 'test/fixtures/trap-interstitial.html', 'raw/arena-leaderboard/response.html']) {
      expect(all).toContain(f);
    }
  });

  it('reads real bytes rather than skipping every file it listed', () => {
    expect(sweep().bytes).toBeGreaterThan(10_000_000);
  });

  it('finds no credential in any tracked file', () => {
    expect(sweep().hits).toEqual([]);
  });

  it('excuses nothing today', () => {
    expect(Object.keys(ALLOWLIST)).toEqual([]);
  });

  // A stale entry is an exception nobody is enforcing any more, and it reads
  // as coverage.
  it('keeps every allowlisted path a path that is still tracked', () => {
    const all = new Set(trackedFiles());
    expect(Object.keys(ALLOWLIST).filter((f) => !all.has(f))).toEqual([]);
  });
});
