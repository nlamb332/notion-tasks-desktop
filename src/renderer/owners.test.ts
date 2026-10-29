import { describe, expect, it } from 'vitest';
import type { SourceConfig, Task } from '../shared/types';
import { autoMapping, filterTasks, ownerFilterKey, ownerFilterOptions } from './utils';

const plain: SourceConfig = { id: 'plain', databaseId: 'db', name: 'Notion', properties: [], mapping: { title: 'name', due: null, status: 'state', complete: 'done', reopen: 'open' } };
const mapped: SourceConfig = { ...plain, id: 'owned', name: 'Plane', provider: 'plane', baseUrl: 'https://plane.example/api/v1', mapping: { ...plain.mapping, owner: 'assignees' }, properties: [{ id: 'assignees', name: 'Assignees', type: 'people' }] };
const makeTask = (id: string, sourceId: string, owners?: Task['owners']): Task => ({ id, sourceId, name: id, url: '', status: 'Open', completed: false, due: null, lastEdited: '', ...(owners ? { owners } : {}) });
const tasks = [makeTask('no-owner-field', 'plain'), makeTask('mine', 'owned', [{ id: 'noah', name: 'noah.lamb' }]), makeTask('other', 'owned', [{ id: 'other', name: 'Other' }]), makeTask('unassigned', 'owned', []), makeTask('shared', 'owned', [{ id: 'noah', name: 'noah.lamb' }, { id: 'other', name: 'Other' }])];
const filters = { sourceId: '', status: '', important: false, from: '', to: '' };

describe('owner filters', () => {
  it('keeps sources without an owner mapping while matching any assigned owner', () => {
    const result = filterTasks(tasks, 'all', [], { ...filters, owner: ownerFilterKey('noah', mapped) }, '', [plain, mapped]);
    expect(result.map(task => task.id).sort()).toEqual(['mine', 'no-owner-field', 'shared']);
  });
  it('shows every task with All owners and preserves other filters', () => {
    expect(filterTasks(tasks, 'all', [], filters, '', [plain, mapped])).toHaveLength(5);
    expect(filterTasks(tasks, 'all', [], { ...filters, sourceId: 'owned', owner: ownerFilterKey('noah', mapped) }, '', [plain, mapped])).toHaveLength(2);
    expect(filterTasks(tasks, 'all', [], { ...filters, owner: ownerFilterKey('noah', mapped) }, 'other', [plain, mapped])).toHaveLength(0);
  });
  it('scopes owner identities by provider and server', () => {
    expect(ownerFilterKey('noah', plain)).not.toBe(ownerFilterKey('noah', mapped));
    expect(ownerFilterKey('noah', { ...mapped, baseUrl: 'https://other.example/api/v1' })).not.toBe(ownerFilterKey('noah', mapped));
  });
  it('deduplicates multi-owner options and discovers optional people mappings', () => {
    expect(ownerFilterOptions(tasks, [plain, mapped]).map(option => option.label)).toEqual(['noah.lamb', 'Other']);
    expect(autoMapping(mapped).owner).toBe('assignees');
    expect(autoMapping(plain).owner).toBeNull();
  });
});
