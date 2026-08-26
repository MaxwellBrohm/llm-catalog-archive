import { describe, it, expect } from 'vitest';
import fs from 'node:fs';

describe('scaffold', () => {
  it('marks raw and backfill as binary so git never rewrites stored bytes', () => {
    const attrs = fs.readFileSync('.gitattributes', 'utf8');
    expect(attrs).toContain('raw/** -text -diff=auto');
    expect(attrs).toContain('backfill/** -text -diff=auto');
  });

  it('ships both append-only ledgers, empty', () => {
    expect(fs.readFileSync('meta/corrections.jsonl', 'utf8')).toBe('');
    expect(fs.readFileSync('meta/retractions.jsonl', 'utf8')).toBe('');
  });
});
