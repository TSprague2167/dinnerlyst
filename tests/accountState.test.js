import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { transformSync } from 'rolldown/experimental'
import * as account from '../src/accountState.js'
import * as shopping from '../src/shoppingList.js'
import * as ingredients from '../src/ingredients.js'
import * as pantry from '../src/pantry.js'

const recipe = (id, name = `Recipe ${id}`) => ({ id, name, ingredients: ['eggs'], instructions: '' })
const plan = id => ({ weeklyMeals: [{ day: 'Monday', meal: recipe(id) }], shoppingList: { Other: ['paper towels'] }, lockedDays: ['Monday'] })
function memoryStorage() {
  const values = new Map()
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) }
}
function deferred() {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}

test('scoped cache restores each owner independently and survives logout', () => {
  const storage = memoryStorage()
  let owner = { userId: null, generation: 0 }
  const a = owner = account.nextAccountOwner(owner, 'A')
  assert.equal(account.persistPlannerCache(storage, a, owner, plan(87)), true)
  const b = owner = account.nextAccountOwner(owner, 'B')
  assert.deepEqual(account.loadPlannerCache(storage, 'B'), account.emptyPlanner())
  assert.equal(account.persistPlannerCache(storage, a, b, plan(87)), false)
  account.persistPlannerCache(storage, b, b, plan(88))
  owner = account.nextAccountOwner(owner, null)
  assert.equal(account.persistPlannerCache(storage, owner, owner, account.emptyPlanner()), false)
  owner = account.nextAccountOwner(owner, 'A')
  assert.deepEqual(account.loadPlannerCache(storage, 'A'), plan(87))
  assert.deepEqual(account.loadPlannerCache(storage, 'B'), plan(88))
  assert.equal(account.isCurrentAccount(a, owner), false)
  assert.equal(account.nextAccountOwner(owner, 'A'), owner)
})

test('legacy, malformed, wrong-owner and wrong-shaped caches are ignored safely', () => {
  const storage = memoryStorage()
  for (const key of ['weeklyMeals', 'shoppingList', 'onboardingComplete', 'onboardingAnswers']) storage.setItem(key, 'private legacy data')
  account.discardLegacyCaches(storage)
  for (const key of ['weeklyMeals', 'shoppingList', 'onboardingComplete', 'onboardingAnswers']) assert.equal(storage.getItem(key), null)
  for (const invalid of ['{broken', JSON.stringify({ version: 1, userId: 'B', ...plan(87) }), JSON.stringify({ version: 1, userId: 'A', ...plan(87), shoppingList: [] }), JSON.stringify({ version: 1, userId: 'A', ...plan(87), weeklyMeals: [{ day: 'Monday', meal: { id: 87, name: 'bad', ingredients: null } }] })]) {
    storage.setItem(account.plannerCacheKey('A'), invalid)
    assert.deepEqual(account.loadPlannerCache(storage, 'A'), account.emptyPlanner())
  }
  const unavailable = { getItem() { throw Error('blocked') }, setItem() { throw Error('blocked') }, removeItem() { throw Error('blocked') } }
  assert.deepEqual(account.loadPlannerCache(unavailable, 'A'), account.emptyPlanner())
  account.discardLegacyCaches(unavailable)
  const owner = { userId: 'A', generation: 1 }
  assert.equal(account.persistPlannerCache(unavailable, owner, owner, plan(87)), false)
})

test('successful reconciliation clears unavailable recipes and preserves assignments and locks', () => {
  const meals = [...plan(87).weeklyMeals, { day: 'Tuesday', meal: recipe(57), locked: true }]
  const shared = recipe(57, 'Shared starter')
  const refreshed = shopping.refreshWeeklyMeals(meals, [shared])
  assert.deepEqual(refreshed[0], { day: 'Monday', meal: null })
  assert.equal(refreshed[1].meal, shared)
  assert.equal(refreshed[1].locked, true)
  assert.equal(meals[0].meal.id, 87)
})

// Exercise the actual App handlers/effects without a browser or live Supabase.
// JSX is compiled using the project's existing build dependency; hooks and network
// completion are deterministic so responses can arrive in arbitrary account order.
function appHarness(storage = memoryStorage()) {
  const hooks = [], requests = [], alerts = []
  let index = 0, dirty = true, tree, snapshot, listener, effects = [], reloads = 0
  const same = (a, b) => a && b && a.length === b.length && a.every((value, i) => Object.is(value, b[i]))
  const React = {
    createElement(type, props, ...children) { return { type, props: { ...props, children } } },
    useState(initial) {
      const at = index++
      if (!hooks[at]) hooks[at] = { value: typeof initial === 'function' ? initial() : initial }
      return [hooks[at].value, next => {
        const value = typeof next === 'function' ? next(hooks[at].value) : next
        if (!Object.is(value, hooks[at].value)) { hooks[at].value = value; dirty = true }
      }]
    },
    useRef(initial) { const at = index++; return (hooks[at] ||= { current: initial }) },
    useCallback(callback, deps) { const at = index++; if (!hooks[at] || !same(hooks[at].deps, deps)) hooks[at] = { callback, deps }; return hooks[at].callback },
    useEffect(effect, deps) {
      const at = index++
      if (!hooks[at] || !same(hooks[at].deps, deps)) {
        const prior = hooks[at]; hooks[at] = { deps }
        effects.push(() => { prior?.cleanup?.(); hooks[at].cleanup = effect() })
      }
    },
  }
  function request(details) { const pending = deferred(); requests.push({ ...details, ...pending }); return pending.promise }
  const supabase = {
    auth: {
      getSession: () => new Promise(() => {}),
      onAuthStateChange(callback) { listener = callback; return { data: { subscription: { unsubscribe() {} } } } },
      signOut: () => request({ table: 'auth', method: 'logout' }),
      signInWithPassword: () => request({ table: 'auth', method: 'login' }),
      signUp: () => request({ table: 'auth', method: 'signup' }),
    },
    from(table) {
      const details = { table, method: 'select', constraints: {} }
      const query = {
        select() { return query },
        insert(payload) { details.method = 'insert'; details.payload = payload; return query },
        update(payload) { details.method = 'update'; details.payload = payload; return query },
        upsert(payload) { details.method = 'upsert'; details.payload = payload; return query },
        delete() { details.method = 'delete'; return query },
        eq(key, value) { details.constraints[key] = value; return query },
        or(value) { details.filter = value; return query },
        maybeSingle() { return query },
        then(done, fail) { return request(details).then(done, fail) },
      }
      return query
    },
    functions: { invoke: () => request({ table: 'import', method: 'import' }) },
    storage: { from: () => ({ upload: path => request({ table: 'images', method: 'upload', path }), getPublicUrl: path => ({ data: { publicUrl: path } }) }) },
  }
  let source = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8').replace(/^import .*\n/gm, '').replace('export default App', '')
  source = source.replace('  if (!authReady ||', '  observe({ session, weeklyMeals, shoppingList, lockedDays, recipes, recipeName, ingredientRows, instructions, dietTags, selectedCategories, editingRecipeId, recipeUrl, imageUrl, imageFile, viewingRecipe, expandedRecipeId, swapOptions, pantryItems, checkedShoppingItems, onboardingAnswers, onboardingStep, searchTerm, pantrySearch, activeTab, selectedCategory, swipingDay, generateWeeklyMeals, regenerateMeal, getRecipes, addRecipe, importRecipeFromUrl, deleteRecipe, logout });\n  if (!authReady ||')
  const helpers = { ...account, ...shopping, ...ingredients, ...pantry }
  const code = transformSync('App.jsx', source, { jsx: { runtime: 'classic' } }).code
  const App = new Function('React', 'useState', 'useRef', 'useEffect', 'useCallback', 'supabase', 'observe', 'window', 'alert', ...Object.keys(helpers), code + '\nreturn App')(
    React, React.useState, React.useRef, React.useEffect, React.useCallback, supabase, value => { snapshot = value }, { localStorage: storage, location: { reload() { reloads++ } } }, message => alerts.push(message), ...Object.values(helpers))
  function flush() {
    let iterations = 0
    while (dirty) {
      assert.ok(iterations++ < 30, 'effects must settle')
      dirty = false; index = 0; tree = App()
      const pending = effects; effects = []; pending.forEach(effect => effect())
    }
  }
  async function pump() { await new Promise(resolve => setImmediate(resolve)); flush(); await new Promise(resolve => setImmediate(resolve)); flush() }
  function emit(id, render = true) { listener('SIGNED_IN', id ? { user: { id }, token: Math.random() } : null); if (render) flush() }
  function nodes(value = tree, result = []) {
    if (Array.isArray(value)) value.forEach(item => nodes(item, result))
    else if (value && typeof value === 'object') { result.push(value); nodes(value.props?.children, result) }
    return result
  }
  async function ready(id, library = [recipe(id === 'A' ? 87 : 88), recipe(57)], preferences = { household_size: 2 }) {
    const start = requests.length
    emit(id); await pump()
    const ownerRequests = requests.slice(start).filter(item => !item.settled && ['recipes', 'pantry_items', 'user_preferences', 'checked_shopping_items'].includes(item.table))
    for (const req of ownerRequests) {
      req.settled = true
      req.resolve({ data: req.table === 'recipes' ? library : req.table === 'user_preferences' ? (preferences == null ? null : { household_size: 2, ...preferences }) : [], error: null })
    }
    await pump()
  }
  flush()
  return { storage, requests, alerts, flush, pump, emit, ready, nodes, get state() { return snapshot }, get reloads() { return reloads } }
}

test('actual App restores A/B independently, clears drafts/photos/checks, and preserves same-user refresh', async () => {
  const storage = memoryStorage()
  for (const [id, recipeId] of [['A', 87], ['B', 88]]) {
    const owner = { userId: id, generation: 1 }; account.persistPlannerCache(storage, owner, owner, plan(recipeId))
  }
  const app = appHarness(storage)
  await app.ready('A')
  assert.equal(app.state.weeklyMeals[0].meal.id, 87)
  assert.deepEqual(app.state.lockedDays, ['Monday'])
  app.nodes().find(node => node.type === 'input' && node.props.placeholder === 'Recipe name').props.onChange({ target: { value: 'A draft' } })
  app.nodes().find(node => node.type === 'input' && node.props.type === 'file').props.onChange({ target: { files: [{ name: 'A.jpg' }] } })
  app.flush()
  app.emit('A'); await app.pump()
  assert.equal(app.state.recipeName, 'A draft')
  assert.equal(app.state.imageFile.name, 'A.jpg')
  const fileKey = app.nodes().find(node => node.props?.type === 'file').props.key
  const requestCount = app.requests.length
  app.emit('A'); await app.pump()
  assert.equal(app.requests.length, requestCount, 'same-user refresh must not reload/reset')
  await app.ready('B')
  assert.equal(app.state.weeklyMeals[0].meal.id, 88)
  assert.equal(app.state.recipeName, '')
  assert.equal(app.state.imageFile, null)
  assert.notEqual(app.nodes().find(node => node.props?.type === 'file').props.key, fileKey)
  assert.deepEqual(app.state.checkedShoppingItems, [])
  assert.equal(app.state.recipes.some(item => item.id === 57), true)
  await app.ready('A')
  assert.equal(app.state.weeklyMeals[0].meal.id, 87)
  assert.equal(app.state.recipeName, '')
  const refreshed = appHarness(storage); await refreshed.ready('A')
  assert.equal(refreshed.state.weeklyMeals[0].meal.id, 87)
  assert.deepEqual(refreshed.state.lockedDays, ['Monday'])
})

test('actual App rejects delayed recipe/check loads, including A → B → A', async () => {
  const app = appHarness()
  app.emit('A'); await app.pump()
  const stale = app.requests.filter(req => req.table === 'recipes' || req.table === 'checked_shopping_items')
  await app.ready('B')
  for (const req of stale) req.resolve({ data: req.table === 'recipes' ? [recipe(999, 'A secret')] : [{ item_name: 'A check' }], error: null })
  await app.pump()
  assert.equal(app.state.recipes.some(item => item.id === 999), false)
  assert.deepEqual(app.state.checkedShoppingItems, [])
  app.emit('A'); await app.pump()
  const firstA = app.requests.filter(req => !req.settled && req.table === 'recipes').at(-1)
  await app.ready('B'); await app.ready('A')
  firstA.resolve({ data: [recipe(999)], error: null }); await app.pump()
  assert.equal(app.state.recipes.some(item => item.id === 999), false)
})

test('actual App retains scoped caches on logout and ignores late logout continuation', async () => {
  const app = appHarness()
  await app.ready('A')
  const operation = app.state.logout(); await app.pump()
  app.emit(null); await app.pump()
  assert.deepEqual(app.state.weeklyMeals, [])
  assert.deepEqual(app.state.shoppingList, {})
  assert.ok(app.storage.getItem(account.plannerCacheKey('A')))
  await app.ready('B')
  app.requests.find(req => req.method === 'logout').resolve({ error: null })
  await operation; await app.pump()
  assert.equal(app.state.session.user.id, 'B')
  assert.equal(app.state.recipes.some(item => item.id === 88), true)
})

test('actual failed recipe fetch retains cache; successful fetch clears only missing meals', async () => {
  const storage = memoryStorage(), owner = { userId: 'A', generation: 1 }
  account.persistPlannerCache(storage, owner, owner, plan(87))
  const app = appHarness(storage)
  app.emit('A'); await app.pump()
  app.requests.find(req => req.table === 'recipes').resolve({ data: null, error: { message: 'offline' } })
  await app.pump()
  assert.equal(app.state.weeklyMeals[0].meal.id, 87)
  const reload = app.state.getRecipes(); await app.pump()
  app.requests.filter(req => req.table === 'recipes').at(-1).resolve({ data: [recipe(57)], error: null })
  await reload; await app.pump()
  assert.deepEqual(app.state.weeklyMeals, [{ day: 'Monday', meal: null }])
  assert.deepEqual(app.state.lockedDays, ['Monday'])
})

test('actual stale import/upload continuations cannot fill B draft or issue recipe writes', async () => {
  const app = appHarness(); await app.ready('A')
  app.nodes().find(node => node.props?.placeholder === 'Paste recipe URL').props.onChange({ target: { value: 'https://example.com/recipe' } })
  app.nodes().find(node => node.props?.placeholder === 'Recipe name').props.onChange({ target: { value: 'A secret' } })
  app.nodes().find(node => node.props?.placeholder === 'Ingredient name').props.onChange({ target: { value: 'eggs' } })
  app.nodes().find(node => node.props?.type === 'file').props.onChange({ target: { files: [{ name: 'A.jpg' }] } })
  app.flush()
  const importing = app.state.importRecipeFromUrl(), saving = app.state.addRecipe()
  await app.pump()
  const upload = app.requests.find(req => req.table === 'images')
  assert.ok(upload.path.startsWith('A/'))
  await app.ready('B')
  app.requests.find(req => req.table === 'import').resolve({ data: { name: 'A imported secret', ingredients: ['eggs'], image: 'A image' }, error: null })
  upload.resolve({ error: null })
  await Promise.all([importing, saving]); await app.pump()
  assert.equal(app.state.recipeName, '')
  assert.equal(app.state.imageUrl, '')
  assert.equal(app.state.imageFile, null)
  assert.equal(app.requests.some(req => req.table === 'recipes' && req.method === 'insert'), false)
  assert.equal(app.reloads, 0)
})

test('actual stale Pantry, checkbox, and preference saves cannot update new-account state', async () => {
  const storage = memoryStorage(), owner = { userId: 'A', generation: 1 }
  account.persistPlannerCache(storage, owner, owner, plan(87))
  const app = appHarness(storage); await app.ready('A')
  const tab = name => app.nodes().find(node => node.type === 'button' && node.props.children.flat().some(child => typeof child === 'string' && child.includes(name)))
  tab('Pantry').props.onClick(); app.flush()
  app.nodes().find(node => node.props?.id === 'pantry-ingredient').props.onChange({ target: { value: 'A pantry' } }); app.flush()
  const adding = app.nodes().find(node => node.type === 'form' && node.props.className === 'pantry-add').props.onSubmit({ preventDefault() {} })
  tab('Shop').props.onClick(); app.flush()
  const checking = app.nodes(app.nodes().find(node => node.props?.className === 'shopping-item')).find(node => node.type === 'input' && node.props.type === 'checkbox').props.onChange({ target: { checked: true } })
  tab('Settings').props.onClick(); app.flush()
  const saving = tab('Save Preferences').props.onClick()
  await app.pump()
  const mutations = app.requests.filter(req => ['insert', 'upsert'].includes(req.method))
  assert.equal(mutations.length, 3)
  assert.ok(mutations.every(req => req.payload.user_id === 'A'))
  await app.ready('B')
  mutations.forEach(req => req.resolve({ error: null }))
  await Promise.all([adding, checking, saving]); await app.pump()
  assert.deepEqual(app.state.pantryItems, [])
  assert.deepEqual(app.state.checkedShoppingItems, [])
  assert.equal(app.state.pantrySearch, '')
  assert.equal(app.state.session.user.id, 'B')
})

test('rapid identity changes reload the final account even if intermediate renders are batched', async () => {
  const app = appHarness(); await app.ready('A')
  const before = app.requests.length
  app.emit('B', false); app.emit('A', false); app.flush(); await app.pump()
  const loads = app.requests.slice(before)
  assert.ok(loads.some(req => req.table === 'recipes' && req.filter.includes('user_id.eq.A')))
  assert.ok(loads.some(req => req.table === 'user_preferences' && req.constraints.user_id === 'A'))
  assert.equal(app.state.recipeName, '')
})

test('old scoped data and legacy keys are not restored before auth or assigned to B', async () => {
  const storage = memoryStorage(), owner = { userId: 'A', generation: 1 }
  account.persistPlannerCache(storage, owner, owner, plan(87))
  storage.setItem('weeklyMeals', JSON.stringify(plan(87).weeklyMeals))
  storage.setItem('shoppingList', JSON.stringify(plan(87).shoppingList))
  const app = appHarness(storage)
  assert.deepEqual(app.state.weeklyMeals, [])
  assert.deepEqual(app.state.shoppingList, {})
  await app.ready('B')
  assert.deepEqual(app.state.weeklyMeals, [])
  assert.equal(app.state.recipes.some(item => item.id === 87), false)
  assert.equal(storage.getItem('weeklyMeals'), null)
  assert.equal(storage.getItem('shoppingList'), null)
})

test('late recipe delete and checkbox uncheck cannot mutate B or continue deleting aliases', async () => {
  const storage = memoryStorage(), owner = { userId: 'A', generation: 1 }
  const cached = plan(87)
  cached.shoppingList.Other = [{ key: 'paper towels', label: 'paper towels', extra: true, legacyGroups: [['old paper towels']] }]
  account.persistPlannerCache(storage, owner, owner, cached)
  const app = appHarness(storage); await app.ready('A')
  const deleting = app.state.deleteRecipe(87)
  app.nodes().find(node => node.type === 'button' && node.props.children.flat().includes('🛒 Shop')).props.onClick(); app.flush()
  const unchecking = app.nodes(app.nodes().find(node => node.props?.className === 'shopping-item')).find(node => node.props?.type === 'checkbox').props.onChange({ target: { checked: false } })
  await app.pump()
  const deletes = app.requests.filter(req => req.method === 'delete')
  assert.equal(deletes.length, 2)
  assert.ok(deletes.every(req => req.constraints.user_id === 'A'))
  assert.equal(deletes.find(req => req.table === 'recipes').constraints.id, 87)
  await app.ready('B')
  deletes.forEach(req => req.resolve({ error: null }))
  await Promise.all([deleting, unchecking]); await app.pump()
  assert.equal(app.requests.filter(req => req.method === 'delete').length, 2)
  assert.equal(app.state.recipes.some(item => item.id === 88), true)
  assert.deepEqual(app.state.checkedShoppingItems, [])
})

test('editing state and personal recipe mutation ownership are isolated across account changes', async () => {
  const app = appHarness(); await app.ready('A')
  app.nodes().find(node => node.type === 'button' && node.props.children.flat().includes('📖 Recipes')).props.onClick(); app.flush()
  app.nodes().find(node => node.type === 'button' && node.props.children.flat().some(child => typeof child === 'string' && child.includes('✏️ Edit'))).props.onClick(); app.flush()
  assert.equal(app.state.editingRecipeId, 87)
  const saving = app.state.addRecipe(); await app.pump()
  const write = app.requests.find(req => req.table === 'recipes' && req.method === 'update')
  assert.equal(write.constraints.user_id, 'A')
  assert.equal(write.constraints.id, 87)
  await app.ready('B')
  assert.equal(app.state.editingRecipeId, null)
  assert.equal(app.state.viewingRecipe, null)
  assert.equal(app.state.recipeName, '')
  assert.equal(app.state.instructions, '')
  assert.deepEqual(app.state.dietTags, [])
  assert.deepEqual(app.state.selectedCategories, [])
  assert.equal(app.state.recipeUrl, '')
  assert.equal(app.state.imageUrl, '')
  assert.equal(app.state.activeTab, 'planner')
  write.resolve({ data: [recipe(87)], error: null }); await saving; await app.pump()
  assert.equal(app.reloads, 0)
  assert.equal(app.state.recipes.some(item => item.id === 87), false)
})


const supportedRestrictions = ['Gluten-Free', 'Dairy-Free', 'Peanut-Free', 'Tree Nut-Free', 'Shellfish-Free', 'Egg-Free', 'Soy-Free']
const nodeText = node => typeof node === 'string' ? node : Array.isArray(node) ? node.map(nodeText).join('') : nodeText(node?.props?.children || '')
const buttonNamed = (app, label) => app.nodes().find(node => node.type === 'button' && nodeText(node) === label)
function clickButton(app, label) {
  const button = buttonNamed(app, label)
  assert.ok(button, `button exists: ${label}`)
  const result = button.props.onClick(); app.flush(); return result
}
function restrictionButtons(app) {
  const group = app.nodes().find(node => node.props?.['aria-label'] === 'Food allergies & restrictions')
  assert.ok(group)
  return app.nodes(group).filter(node => node.type === 'button')
}
async function saveAndReadPreferences(app) {
  const saving = clickButton(app, 'Save Preferences')
  await app.pump()
  const request = app.requests.filter(req => req.table === 'user_preferences' && req.method === 'upsert').at(-1)
  request.resolve({ error: null }); await saving; await app.pump()
  return request.payload
}

test('onboarding and Preferences share seven supported choices without allergy text input', async () => {
  const app = appHarness(); await app.ready('A', [], null)
  clickButton(app, 'Continue →'); clickButton(app, 'Continue →')
  assert.equal(app.state.onboardingStep, 3)
  assert.deepEqual(restrictionButtons(app).map(nodeText), supportedRestrictions)
  assert.equal(app.nodes().some(node => node.props?.placeholder === 'e.g. peanuts, shellfish, dairy'), false)
  // The only free text in this step is the explicitly informational food-dislikes field.
  assert.deepEqual(app.nodes().filter(node => node.type === 'input').map(node => node.props.value), [''])
  assert.ok(nodeText(app.nodes()).includes('does not currently use these foods to filter meal suggestions.'))
  clickButton(app, 'Dairy-Free')
  assert.deepEqual(app.state.onboardingAnswers.allergies, ['Dairy-Free'])
  await app.ready('B')
  clickButton(app, '⚙️ Settings / Preferences')
  assert.deepEqual(restrictionButtons(app).map(nodeText), supportedRestrictions)
  assert.equal(app.nodes().some(node => node.props?.placeholder === 'e.g. peanuts, shellfish, dairy'), false)
})

test('unsupported restrictions survive edits, save and reload; removal is individual and explicit', async () => {
  const original = ['Sesame', 'sesame', 'Peanut-Free', '', 'Sesame']
  const app = appHarness(); await app.ready('A', [], { allergies: original, disliked_foods: 'olives' })
  clickButton(app, '⚙️ Settings / Preferences')
  assert.ok(nodeText(app.nodes()).includes('Not currently supported: Sesame'))
  assert.ok(nodeText(app.nodes()).includes("Dinnerlyst can't reliably filter this restriction yet."))
  clickButton(app, 'High Protein')
  const unchanged = await saveAndReadPreferences(app)
  assert.deepEqual(unchanged.allergies, original)
  assert.equal(unchanged.disliked_foods, 'olives')
  clickButton(app, 'Soy-Free')
  const saved = await saveAndReadPreferences(app)
  assert.deepEqual(saved.allergies, [...original, 'Soy-Free'])
  const reload = appHarness(); await reload.ready('A', [], saved)
  clickButton(reload, '⚙️ Settings / Preferences')
  assert.deepEqual(reload.state.onboardingAnswers.allergies, saved.allergies)
  reload.nodes().find(node => node.props?.['aria-label'] === 'Remove unsupported restriction: Sesame').props.onClick()
  reload.flush()
  const removed = await saveAndReadPreferences(reload)
  assert.deepEqual(removed.allergies, ['sesame', 'Peanut-Free', '', 'Sesame', 'Soy-Free'])
})

test('legacy strings, null, empty and array allergies remain safe and lossless on save', async () => {
  for (const allergies of ['Sesame, peanuts', 'Gluten-Free', null, '', [], ['']]) {
    const app = appHarness(); await app.ready('A', [recipe(1)], { allergies })
    app.state.generateWeeklyMeals(); app.flush()
    app.state.regenerateMeal('Monday'); app.flush()
    clickButton(app, '⚙️ Settings / Preferences')
    assert.deepEqual((await saveAndReadPreferences(app)).allergies, allergies)
    if (allergies === 'Sesame, peanuts') {
      assert.ok(nodeText(app.nodes()).includes('Not currently supported: Sesame, peanuts'))
      clickButton(app, 'Egg-Free')
      assert.deepEqual((await saveAndReadPreferences(app)).allergies, ['Sesame, peanuts', 'Egg-Free'])
    }
  }
})

test('Generate and Regenerate enforce each recognized restriction and preserve locked/no-match behavior', async () => {
  for (const tag of supportedRestrictions) {
    const safe = { ...recipe(2), diet_tags: [tag] }
    const safeReplacement = { ...recipe(3), diet_tags: [tag] }
    const storage = memoryStorage(), owner = { userId: 'A', generation: 1 }
    account.persistPlannerCache(storage, owner, owner, {
      weeklyMeals: [{ day: 'Monday', meal: recipe(1) }], shoppingList: {}, lockedDays: []
    })
    const app = appHarness(storage)
    await app.ready('A', [recipe(1), safe], { allergies: [tag] })
    app.state.regenerateMeal('Monday'); app.flush()
    assert.equal(app.state.weeklyMeals[0].meal.id, 2)
    app.state.regenerateMeal('Monday'); app.flush()
    assert.equal(app.state.weeklyMeals[0].meal.id, 2, 'no eligible replacement retains current meal')
    app.state.generateWeeklyMeals(); app.flush()
    assert.deepEqual(app.state.weeklyMeals.filter(item => item.meal).map(item => item.meal.id), [2])
    assert.equal(app.state.weeklyMeals.filter(item => !item.meal).length, 6)
    const lockedStorage = memoryStorage()
    account.persistPlannerCache(lockedStorage, owner, owner, {
      weeklyMeals: [{ day: 'Monday', meal: safe }], shoppingList: {}, lockedDays: ['Monday']
    })
    const locked = appHarness(lockedStorage)
    await locked.ready('A', [safe, safeReplacement], { allergies: [tag] })
    locked.state.regenerateMeal('Monday'); locked.flush()
    assert.equal(locked.state.weeklyMeals[0].meal.id, 2)
    locked.state.generateWeeklyMeals(); locked.flush()
    assert.equal(locked.state.weeklyMeals[0].meal.id, 2)
  }
})

test('both generation paths require every restriction together with every dietary preference', async () => {
  const tags = ['Peanut-Free', 'Soy-Free', 'Vegan', 'High Protein']
  const library = tags.map((_, index) => ({ ...recipe(index + 1), diet_tags: tags.filter((_, at) => at !== index) }))
  const safe = { ...recipe(9), diet_tags: tags }
  const storage = memoryStorage(), owner = { userId: 'A', generation: 1 }
  account.persistPlannerCache(storage, owner, owner, {
    weeklyMeals: [{ day: 'Monday', meal: library[0] }], shoppingList: {}, lockedDays: []
  })
  const app = appHarness(storage)
  await app.ready('A', [...library, safe], { allergies: ['Peanut-Free', 'Soy-Free', 'Sesame'], diet_preferences: ['Vegan', 'High Protein'] })
  app.state.regenerateMeal('Monday'); app.flush()
  assert.equal(app.state.weeklyMeals[0].meal.id, 9)
  app.state.generateWeeklyMeals(); app.flush()
  assert.deepEqual(app.state.weeklyMeals.filter(item => item.meal).map(item => item.meal.id), [9])
})


const detailModals = app => app.nodes().filter(node => node.props?.className === 'recipe-modal')
async function pantryDetailApp() {
  const app = appHarness()
  const library = [
    { ...recipe(91, 'Egg supper'), ingredients: ['eggs', 'rice'], instructions: 'Beat eggs.\n\nCook with rice.', image_url: 'https://example.com/eggs.jpg' },
    { ...recipe(92, 'Plain eggs'), instructions: '' }
  ]
  await app.ready('A', library)
  clickButton(app, '🥫 Pantry')
  const adding = clickButton(app, 'Eggs'); await app.pump()
  app.requests.find(req => req.table === 'pantry_items' && req.method === 'insert').resolve({ error: null })
  await adding; await app.pump()
  return app
}
function openPantryCard(app, name = 'Egg supper') {
  const card = app.nodes().find(node => node.props?.className === 'pantry-match-card' && nodeText(node).includes(name))
  assert.ok(card); card.props.onClick(); app.flush()
}
function closeDetails(app) {
  app.nodes(detailModals(app)[0]).find(node => node.props?.className === 'recipe-modal-close').props.onClick()
  app.flush()
}

test('Pantry opens exactly one shared modal with exact recipe contents; closing stays closed across tabs', async () => {
  const app = await pantryDetailApp()
  openPantryCard(app)
  assert.equal(app.state.viewingRecipe.id, 91)
  assert.equal(detailModals(app).length, 1)
  const modal = detailModals(app)[0], nodes = app.nodes(modal)
  assert.equal(nodes.find(node => node.type === 'h2').props.children[0], 'Egg supper')
  assert.deepEqual(nodes.filter(node => node.type === 'li').map(nodeText), ['eggs', 'rice'])
  assert.deepEqual(nodes.filter(node => node.props?.className === 'instruction-step').map(nodeText), ['Beat eggs.', 'Cook with rice.'])
  assert.deepEqual(nodes.filter(node => node.props?.className === 'step-number').map(node => node.props.children[0]), [1, 2])
  assert.equal(nodes.find(node => node.type === 'img').props.src, 'https://example.com/eggs.jpg')
  closeDetails(app)
  assert.equal(app.state.viewingRecipe, null)
  for (const tab of ['🍽 Plan', '📖 Recipes', '🥫 Pantry']) {
    clickButton(app, tab); assert.equal(detailModals(app).length, 0)
  }
  openPantryCard(app, 'Plain eggs')
  assert.equal(detailModals(app).length, 1)
  assert.ok(nodeText(detailModals(app)[0]).includes('No instructions saved.'))
})

test('Plan titles open shared details while Recipes View/Hide stays inline without latent modals', async () => {
  const storage = memoryStorage(), owner = { userId: 'A', generation: 1 }
  const planned = { ...recipe(91, 'Plan supper'), ingredients: ['eggs', 'rice', 'milk', 'salt'], instructions: 'Cook supper.' }
  account.persistPlannerCache(storage, owner, owner, { weeklyMeals: [{ day: 'Monday', meal: planned }], shoppingList: {}, lockedDays: [] })
  const app = appHarness(storage); await app.ready('A', [planned])
  clickButton(app, 'Plan supper')
  assert.equal(app.state.viewingRecipe.id, 91)
  assert.equal(detailModals(app).length, 1)
  assert.ok(nodeText(detailModals(app)[0]).includes('Cook supper.'))
  closeDetails(app)
  clickButton(app, '📖 Recipes'); clickButton(app, 'View Recipe')
  assert.equal(app.state.expandedRecipeId, 91)
  assert.equal(app.state.viewingRecipe, null)
  assert.equal(detailModals(app).length, 0)
  const inline = app.nodes().find(node => node.props?.className === 'recipe-details')
  assert.ok(nodeText(inline).includes('Cook supper.'))
  assert.deepEqual(app.nodes(app.nodes().find(node => node.props?.className === 'recipe-card')).filter(node => node.type === 'li').map(nodeText), planned.ingredients)
  clickButton(app, '🍽 Plan'); assert.equal(detailModals(app).length, 0)
  clickButton(app, '📖 Recipes'); clickButton(app, 'Hide Recipe')
  assert.equal(app.state.expandedRecipeId, null)
  assert.equal(app.nodes().some(node => node.props?.className === 'recipe-details'), false)
})

test('Pantry Add Missing stops card propagation and preserves shopping-list addition', async () => {
  const app = await pantryDetailApp()
  const card = app.nodes().find(node => node.props?.className === 'pantry-match-card' && nodeText(node).includes('Egg supper'))
  const add = app.nodes(card).find(node => node.type === 'button')
  let stopped = false
  add.props.onClick({ stopPropagation() { stopped = true } })
  // Model the parent click only if the child did not stop propagation.
  if (!stopped) card.props.onClick()
  app.flush()
  assert.equal(stopped, true)
  assert.equal(app.state.viewingRecipe, null)
  assert.equal(detailModals(app).length, 0)
  assert.deepEqual(Object.values(app.state.shoppingList).flat().map(item => item.label), ['rice'])
})

test('account switch and logout clear both modal selection and inline expansion', async () => {
  for (const transition of ['switch', 'logout']) {
    const app = await pantryDetailApp()
    clickButton(app, '📖 Recipes'); clickButton(app, 'View Recipe')
    assert.ok(app.state.expandedRecipeId)
    clickButton(app, '🥫 Pantry'); openPantryCard(app)
    assert.ok(app.state.viewingRecipe)
    if (transition === 'switch') await app.ready('B')
    else {
      const signingOut = app.state.logout(); await app.pump()
      app.emit(null); await app.pump()
      app.requests.find(req => req.method === 'logout').resolve({ error: null })
      await signingOut; await app.pump()
    }
    assert.equal(app.state.viewingRecipe, null)
    assert.equal(app.state.expandedRecipeId, null)
    assert.equal(detailModals(app).length, 0)
    await app.ready('C')
    assert.equal(app.state.viewingRecipe, null)
    assert.equal(app.state.expandedRecipeId, null)
    assert.equal(detailModals(app).length, 0)
  }
})


test('Pantry Add Missing feedback is per-card; repeats preserve Bread and pantry ownership', async () => {
  const storage = memoryStorage(), app = appHarness(storage)
  const grilled = { ...recipe(101, 'Grilled Cheese'), ingredients: ['Cheese', 'Butter', 'Bread'] }
  await app.ready('A', [grilled, { ...grilled, id: 102, name: 'Other Sandwich' }])
  clickButton(app, '🥫 Pantry')
  for (const ingredient of ['Cheese', 'Butter']) {
    const adding = clickButton(app, ingredient); await app.pump()
    app.requests.filter(req => req.table === 'pantry_items' && req.method === 'insert').at(-1).resolve({ error: null })
    await adding; await app.pump()
  }
  const cards = () => app.nodes().filter(node => node.props?.className === 'pantry-match-card')
  const target = () => cards().find(node => nodeText(node).includes('Grilled Cheese'))
  const status = card => app.nodes(card).filter(node => node.props?.role === 'status').map(nodeText)
  function addMissing() {
    let stopped = false
    const card = target()
    app.nodes(card).find(node => node.type === 'button').props.onClick({ stopPropagation() { stopped = true } })
    if (!stopped) card.props.onClick()
    assert.equal(stopped, true); app.flush()
  }
  addMissing()
  assert.deepEqual(status(target()), ['✓ Added to Shopping List'])
  assert.deepEqual(status(cards().find(node => nodeText(node).includes('Other Sandwich'))), [])
  assert.equal(app.state.viewingRecipe, null)
  assert.equal(detailModals(app).length, 0)
  assert.deepEqual(app.state.pantryItems, ['Cheese', 'Butter'])
  const counts = app.nodes(target()).find(node => node.type === 'p').props.children
  assert.ok(counts.includes(2)); assert.ok(counts.includes(3))
  assert.deepEqual(app.nodes(target()).filter(node => node.type === 'li').map(nodeText), ['Bread'])
  clickButton(app, '🛒 Shop')
  assert.deepEqual(app.nodes().filter(node => node.props?.className === 'shopping-item').map(nodeText), ['Bread'])
  clickButton(app, '🥫 Pantry'); addMissing()
  assert.deepEqual(status(target()), ['✓ Already on Shopping List'])
  assert.equal(app.state.viewingRecipe, null)
  assert.deepEqual(Object.values(app.state.shoppingList).flat().map(item => item.label), ['Bread'])
  assert.deepEqual(JSON.parse(storage.getItem(account.plannerCacheKey('A'))).shoppingList.Other.map(item => item.label), ['Bread'])
  const reloaded = appHarness(storage); await reloaded.ready('A', [grilled])
  clickButton(reloaded, '🛒 Shop')
  assert.deepEqual(reloaded.nodes().filter(node => node.props?.className === 'shopping-item').map(nodeText), ['Bread'])
  await app.ready('B', [grilled]); clickButton(app, '🥫 Pantry')
  assert.equal(app.nodes().some(node => node.props?.role === 'status'), false)
})
