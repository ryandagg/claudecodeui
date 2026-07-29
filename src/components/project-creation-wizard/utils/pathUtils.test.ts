import assert from 'node:assert/strict';
import test from 'node:test';

import {
  getSuggestionRootPath,
  isCloneWorkflow,
  isSshGitUrl,
  shouldShowGithubAuthentication,
} from './pathUtils';

test('isSshGitUrl recognizes scp-style and ssh:// URLs', () => {
  assert.equal(isSshGitUrl('git@github.com:owner/repo.git'), true);
  assert.equal(isSshGitUrl('  ssh://git@host/repo.git  '), true);
  assert.equal(isSshGitUrl('https://github.com/owner/repo.git'), false);
  assert.equal(isSshGitUrl(''), false);
});

test('shouldShowGithubAuthentication is true only for non-empty non-SSH URLs', () => {
  assert.equal(shouldShowGithubAuthentication('https://github.com/o/r.git'), true);
  assert.equal(shouldShowGithubAuthentication('git@github.com:o/r.git'), false);
  assert.equal(shouldShowGithubAuthentication('   '), false);
});

test('isCloneWorkflow is true whenever a URL is provided', () => {
  assert.equal(isCloneWorkflow('https://github.com/o/r.git'), true);
  assert.equal(isCloneWorkflow('   '), false);
});

test('getSuggestionRootPath returns the parent directory', () => {
  assert.equal(getSuggestionRootPath('/home/user/projects/app'), '/home/user/projects');
  assert.equal(getSuggestionRootPath('/home/user/projects/'), '/home/user/projects');
});

test('getSuggestionRootPath handles a Windows drive root specially', () => {
  assert.equal(getSuggestionRootPath('C:\\app'), 'C:\\');
  assert.equal(getSuggestionRootPath('C:\\Users\\me\\app'), 'C:\\Users\\me');
});

test('getSuggestionRootPath falls back to ~ when there is no parent segment', () => {
  assert.equal(getSuggestionRootPath('app'), '~');
  assert.equal(getSuggestionRootPath(''), '~');
});
