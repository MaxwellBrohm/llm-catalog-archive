/**
 * The credential gate: the last thing between a provider's mistake and a
 * public history that is never rewritten.
 *
 * On 2026-08-31 xAI's own published `llms.txt` carried an 84 character `xai-`
 * credential, three times, as `"apiKey": "xai-..."`. The collector captured it
 * and committed it locally, and GitHub push protection is the only reason it
 * never reached the archive. R1 says store third party bytes exactly as
 * received and R7 says history is never rewritten, so together they would have
 * us republish a provider's own live secret, permanently. R1 cannot mean that.
 *
 * Depending on push protection is not a control. It only recognises formats it
 * has partnered on, the block happens after the bytes are already in a local
 * commit, and the next provider to publish a key may use a format it has never
 * seen. This module is the check that runs before the write instead of after
 * the push.
 *
 * Pure by construction. No filesystem, no process, no network, no clock. It
 * imports nothing at all: the only input is the response bytes.
 *
 * NOTHING IN HERE EVER RETURNS THE MATCHED TEXT. A finding travels into a log
 * line, into `meta/status.json` and into a report, all three of which are
 * committed to the same public repository the gate exists to protect. A
 * scanner that quotes the secret in its own finding has moved the secret
 * rather than stopped it. Findings carry the pattern's name, how many times it
 * matched, and the byte offset of the first match, which is everything an
 * operator needs to go and look at the source themselves.
 */

/** What one credential pattern found. Never what it matched. */
export type SecretFinding = {
  /** The pattern's name, which is safe to log. */
  pattern: string;
  /** How many matches cleared both floors. */
  count: number;
  /** Byte offset of the first qualifying match in the decoded body. */
  firstOffset: number;
};

type CredentialPattern = {
  name: string;
  /**
   * Group 1 must be the high entropy part, not the prefix. The floors below
   * are measured against group 1, so including a fixed prefix like `xai-` in
   * it would credit the pattern with four characters of entropy that every
   * match shares.
   */
  re: RegExp;
  /** Shortest group 1 that can be a credential of this kind. */
  minLength: number;
  /** Shannon entropy floor over group 1, in bits per character. */
  minEntropyBits: number;
};

/**
 * Shannon entropy of a string, in bits per character.
 *
 * This is the floor that separates a credential from prose, and without it
 * every prefix here is a disaster. Measured on the live `docs.x.ai/llms.txt`
 * that started this: `xai-console-or-through-api` and
 * `xai-realtime-client-secret-abc123` are a hyphen-joined sentence fragment
 * and a documentation example, and they sit at 3.70 and 3.69 bits. The real
 * credential in the same file is 80 characters at 5.05 bits. A prefix match
 * alone would have flagged all five and taught an operator to ignore the gate.
 *
 * Note the ceiling: an n character string cannot exceed log2(n) bits, so a
 * 16 character AWS key id tops out at 4.0 however random it is. That is why
 * the floors are per pattern rather than one global number.
 */
export function shannonBits(s: string): number {
  // No `s.length === 0` guard. It was measured DEAD: an empty string never
  // enters either loop, so `bits` is still 0 at the return and the division
  // that would need guarding never runs. A guard that cannot fire is worse
  // than none, because it is the line a reader trusts.
  const counts = new Map<string, number>();
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    counts.set(ch, (counts.get(ch) ?? 0) + 1);
  }
  let bits = 0;
  for (const n of counts.values()) {
    const p = n / s.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

/**
 * The patterns, each one a format somebody actually issues.
 *
 * High signal only. This is a write gate on a live archive, so a pattern that
 * fires on ordinary documentation takes a healthy source dark until a human
 * clears it, and a gate that cries wolf gets switched off. Every floor below
 * is a measured number rather than a guess, and the measurements are in the
 * comments.
 */
const CREDENTIAL_PATTERNS: CredentialPattern[] = [
  {
    // xAI API key. `xai-` then 80 characters. The one that fired: three
    // occurrences at 80 characters and 5.05 bits in xAI's own llms.txt.
    name: 'xai-api-key',
    re: /xai-([A-Za-z0-9_-]{24,})/g,
    minLength: 40,
    minEntropyBits: 4.0,
  },
  {
    // Anthropic API key. `sk-ant-` then a long base64url-ish body.
    name: 'anthropic-api-key',
    re: /sk-ant-([A-Za-z0-9_-]{24,})/g,
    minLength: 40,
    minEntropyBits: 4.0,
  },
  {
    // OpenAI-style key: `sk-` then 32 or more characters, including the
    // `sk-proj-` project form. The negative lookahead keeps an Anthropic key
    // from being counted twice under two names, which would make a finding's
    // count a lie about how many credentials are in the body.
    name: 'openai-api-key',
    re: /\bsk-(?!ant-)([A-Za-z0-9_-]{32,})/g,
    minLength: 32,
    minEntropyBits: 4.0,
  },
  {
    // AWS access key id. `AKIA` then 16 uppercase alphanumerics.
    //
    // The floor is 3.4 rather than 4.0 and that is deliberate, because 16
    // characters cannot carry more than 4.0 bits at all: a real random key id
    // measures about 3.75, and AWS's own canonical example key measures 3.63,
    // so no floor separates them. Holding is the safe direction. It is also
    // the right answer more often than it looks: the only AKIA anywhere in
    // this repository is a real key id inside a presigned S3 URL in
    // `test/fixtures/trap-interstitial.html`, and archiving a presigned URL
    // republishes a working seven day access grant, not just an identifier.
    name: 'aws-access-key-id',
    re: /\bAKIA([A-Z0-9]{16})\b/g,
    minLength: 16,
    minEntropyBits: 3.4,
  },
  {
    // GitHub tokens: `ghp_` personal, `gho_` OAuth, `github_pat_` fine grained.
    name: 'github-token',
    re: /\b(?:ghp_|gho_|github_pat_)([A-Za-z0-9_]{30,})/g,
    minLength: 30,
    minEntropyBits: 4.0,
  },
  {
    // Google API key. `AIza` then exactly 35 characters.
    name: 'google-api-key',
    re: /\bAIza([A-Za-z0-9_-]{35})\b/g,
    minLength: 35,
    minEntropyBits: 4.0,
  },
  {
    // Slack bot and user tokens. Digit heavy, so the entropy floor is lower:
    // `xoxb-` bodies are two long numeric team and app ids joined to a
    // base62 secret, and a numeric run drags the per character entropy down
    // without making the token any less of a credential.
    name: 'slack-token',
    re: /\bxox[bp]-([A-Za-z0-9-]{24,})/g,
    minLength: 24,
    minEntropyBits: 3.4,
  },
  {
    // GitLab personal access token. `glpat-` then 20 characters, which tops
    // out at 4.32 bits, so the floor sits below a random body's typical 4.0.
    name: 'gitlab-pat',
    re: /\bglpat-([A-Za-z0-9_-]{18,})/g,
    minLength: 18,
    minEntropyBits: 3.6,
  },
  {
    // The catch-all, and the reason the gate is not just a list of prefixes.
    // A provider who invents their own key format still writes it into a
    // config example beside a key named `apiKey`, `api_key` or `api-key`, and
    // that is exactly the shape the xAI credential arrived in. Case
    // insensitive because the live occurrence was camelCase `"apiKey"`, which
    // a case sensitive `api[_-]?key` misses entirely.
    name: 'generic-api-key-assignment',
    re: /"api[_-]?key"\s*:\s*"([A-Za-z0-9_-]{24,})"/gi,
    minLength: 24,
    minEntropyBits: 4.0,
  },
];

/** The names of the patterns this module checks, in the order it checks them. */
export const CREDENTIAL_PATTERN_NAMES: string[] = CREDENTIAL_PATTERNS.map((p) => p.name);

/**
 * Byte offset of a character index, for a body that may not be all ASCII.
 *
 * The credential alphabets here are ASCII, but the bytes AROUND a match need
 * not be, and a character index reported as a byte offset would send an
 * operator to the wrong place in a file with any multi-byte content above the
 * match. Computed only for the first qualifying match of a pattern, so the
 * re-encode happens at most once per finding rather than once per match.
 */
function byteOffsetOf(text: string, charIndex: number): number {
  return new TextEncoder().encode(text.slice(0, charIndex)).length;
}

/**
 * Every credential pattern that matched, with how many times and where.
 *
 * Returns an empty array for a clean body, which is the ordinary case. The
 * order is the declaration order of the patterns, so a finding list is stable
 * across runs and a status file does not churn on ordering alone.
 */
export function scanForSecrets(body: Uint8Array): SecretFinding[] {
  const text = new TextDecoder('utf-8', { fatal: false }).decode(body);
  const found: SecretFinding[] = [];

  for (const p of CREDENTIAL_PATTERNS) {
    let count = 0;
    let firstCharIndex = -1;

    for (const m of text.matchAll(p.re)) {
      const token = m[1]!;
      // Both floors, and both are load bearing. Length alone passes a long
      // hyphenated sentence; entropy alone passes a short random-looking
      // acronym.
      if (token.length < p.minLength) continue;
      if (shannonBits(token) < p.minEntropyBits) continue;
      count++;
      if (firstCharIndex === -1) firstCharIndex = m.index;
    }

    if (count > 0) {
      found.push({ pattern: p.name, count, firstOffset: byteOffsetOf(text, firstCharIndex) });
    }
  }

  return found;
}

/**
 * The same verdict shape the magnitude guard returns, so the run applies both
 * through one branch.
 *
 * A hit is NOT a source failure. The source is healthy, the fetch worked, the
 * predicate saw a real change: the provider published their own secret. So the
 * run withholds one write, records the hold, and exits zero, exactly as it
 * does for a magnitude hold. Counting it as a failure would eventually exit
 * the job non-zero and mail an operator about a source that is working
 * perfectly, and the thing that actually needs doing is telling the provider.
 */
export type SecretVerdict = { held: false } | { held: true; reason: string; findings: SecretFinding[] };

/**
 * The reason string is assembled from names, counts and offsets and from
 * nothing else. It is written into `meta/status.json` and committed, so a
 * reason that quoted the match would archive the credential through the very
 * gate that stopped it.
 */
export function secretVerdict(body: Uint8Array): SecretVerdict {
  const findings = scanForSecrets(body);
  if (findings.length === 0) return { held: false };

  const detail = findings.map((f) => `${f.pattern} x${f.count} at byte ${f.firstOffset}`).join(', ');
  return { held: true, reason: `credential gate: ${detail}`, findings };
}
