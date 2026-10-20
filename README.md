# directory-entry-deduplicator

Detects and merges directory entries that differ only in Unicode normalization form, as commonly seen when copying between HFS+ (which writes NFD) and APFS (which preserves bytes) volumes.

## Usage

```js
import assert from 'node:assert/strict';
import { planDeduplication, groupByCanonicalName, canonicallyEqual } from 'directory-entry-deduplicator';

// entries as you might read them from a directory listing
const entries = [
  { name: 'caf\u00E9.txt', size: 1024, mtime: 1_700_000_000_000 },
  { name: 'cafe\u0301.txt', size: 1024, mtime: 1_700_000_001_000 },
  { name: 'readme.md', size: 64 },
];

// groups of entries whose names are canonically equivalent under NFC
const groups = groupByCanonicalName(entries);

// full merge plan; clock is injectable so tests stay deterministic
const plan = planDeduplication(entries, { clock: () => Date.now() });
console.log(plan);
// -> [{ name: 'caf\u00E9.txt', size: 1024, mtime: 1_700_000_000_000, sourceNames: [...] }]

// quick logical-name check
assert.ok(canonicallyEqual('caf\u00E9', 'cafe\u0301'));
```

## Why

HFS+ forcibly normalizes filenames to NFD on write; APFS preserves the exact bytes you hand it. A directory copied from an HFS+ volume onto APFS can therefore contain two entries that the filesystem treats as distinct but that a person or downstream tool almost always considers the same file. This library identifies those collisions and produces a deterministic merge plan so a sync or backup tool can reconcile them instead of silently duplicating data or dropping one side.

The trade-off: we compare using NFC only, not NFKC. NFC catches every case arising from HFS+/APFS byte differences; NFKC would additionally fold compatibility characters like fullwidth Latin letters to their ASCII counterparts, which would merge names that are genuinely distinct identifiers. We consider that over-merging worse than leaving a pair alone.

## Edge cases you will hit

- **Size disagreements.** When the variants disagree on `size`, the merge picks the majority value among the known sizes; on a tie, the first entry's size wins. If your use case needs byte-for-byte equality before merging, filter the groups yourself before calling `mergeGroup`.
- **`mtime` resolution depends on a clock.** `mergeGroup` accepts `opts.clock`, a function returning a millisecond timestamp, and selects the entry whose `mtime` is closest to `clock.now()` (ties go to the earlier entry in the group). If you omit the clock, the first entry with a known `mtime` wins. Inject a fake clock in tests; never rely on wall time.
- **Unfamiliar fields.** Any property other than `name`, `size`, and `mtime` is copied from the first entry in the group that defines it. There is no field-specific conflict resolution; post-process the result if you need more.
- **Empty or non-equivalent groups.** `mergeGroup` throws `MergeConflict` if handed an empty array or a group whose names are not all canonically equivalent. Feed it only the output of `groupByCanonicalName`.

## Exports

- `canonicallyEqual(a, b)` — `boolean`, true iff `a` and `b` have the same NFC form.
- `groupByCanonicalName(entries)` — `Array<Array<Entry>>`, groups of size ≥ 2.
- `mergeGroup(group, opts?)` — merged entry; throws `MergeConflict` on bad input.
- `planDeduplication(entries, opts?)` — `Array` of merged entries, one per duplicate group.
- `MergeConflict` — `Error` subclass thrown by `mergeGroup`.

An `Entry` is any object with a string `name`; optional `size` (number) and `mtime` (number, milliseconds) are recognized by `mergeGroup`.
