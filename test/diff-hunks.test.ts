import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildReviewSpots, parseUnifiedDiff } from '../src/diff_hunks';

describe('parseUnifiedDiff', () => {
  it('maps additions and deletions to working-file lines', () => {
    const patch = `diff --git a/a.txt b/a.txt
--- a/a.txt
+++ b/a.txt
@@ -1,3 +1,4 @@
 line1
-line2
+line2b
+line3
 line4
`;
    const hunks = parseUnifiedDiff(patch);
    assert.equal(hunks.length, 1);
    assert.equal(hunks[0].line, 0);
    assert.ok(hunks[0].added.some((a) => a.start <= 1 && a.end >= 1));
    assert.ok(hunks[0].deletedBefore.length >= 1);
  });

  it('buildReviewSpots walks files in order', () => {
    const spots = buildReviewSpots([
      {
        relPath: 'a.ts',
        hunks: [
          { line: 2, endLine: 4, added: [], deletedBefore: [], oldStart: 1, newStart: 3 },
          { line: 10, endLine: 12, added: [], deletedBefore: [], oldStart: 9, newStart: 11 },
        ],
      },
      {
        relPath: 'b.ts',
        hunks: [{ line: 0, endLine: 0, added: [], deletedBefore: [], oldStart: 1, newStart: 1 }],
      },
    ]);
    assert.equal(spots.length, 3);
    assert.equal(spots[0].relPath, 'a.ts');
    assert.equal(spots[0].hunkIndex, 0);
    assert.equal(spots[2].relPath, 'b.ts');
  });
});
