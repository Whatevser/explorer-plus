import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const settingsFile = new URL('../js/core/settings.js', import.meta.url);

function setup({ shellTheme = null, osDark = false, settingsOnDisk, legacySettings, storageBlocked = false } = {}) {
    const storage = new Map([['shell:style', shellTheme], ['explorer:settings', legacySettings]]);
    const document = { documentElement: { setAttribute: (_, value) => { document.theme = value; } } };
    const media = { matches: osDark, addEventListener: (_, fn) => { media.onChange = fn; } };
    const localStorage = {
        getItem(key) {
            if (storageBlocked) throw new Error('Storage unavailable');
            return storage.get(key);
        },
        removeItem: key => storage.delete(key),
    };
    const writes = [];
    const sandbox = {
        document, localStorage, structuredClone,
        matchMedia: () => media,
        addEventListener: (_, fn) => { sandbox.onStorage = fn; },
        FS: {
            readText: async () => settingsOnDisk,
            mkdir: async () => {},
            writeText: async (path, content) => { writes.push([path, JSON.parse(content)]); },
        },
        Util: { dirname: path => path.slice(0, path.lastIndexOf('/')) },
        jsyaml: { load: JSON.parse, dump: JSON.stringify },
        ExRT: { const: { LS_KEY_SETTINGS: 'explorer:settings', DEFAULT_SETTINGS: { columns: { size: true } } } },
    };
    sandbox.window = sandbox;
    const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
    const bootstrap = html.match(/<script>\s*(window\.explorerSystemTheme = [\s\S]+?)<\/script>/);
    assert.ok(bootstrap && bootstrap.index < html.indexOf('<link rel="stylesheet"'));
    vm.createContext(sandbox);
    vm.runInContext(bootstrap[1], sandbox);
    vm.runInContext(fs.readFileSync(settingsFile, 'utf8'), sandbox, { filename: settingsFile.pathname });
    const app = { ...sandbox.ExplorerSettings, homePath: '/home/demo', settings: { theme: 'system' } };
    return { app, document, sandbox, storage, media, writes };
}

test('first paint and the loaded theme follow Cockpit, then the OS', async () => {
    for (const [shellTheme, osDark, expected] of [
        ['dark', false, 'dark'], ['light', true, 'light'], ['auto', true, 'dark'], [null, false, 'light'],
    ]) {
        const { app, document } = setup({ shellTheme, osDark });
        assert.equal(document.theme, expected);
        await app._loadSettings();
        assert.equal(document.theme, expected);
    }
    const { app, document } = setup({ osDark: true, storageBlocked: true });
    assert.equal(document.theme, 'dark');
    await app._loadSettings();
    assert.equal(document.theme, 'dark');
});

test('only the default theme tracks Cockpit and OS appearance changes', async () => {
    const { app, document, sandbox, media, storage } = setup({
        shellTheme: 'dark', settingsOnDisk: '{"theme":"light","updateCheckOnStart":true}',
    });
    assert.equal(document.theme, 'dark');
    await app._loadSettings();
    assert.equal(document.theme, 'light');
    assert.equal('updateCheckOnStart' in app.settings, false);
    storage.set('shell:style', 'auto');
    media.matches = true;
    sandbox.onStorage({ key: 'shell:style' });
    media.onChange();
    assert.equal(document.theme, 'light');

    const editorThemes = [];
    sandbox.monaco = { editor: { setTheme: theme => editorThemes.push(theme) } };
    delete app.settings.theme;
    media.onChange();
    assert.equal(document.theme, 'dark');
    storage.set('shell:style', 'light');
    sandbox.onStorage({ key: 'unrelated' });
    assert.equal(document.theme, 'dark');
    sandbox.onStorage({ key: 'shell:style' });
    assert.equal(document.theme, 'light');
    assert.deepEqual(editorThemes, ['vs-dark', 'vs']);
});

test('legacy settings migration drops updater options and preserves other preferences', async () => {
    const { app, document, storage, writes } = setup({
        settingsOnDisk: 'invalid YAML',
        legacySettings: '{"theme":"dark","updateRepo":"old/repo","updateCheckOnStart":true,"columns":{"owner":true}}',
    });
    await app._loadSettings();
    assert.equal(document.theme, 'dark');
    assert.deepEqual({ ...app.settings.columns }, { size: true, owner: true });
    assert.deepEqual(writes, [['/home/demo/.config/cockpit/explorer/settings.yml', { theme: 'dark', columns: { owner: true } }]]);
    assert.equal(storage.has('explorer:settings'), false);
});
