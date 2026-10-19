import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MergeConflict,
  canonicallyEqual,
  groupByCanonicalName,
  mergeGroup,
  planDeduplication,
} from '../src/index.js';

/**
 * U+00E9 (NFC, single code point) and U+0065 U+0301 (NFD, base + combining
 * acute) look identical and are canonically equivalent. This pair is the
 * canonical example of the HFS+/APFS normalization mismatch.
 */
const NFC_E = '\u00E9';
const NFD_E = 'e\u0301';

test('canonicallyEqual returns true for byte-identical strings', () => {
  assert.equal(canonicallyEqual('hello', 'hello'), true);
});

test('canonicallyEqual returns true for NFC vs NFD forms of the same glyph', () => {
  assert.equal(canonicallyEqual(NFC_E, NFD_E), true);
});

test('canonicallyEqual returns false for strings that differ in meaning', () => {
  // Fullwidth 'A' (U+FF21) vs ASCII 'A' — NFKC would fold these, NFC does not.
  assert.equal(canonicallyEqual('\uFF21', 'A'), false);
});

test('canonicallyEqual returns false for clearly distinct strings', () => {
  assert.equal(canonicallyEqual('cafe', 'caf\u00E9'), false);
});

test('canonicallyEqual rejects non-string inputs without throwing', () => {
  assert.equal(canonicallyEqual(5, '5'), false);
  assert.equal(canonicallyEqual(null, 'null'), false);
  assert.equal(canonicallyEqual(undefined, undefined), false);
});

test('groupByCanonicalName groups NFC and NFD variants together', () => {
  const entries = [
    { name: 'caf\u00E9.txt', size: 10 },
    { name: 'cafe\u0301.txt', size: 10 },
  ];
  const groups = groupByCanonicalName(entries);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].length, 2);
});

test('groupByCanonicalName leaves non-colliding entries out of groups', () => {
  const entries = [
    { name: 'a.txt' },
    { name: 'b.txt' },
  ];
  const groups = groupByCanonicalName(entries);
  assert.equal(groups.length, 0);
});

test('groupByCanonicalName forms disjoint groups', () => {
  // Two separate collision sets.
  const entries = [
    { name: 'A\u0308.txt' },       // A-umlaut NFD
    { name: '\u00C4.txt' },         // A-umlaut NFC
    { name: 'o\u0308.txt' },       // o-umlaut NFD
    { name: '\u00F6.txt' },         // o-umlaut NFC
  ];
  const groups = groupByCanonicalName(entries);
  assert.equal(groups.length, 2);
  // Each group must contain exactly the two variants of its glyph.
  const groupNames = groups
    .map((g) => g.map((e) => e.name.normalize('NFC')).sort())
    .sort();
  assert.deepEqual(groupNames, [
    ['\u00C4.txt', '\u00C4.txt'],
    ['\u00F6.txt', '\u00F6.txt'],
  ]);
});

test('groupByCanonicalName throws on non-array input', () => {
  assert.throws(() => groupByCanonicalName('not an array'), TypeError);
});

test('groupByCanonicalName throws on entries missing a string name', () => {
  assert.throws(
    () => groupByCanonicalName([{ name: 123 }]),
    TypeError,
  );
});

test('mergeGroup produces an NFC-normalized name and records source names', () => {
  const merged = mergeGroup([
    { name: 'caf\u00E9.txt', size: 10 },
    { name: 'cafe\u0301.txt', size: 10 },
  ]);
  assert.equal(merged.name, 'caf\u00E9.txt');
  assert.equal(merged.name, merged.name.normalize('NFC'));
  assert.deepEqual(merged.sourceNames, ['caf\u00E9.txt', 'cafe\u0301.txt']);
  assert.equal(merged.size, 10);
});

test('mergeGroup resolves size by majority when entries disagree', () => {
  // Two say 10, one says 99 -> 10 wins.
  const merged = mergeGroup([
    { name: 'a\u0301', size: 10 },
    { name: 'a\u0301', size: 99 },
    { name: '\u00E1', size: 10 },
  ]);
  assert.equal(merged.size, 10);
});

test('mergeGroup resolves size by first-known-wins on tie', () => {
  const merged = mergeGroup([
    { name: 'a\u0301', size: 10 },
    { name: '\u00E1', size: 20 },
  ]);
  assert.equal(merged.size, 10);
});

test('mergeGroup omits size when no entry has a numeric size', () => {
  const merged = mergeGroup([
    { name: 'a\u0301' },
    { name: '\u00E1' },
  ]);
  assert.equal('size' in merged, false);
});

test('mergeGroup uses injected clock to pick the mtime closest to now', () => {
  // clock returns 1000. The two mtimes are 100 and 900; 900 is closer.
  const merged = mergeGroup(
    [
      { name: 'a\u0301', mtime: 100 },
      { name: '\u00E1', mtime: 900 },
    ],
    { clock: () => 1000 },
  );
  assert.equal(merged.mtime, 900);
});

test('mergeGroup breaks mtime ties deterministically by first-wins', () => {
  // Both mtimes equidistant from now=1000: distances 900 and 900.
  const merged = mergeGroup(
    [
      { name: 'a\u0301', mtime: 100 },
      { name: '\u00E1', mtime: 1900 },
    ],
    { clock: () => 1000 },
  );
  assert.equal(merged.mtime, 100);
});

test('mergeGroup falls back to first-known mtime when no clock is supplied', () => {
  const merged = mergeGroup([
    { name: 'a\u0301', mtime: 100 },
    { name: '\u00E1', mtime: 900 },
  ]);
  assert.equal(merged.mtime, 100);
});

test('mergeGroup copies unfamiliar fields from the first entry that defines them', () => {
  const merged = mergeGroup([
    { name: 'a\u0301', owner: 'alice' },
    { name: '\u00E1', owner: 'bob', perms: 0o644 },
  ]);
  assert.equal(merged.owner, 'alice');
  assert.equal(merged.perms, 0o644);
});

test('mergeGroup throws MergeConflict on an empty group', () => {
  assert.throws(() => mergeGroup([]), MergeConflict);
});

test('mergeGroup throws MergeConflict when group entries are not canonically equivalent', () => {
  assert.throws(
    () => mergeGroup([{ name: 'a' }, { name: 'b' }]),
    MergeConflict,
  );
});

test('mergeGroup throws MergeConflict when an entry lacks a string name', () => {
  assert.throws(() => mergeGroup([{ name: 'a' }, { name: 5 }]), MergeConflict);
});

test('mergeGroup throws TypeError when opts.clock is not a function', () => {
  assert.throws(
    () => mergeGroup([{ name: 'a\u0301' }, { name: '\u00E1' }], { clock: 'nope' }),
    TypeError,
  );
});

test('planDeduplication returns one merged entry per duplicate group and leaves singles alone', () => {
  const entries = [
    { name: 'caf\u00E9.txt', size: 10 },
    { name: 'cafe\u0301.txt', size: 10 },
    { name: 'readme.md', size: 5 },
  ];
  const plan = planDeduplication(entries);
  assert.equal(plan.length, 1);
  assert.equal(plan[0].name, 'caf\u00E9.txt');
  assert.equal(plan[0].size, 10);
});

test('planDeduplication forwards the clock option to mergeGroup', () => {
  const entries = [
    { name: 'a\u0301', mtime: 100 },
    { name: '\u00E1', mtime: 900 },
  ];
  const plan = planDeduplication(entries, { clock: () => 1000 });
  assert.equal(plan[0].mtime, 900);
});

test('planDeduplication returns an empty array when there are no duplicates', () => {
  assert.deepEqual(planDeduplication([{ name: 'a' }, { name: 'b' }]), []);
});

test('MergeConflict is an Error subclass', () => {
  const e = new MergeConflict('boom');
  assert.ok(e instanceof Error);
  assert.equal(e.message, 'boom');
  assert.equal(e.name, 'MergeConflict');
});

test('a combined NFC+NFD pair with CJK tone marks is recognized as a single group', () => {
  // U+01D4 (NFC 'ǔ') vs 'u' + U+030C (combining caron, NFD).
  const entries = [
    { name: '\u01D4.txt' },
    { name: 'u\u030C.txt' },
  ];
  const groups = groupByCanonicalName(entries);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].length, 2);
});
