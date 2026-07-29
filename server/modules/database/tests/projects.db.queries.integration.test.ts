import assert from 'node:assert/strict';
import test from 'node:test';

import { projectsDb } from '@/modules/database/repositories/projects.db.js';

import { withIsolatedDatabase } from './helpers.js';

// Complements projects.db.integration.test.ts (which covers createProjectPath
// outcomes) by exercising the by-path / by-id lookups and mutations.

test('getProjectPath / getProjectById / getProjectPathById resolve a created project', async () => {
  await withIsolatedDatabase('projects-queries-db', () => {
    const { project } = projectsDb.createProjectPath('/workspace/demo', 'Demo');
    const projectId = project!.project_id;

    assert.equal(projectsDb.getProjectPath('/workspace/demo')?.project_id, projectId);
    assert.equal(projectsDb.getProjectById(projectId)?.project_path, '/workspace/demo');
    assert.equal(projectsDb.getProjectPathById(projectId), '/workspace/demo');

    // Misses return null rather than throwing.
    assert.equal(projectsDb.getProjectPath('/workspace/missing'), null);
    assert.equal(projectsDb.getProjectById('no-such-id'), null);
    assert.equal(projectsDb.getProjectPathById('no-such-id'), null);
  });
});

test('getProjectPaths and getArchivedProjectPaths partition on the archived flag', async () => {
  await withIsolatedDatabase('projects-queries-db', () => {
    projectsDb.createProjectPath('/workspace/active');
    projectsDb.createProjectPath('/workspace/archived');
    projectsDb.updateProjectIsArchived('/workspace/archived', true);

    assert.deepEqual(
      projectsDb.getProjectPaths().map((p) => p.project_path),
      ['/workspace/active'],
    );
    assert.deepEqual(
      projectsDb.getArchivedProjectPaths().map((p) => p.project_path),
      ['/workspace/archived'],
    );
  });
});

test('custom project name can be read, set by path (upsert), and set by id', async () => {
  await withIsolatedDatabase('projects-queries-db', () => {
    const { project } = projectsDb.createProjectPath('/workspace/named', 'Original');
    const projectId = project!.project_id;
    assert.equal(projectsDb.getCustomProjectName('/workspace/named'), 'Original');

    projectsDb.updateCustomProjectName('/workspace/named', 'Renamed');
    assert.equal(projectsDb.getCustomProjectName('/workspace/named'), 'Renamed');

    projectsDb.updateCustomProjectNameById(projectId, 'RenamedById');
    assert.equal(projectsDb.getProjectById(projectId)?.custom_project_name, 'RenamedById');
  });
});

test('updateCustomProjectName inserts a fresh row for an unknown path', async () => {
  await withIsolatedDatabase('projects-queries-db', () => {
    // The upsert path also handles the insert branch when no row exists yet.
    projectsDb.updateCustomProjectName('/workspace/brand-new', 'Fresh');
    assert.equal(projectsDb.getCustomProjectName('/workspace/brand-new'), 'Fresh');
    assert.ok(projectsDb.getProjectPath('/workspace/brand-new'));
  });
});

test('starred flag toggles by path and by id', async () => {
  await withIsolatedDatabase('projects-queries-db', () => {
    const { project } = projectsDb.createProjectPath('/workspace/star');
    const projectId = project!.project_id;
    assert.equal(projectsDb.getProjectById(projectId)?.isStarred, 0);

    projectsDb.updateProjectIsStarred('/workspace/star', true);
    assert.equal(projectsDb.getProjectById(projectId)?.isStarred, 1);

    projectsDb.updateProjectIsStarredById(projectId, false);
    assert.equal(projectsDb.getProjectById(projectId)?.isStarred, 0);
  });
});

test('archived flag toggles by id as well as by path', async () => {
  await withIsolatedDatabase('projects-queries-db', () => {
    const { project } = projectsDb.createProjectPath('/workspace/arch');
    const projectId = project!.project_id;

    projectsDb.updateProjectIsArchivedById(projectId, true);
    assert.equal(projectsDb.getProjectById(projectId)?.isArchived, 1);
    assert.equal(projectsDb.getProjectPaths().length, 0);
  });
});

test('deleteProjectPath and deleteProjectById remove the row', async () => {
  await withIsolatedDatabase('projects-queries-db', () => {
    projectsDb.createProjectPath('/workspace/by-path');
    const { project } = projectsDb.createProjectPath('/workspace/by-id');
    const projectId = project!.project_id;

    projectsDb.deleteProjectPath('/workspace/by-path');
    assert.equal(projectsDb.getProjectPath('/workspace/by-path'), null);

    projectsDb.deleteProjectById(projectId);
    assert.equal(projectsDb.getProjectById(projectId), null);
  });
});
