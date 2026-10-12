const { _electron: electron } = require('playwright');
const fs = require('node:fs/promises'), path = require('node:path'), assert = require('node:assert/strict');
const { Store } = require('../src/core/store.cjs');
const { importSkin, builtins } = require('../src/core/skins.cjs');
const root = path.resolve(__dirname, '..');

(async () => {
  await fs.mkdir(path.join(root, '.cache'), { recursive: true });
  const folder = await fs.mkdtemp(path.join(root, '.cache/skins-ui-')), data = path.join(folder, 'data');
  const store = new Store(data);
  const custom = await importSkin(store, path.join(root, 'assets/white-dragon/skin.json'));
  store.update(s => {
    s.settings.language = 'zh-CN';
    s.settings.codexPath = path.join(folder, 'missing-codex.exe');
    s.settings.skins = { codex: 'white-dragon', claude: custom.id };
  });
  for (const agent of ['codex', 'claude']) await fs.writeFile(path.join(data, `release-${agent}.json`), JSON.stringify({ agent, version: '0.0.0', body: 'Fixture', url: `https://github.com/${agent === 'codex' ? 'openai/codex' : 'anthropics/claude-code'}/releases/tag/v0.0.0`, checkedAt: Date.now() }));
  const packaged = Boolean(process.env.DESKMATE_TEST_EXE);
  const output = path.join(root, 'test-output/v5', packaged ? 'packaged' : 'source');
  await fs.mkdir(output, { recursive: true });
  const env = { ...process.env, DESKMATE_DATA_DIR: data, CLAUDE_CONFIG_DIR: path.join(folder, 'claude') }; delete env.ELECTRON_RUN_AS_NODE;
  let app, page, pet; const errors = [];
  const launch = async () => {
    app = await electron.launch({ args: packaged ? [] : [root], executablePath: process.env.DESKMATE_TEST_EXE || undefined, env });
    app.on('window', w => w.on('pageerror', e => errors.push(e.message)));
    for (let i = 0; i < 100; i++) {
      page = app.windows().find(w => w.url().endsWith('/index.html'));
      pet = app.windows().find(w => w.url().endsWith('/pet.html'));
      if (page && pet) break;
      await new Promise(r => setTimeout(r, 50));
    }
    await page.locator('#agent-select').waitFor();
  };
  const state = () => page.evaluate(() => window.assistant.call('state'));
  const currentPet = async skin => {
    await pet.waitForFunction(id => document.getElementById('character').src.includes('/' + id + '/'), skin);
    await pet.locator('#character').evaluate(img => img.decode());
    assert.equal(await pet.locator('#character').evaluate(img => img.naturalWidth > 0 && img.naturalHeight > 0), true);
  };
  const switchAgent = async agent => {
    await page.locator('nav [data-page=usage]').click();
    await page.locator('#agent-select').selectOption(agent);
    await page.waitForFunction(agent => document.getElementById('agent-select').value === agent, agent);
    await page.locator('.settings-nav').click();
  };
  try {
    await launch();
    assert.equal((await state()).packaged, packaged);
    await currentPet('white-dragon');
    await switchAgent('claude'); await currentPet(custom.id);
    assert.equal((await state()).settings.skins.claude, custom.id, 'existing imported binding survives upgrade');
    await switchAgent('codex'); await currentPet('white-dragon');
    assert.equal(await page.locator('.skin-card').count(), 9, 'eight built-ins plus previous import');
    const assets = (await state()).skins.filter(s => builtins.some(b => b.id === s.id));
    let decoded = 0;
    for (const skin of assets) {
      for (const src of Object.values(skin.states)) {
        await page.evaluate(async src => { const img = new Image(); img.src = src; await img.decode(); if (!img.naturalWidth || !img.naturalHeight) throw Error('Empty image: ' + src); }, src);
        decoded++;
      }
      await page.locator(`[data-skin="${skin.id}"]`).click(); await currentPet(skin.id);
      assert.equal((await state()).settings.skins.codex, skin.id);
      assert.equal((await state()).settings.skins.claude, custom.id, 'selection does not overwrite other agent');
      assert.equal(await page.locator('.skin-card.selected').count(), 1);
    }
    for (const lang of ['zh-CN', 'en', 'ja']) {
      await page.locator('#language-select').selectOption(lang);
      await pet.waitForFunction(lang => document.documentElement.lang === lang, lang);
      for (const skin of builtins) assert.equal(await page.locator(`[data-skin="${skin.id}"] img`).getAttribute('alt'), skin.names[lang]);
      assert.equal(await page.locator(`[data-skin="${custom.id}"] img`).getAttribute('alt'), custom.name, 'custom names are preserved');
      assert.equal(await page.locator('main').evaluate(el => el.scrollWidth <= el.clientWidth + 1), true);
      await page.locator('.skin-grid').screenshot({ path: path.join(output, `characters-${lang}.png`) });
    }
    await page.locator('[data-skin="star-cat"]').click(); await currentPet('star-cat');
    await switchAgent('claude'); await page.locator('[data-skin="orange-scholar"]').click(); await currentPet('orange-scholar');
    await pet.screenshot({ path: path.join(output, 'claude-pet.png'), omitBackground: true });
    await switchAgent('codex'); await currentPet('star-cat');
    await app.close(); await launch(); await currentPet('star-cat');
    const reloaded = await state();
    assert.deepEqual(reloaded.settings.skins, { codex: 'star-cat', claude: 'orange-scholar' });
    assert.equal(reloaded.settings.language, 'ja');
    assert.equal(reloaded.skins.filter(s => s.id === custom.id).length, 1);
    await switchAgent('claude'); await currentPet('orange-scholar');
    assert.deepEqual(errors, []);
    const result = { version: require('../package.json').version, packaged, characters: assets.length, animationsDecoded: decoded, languages: ['zh-CN', 'en', 'ja'], existingImportPreserved: true, perAgentBindingsPersisted: true, rendererErrors: errors };
    await fs.writeFile(path.join(output, 'skins-result.json'), JSON.stringify(result, null, 2) + '\n');
    console.log(JSON.stringify(result, null, 2));
  } finally { if (app) await app.close().catch(() => {}); }
})().catch(e => { console.error(e); process.exitCode = 1; });
