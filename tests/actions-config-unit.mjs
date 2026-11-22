import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const actionFile = new URL('../js/features/actions.js', import.meta.url);
const systemPath = '/etc/cockpit/explorer/actions.json';
const userPath = '/home/demo/.config/cockpit/explorer/actions.json';
const oldUpdater = { id: 'explorer-self-update', label: 'Old updater', appliesTo: 'archive' };
const archive = { path: '/tmp/explorer-4.4.1.zip', name: 'explorer-4.4.1.zip', type: 'f' };

test('upgrading removes the seeded updater from both action scopes and keeps custom actions', async () => {
    const inspectArchive = {
        id: 'inspect-archive', label: 'Inspect archive', appliesTo: 'archive', pattern: '\\.zip$',
        command: 'unzip -l {path}', output: 'pane', privilege: 'try', confirm: true, confirmMessage: 'List {name}?',
        preCommand: 'true', preConfirm: 'Before?', preConfirmLabel: 'Start',
        postCommand: 'true', postConfirm: 'After?', postConfirmLabel: 'Finish',
        interactive: true, script: 'inspect.sh', requiresGh: true, multi: false,
    };
    const readPaths = [];
    const sandbox = {
        window: {},
        FS: { async readText(path) {
            readPaths.push(path);
            const actions = path === systemPath
                ? [oldUpdater, inspectArchive, { appliesTo: 'global', label: 'System command' }]
                : [oldUpdater, { id: 'user-command', appliesTo: 'global', label: 'User command' },
                    { id: 'directory-action', appliesTo: 'dir' }, { id: 'symlink-action', appliesTo: 'symlink' },
                    { id: 'file-action', appliesTo: 'file', pattern: '^notes\\.txt$', output: 'pane' },
                    { id: 'file-or-dir-action', appliesTo: 'both', pattern: '^notes\\.txt$' },
                    { id: 'everything-action', pattern: '[', output: 'window' }];
            return JSON.stringify({ actions });
        } },
        ExRT: { const: { SYSTEM_ACTIONS_PATH: systemPath, USER_ACTIONS_PATH_SUFFIX: userPath.slice('/home/demo'.length) } },
        Util: { uid: () => 'generated-id', isArchive: file => file.name.endsWith('.zip') },
    };
    vm.runInNewContext(fs.readFileSync(actionFile, 'utf8'), sandbox, { filename: actionFile.pathname });
    const app = {
        ...sandbox.window.ExplorerActions,
        homePath: '/home/demo', customActions: { user: [], system: [] },
        actionsMgr: { loaded: {}, editingIdx: 0 },
        currentPane: () => ({}), selectedFiles: () => [],
        insideAnyRepoCache: () => false, toast() {},
    };

    await app.reloadActions();
    assert.deepEqual(readPaths.sort(), [systemPath, userPath]);
    assert.deepEqual(app.actionsMgr.loaded, { user: true, system: true });
    assert.deepEqual([...app.customActions.system].map(action => action.id), ['inspect-archive', 'generated-id']);
    assert.equal(app.customActions.user.length, 6);
    assert.ok(app.customActions.user.every(action => action.id !== oldUpdater.id));
    assert.deepEqual([...app.globalActions()].map(action => [action.label, action._source]), [
        ['System command', 'system'], ['User command', 'user'],
    ]);
    assert.deepEqual([...app.applicableActions(archive)].map(action => ({ ...action })), [
        { ...inspectArchive, _source: 'system' },
    ]);
    assert.equal(app.applicableActions({ ...archive, name: 'regular.txt' }).length, 0);
    assert.equal(app.applicableActions(null).length, 0);
    for (const [file, ids] of [
        [{ name: 'folder', type: 'd' }, ['directory-action']],
        [{ name: 'link', type: 'l' }, ['symlink-action']],
        [{ name: 'notes.txt', type: 'f' }, ['file-action', 'file-or-dir-action']],
    ]) {
        assert.deepEqual([...app.applicableActions(file)].map(action => action.id), ids);
    }
    app.currentPane = () => null;
    assert.equal(app.applicableActions(archive).length, 0);
    app.currentPane = () => ({});
    app.insideAnyRepoCache = () => true;
    assert.equal(app.applicableActions(archive).length, 1, 'read-only output is available inside repo caches');
    app.selectedFiles = () => [archive, { ...archive, name: 'other.zip' }];
    assert.equal(app.applicableActions(archive).length, 0, 'single-file actions keep their selection limit');
});
