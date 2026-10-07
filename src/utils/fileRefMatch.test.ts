import assert from 'node:assert/strict';
import test from 'node:test';

import {
  findBestMatch,
  flattenFileTree,
  isOpenableFileRef,
  type FileTreeNode,
  type FlatFile,
} from './fileRefMatch';

const tree: FileTreeNode[] = [
  {
    type: 'directory',
    name: 'src',
    path: 'src',
    children: [
      { type: 'file', name: 'index.ts', path: 'src/index.ts' },
      {
        type: 'directory',
        name: 'utils',
        path: 'src/utils',
        children: [{ type: 'file', name: 'foo.ts', path: 'src/utils/foo.ts' }],
      },
    ],
  },
  { type: 'file', name: 'README.md', path: 'README.md' },
  { type: 'directory', name: 'empty', path: 'empty', children: [] },
];

const files: FlatFile[] = flattenFileTree(tree);

// ---------------------------------------------------------------------------
// flattenFileTree
// ---------------------------------------------------------------------------
test('flattenFileTree returns only files, recursing through directories', () => {
  assert.deepEqual(
    files.map((f) => f.path).sort(),
    ['README.md', 'src/index.ts', 'src/utils/foo.ts'],
  );
});

// ---------------------------------------------------------------------------
// findBestMatch
// ---------------------------------------------------------------------------
test('findBestMatch resolves exact, partial, and basename references', () => {
  assert.equal(findBestMatch(files, 'src/utils/foo.ts'), 'src/utils/foo.ts'); // exact
  assert.equal(findBestMatch(files, 'utils/foo.ts'), 'src/utils/foo.ts'); // suffix
  assert.equal(findBestMatch(files, './src/index.ts'), 'src/index.ts'); // leading ./
  assert.equal(findBestMatch(files, 'README.md'), 'README.md'); // basename
});

test('findBestMatch normalizes Windows separators', () => {
  assert.equal(findBestMatch(files, 'src\\utils\\foo.ts'), 'src/utils/foo.ts');
});

test('findBestMatch returns null when nothing matches (the false-positive guard)', () => {
  // These are path-shaped but are NOT files — a repo#pr ref and a git branch.
  assert.equal(findBestMatch(files, 'heroku/api#18258'), null);
  assert.equal(findBestMatch(files, 'jab/core-compute-hacks'), null);
  assert.equal(findBestMatch(files, 'nope/missing.ts'), null);
  assert.equal(findBestMatch(files, ''), null);
});

// ---------------------------------------------------------------------------
// isOpenableFileRef
// ---------------------------------------------------------------------------
const resolve = (ref: string) => findBestMatch(files, ref);

test('isOpenableFileRef links real project files, including with a line suffix', () => {
  assert.equal(isOpenableFileRef('src/utils/foo.ts', resolve), true);
  assert.equal(isOpenableFileRef('utils/foo.ts:42', resolve), true); // suffix stripped before resolving
  assert.equal(isOpenableFileRef('src/utils/foo.ts:42:7', resolve), true);
});

test('isOpenableFileRef always links absolute references, even if not in the tree', () => {
  assert.equal(isOpenableFileRef('/Users/me/elsewhere/thing.ts', resolve), true);
  assert.equal(isOpenableFileRef('~/notes.md', resolve), true);
  assert.equal(isOpenableFileRef('C:\\Users\\me\\thing.ts', resolve), true);
});

test('isOpenableFileRef rejects path-shaped non-files (the reported bug)', () => {
  assert.equal(isOpenableFileRef('heroku/api#18258', resolve), false);
  assert.equal(isOpenableFileRef('heroku/applink#1080', resolve), false);
  assert.equal(isOpenableFileRef('jab/tnk-dev-allow', resolve), false);
  assert.equal(isOpenableFileRef('jab/core-compute-hacks', resolve), false);
  assert.equal(isOpenableFileRef('', resolve), false);
});

test('isOpenableFileRef treats an unloaded tree (resolver returns null) as not-a-file', () => {
  const notLoaded = () => null;
  assert.equal(isOpenableFileRef('src/utils/foo.ts', notLoaded), false);
  // ...but absolute refs still link regardless of load state.
  assert.equal(isOpenableFileRef('/abs/thing.ts', notLoaded), true);
});
