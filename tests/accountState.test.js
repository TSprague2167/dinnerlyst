import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { transformSync } from 'rolldown/experimental'
import * as account from '../src/accountState.js'
import * as shopping from '../src/shoppingList.js'
import * as ingredients from '../src/ingredients.js'
import * as pantry from '../src/pantry.js'
import * as shoppingDisplay from '../src/shoppingDisplay.js'
import * as discovery from '../src/discovery.js'

const recipe = (id, name = `Recipe ${id}`) => ({ id, name, ingredients: ['eggs'], instructions: '' })
const plan = id => ({ weeklyMeals: [{ day: 'Monday', meal: recipe(id) }], shoppingList: { Other: ['paper towels'] }, lockedDays: ['Monday'] })
function memoryStorage() {
  const values = new Map()
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) }
}
function deferred() {
  let resolve, reject
  const promise = new Promise((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
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
function appHarness(storage = memoryStorage(), weekday = null, callbackType = null, reducedMotion = false) {
  const hooks = [], requests = [], alerts = [], confirmations = [], scrollRequests = []
  const initialSession = deferred()
  const mountedRefs = new Set()
  let confirmResult = true
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
      getSession: () => initialSession.promise,
      updateUser: payload => request({ table: 'auth', method: 'updateUser', payload }),
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
    functions: { invoke: (_name, options) => request({ table: 'import', method: 'import', options }) },
    storage: { from: () => ({ upload: path => request({ table: 'images', method: 'upload', path }), getPublicUrl: path => ({ data: { publicUrl: path } }) }) },
  }
  let source = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8').replace(/^import .*\n/gm, '').replace('export default App', '')
  source = source.replace('  if (!authReady ||', '  observe({ favoriteIds, favoritesError, discoveryQueue, discoveryRecipe, discover, libraryCollection, session, weeklyMeals, shoppingList, lockedDays, recipes, recipeName, ingredientRows, instructions, dietTags, selectedCategories, editingRecipeId, recipeUrl, imageUrl, imageFile, viewingRecipe, expandedRecipeId, swapOptions, pantryItems, checkedShoppingItems, onboardingAnswers, onboardingStep, searchTerm, pantrySearch, activeTab, selectedCategory, swipingDay, preferredDinnerCount, recommendationTarget, changeDinnerCount, addDinner, removeDinner, toggleDayLock, generateWeeklyMeals, regenerateMeal, cookTonight, getRecipes, addRecipe, importRecipeFromUrl, deleteRecipe, beginRecipeEdit, cancelRecipeEdit, recipeSaving, logout, recipeLoad, pantryLoad, checkedLoad, importing, changePantryItem, changeShoppingCheck, loadPantryItems, loadCheckedShoppingItems, passwordSetupRequired, passwordSetupStatus, completePasswordSetup, newPassword, confirmPassword });\n  if (!authReady ||')
  const helpers = { ...account, ...shopping, ...ingredients, ...pantry, ...shoppingDisplay, ...discovery }
  const code = transformSync('App.jsx', source, { jsx: { runtime: 'classic' } }).code
  const App = new Function('React', 'useState', 'useRef', 'useEffect', 'useCallback', 'initialAuthCallbackType', 'supabase', 'observe', 'window', 'alert', 'Date', ...Object.keys(helpers), code + '\nreturn App')(
    React, React.useState, React.useRef, React.useEffect, React.useCallback, callbackType, supabase, value => { snapshot = value }, { matchMedia: query => ({ matches: reducedMotion && query === '(prefers-reduced-motion: reduce)' }), localStorage: storage, location: { reload() { reloads++ } }, confirm(message) { confirmations.push(message); return confirmResult } }, message => alerts.push(message), class extends Date { toLocaleDateString(...args) { return weekday || super.toLocaleDateString(...args) } }, ...Object.values(helpers))
  function flush() {
    let iterations = 0
    while (dirty) {
      assert.ok(iterations++ < 30, 'effects must settle')
      dirty = false; index = 0; tree = App()
      // Commit host refs before effects, as React does after rendering the DOM.
      for (const ref of mountedRefs) ref.current = null
      mountedRefs.clear()
      for (const node of nodes()) {
        if (node.props?.ref && typeof node.type === 'string') {
          const ref = node.props.ref
          ref.current = { scrollIntoView(options) {
            scrollRequests.push({ options, target: node, editingRecipeId: snapshot.editingRecipeId,
              renderedMeals: structuredClone(snapshot.weeklyMeals),
              renderedName: nodes(node).find(item => item.props?.placeholder === 'Recipe name')?.props.value })
          } }
          mountedRefs.add(ref)
        }
      }
      const pending = effects; effects = []; pending.forEach(effect => effect())
    }
  }
  async function pump() { await new Promise(resolve => setImmediate(resolve)); flush(); await new Promise(resolve => setImmediate(resolve)); flush() }
  function emitSession(event, nextSession, render = true) { listener(event, nextSession); if (render) flush() }
  function emit(id, render = true, user = {}) { emitSession('SIGNED_IN', id ? { user: { id, ...user }, token: Math.random() } : null, render) }
  function nodes(value, result = []) {
    if (arguments.length === 0) value = tree
    if (Array.isArray(value)) value.forEach(item => nodes(item, result))
    else if (value && typeof value === 'object') { result.push(value); nodes(value.props?.children, result) }
    return result
  }
  async function ready(id, library = [recipe(id === 'A' ? 87 : 88), recipe(57)], preferences = { household_size: 2 }, pantryNames = [], user = {}) {
    const start = requests.length
    emit(id, true, user); await pump()
    const ownerRequests = requests.slice(start).filter(item => !item.settled && ['recipes', 'pantry_items', 'user_preferences', 'checked_shopping_items'].includes(item.table))
    for (const req of ownerRequests) {
      req.settled = true
      req.resolve({ data: req.table === 'pantry_items' ? pantryNames.map(item_name => ({ item_name })) : req.table === 'recipes' ? library.map(item => Object.hasOwn(item, 'user_id') ? item : { ...item, user_id: id }) : req.table === 'user_preferences' ? (preferences == null ? null : { household_size: 2, ...preferences }) : [], error: null })
    }
    await pump()
  }
  flush()
  return { storage, requests, alerts, confirmations, scrollRequests, setConfirm(value) { confirmResult = value }, flush, pump, emit, emitSession, resolveInitialSession: initialSession.resolve, ready, nodes, get state() { return snapshot }, get reloads() { return reloads } }
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
const nodeText = node => typeof node === 'number' ? String(node) : typeof node === 'string' ? node : Array.isArray(node) ? node.map(nodeText).join('') : nodeText(node?.props?.children || '')
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
    assert.equal(app.state.weeklyMeals.filter(item => !item.meal).length, 0, 'shortage does not replace an existing plan with empty slots')
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

test('both generation paths require every restriction together with every dietary preference for shared recipes', async () => {
  const tags = ['Peanut-Free', 'Soy-Free', 'Vegan', 'High Protein']
  const library = tags.map((_, index) => ({ ...recipe(index + 1), user_id: null, diet_tags: tags.filter((_, at) => at !== index) }))
  const safe = { ...recipe(9), user_id: null, diet_tags: tags }
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
  assert.deepEqual(nodes.filter(node => node.props?.className === 'instruction-step').map(nodeText), ['1Beat eggs.', '2Cook with rice.'])
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
  const add = app.nodes(card).find(node => node.type === 'button' && nodeText(node).includes('Add Missing'))
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
    app.nodes(card).find(node => node.type === 'button' && nodeText(node).includes('Add Missing')).props.onClick({ stopPropagation() { stopped = true } })
    if (!stopped) card.props.onClick()
    assert.equal(stopped, true); app.flush()
  }
  addMissing()
  assert.deepEqual(status(target()), ['✓ Added to Shopping List'])
  assert.deepEqual(status(cards().find(node => nodeText(node).includes('Other Sandwich'))), [])
  assert.equal(app.state.viewingRecipe, null)
  assert.equal(detailModals(app).length, 0)
  assert.deepEqual(app.state.pantryItems, ['Cheese', 'Butter'])
  const counts = app.nodes(target()).find(node => node.type === 'p' && nodeText(node).includes('ingredients available')).props.children
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


const bestCard = app => app.nodes().find(node => node.props?.className === 'best-match-card')
const bestButton = (app, text) => app.nodes(bestCard(app)).find(node => node.type === 'button' && nodeText(node).includes(text))
async function bestApp({ library, pantryNames = [], preferences = {}, meals = [], locks = [], shoppingList = {} }) {
  const storage = memoryStorage(), owner = { userId: 'A', generation: 1 }
  account.persistPlannerCache(storage, owner, owner, { weeklyMeals: meals, shoppingList, lockedDays: locks })
  const app = appHarness(storage, 'Thursday')
  await app.ready('A', library, preferences, pantryNames)
  return app
}
const bestRecipe = (id, name, ingredients, diet_tags = []) => ({ ...recipe(id, name), ingredients, diet_tags })

test('Best Match uses conservative names and supported aliases without changing Pantry threshold', async () => {
  for (const name of ['Cauliflower rice', 'rice vinegar']) {
    const app = await bestApp({ library: [bestRecipe(1, name, [name])], pantryNames: ['Rice'] })
    assert.ok(nodeText(bestCard(app)).includes('No suitable recommendation right now'))
    assert.equal(bestButton(app, 'Add as Dinner'), undefined)
  }
  const alias = await bestApp({ library: [bestRecipe(2, 'Egg meal', ['eggs'])], pantryNames: [' EGG '] })
  assert.ok(nodeText(bestCard(alias)).includes('You can make this!'))
  // Best Match retains its existing positive-match threshold, independent of Pantry's 50%.
  const belowHalf = await bestApp({ library: [bestRecipe(3, 'Small match', ['eggs', 'rice', 'milk'])], pantryNames: ['Egg'] })
  assert.ok(nodeText(bestCard(belowHalf)).includes('33% Ready'))
  clickButton(belowHalf, '🥫 Pantry')
  assert.equal(belowHalf.nodes().some(node => node.props?.className === 'pantry-match-card'), false)
})

test('Best Match requires hard tags for everyone and soft tags for shared recipes', async () => {
  const tags = ['Vegan', 'High Protein', 'Peanut-Free', 'Dairy-Free']
  const preferences = { diet_preferences: tags.slice(0, 2), allergies: [...tags.slice(2), 'sesame'] }
  for (const user_id of [null, 'A']) {
    const incomplete = tags.map((_, at) => ({ ...bestRecipe(at + 1, `Missing tag ${at}`, ['Eggs'], tags.filter((_, index) => index !== at)), user_id })).filter((_, at) => user_id !== 'A' || tags[at] !== 'High Protein')
    const valid = { ...bestRecipe(9, 'Eligible meal', ['Eggs'], tags), user_id }
    const app = await bestApp({ library: [...incomplete, valid], preferences, pantryNames: ['Eggs'] })
    assert.equal(app.nodes(bestCard(app)).find(node => node.type === 'h3').props.children[0], 'Eligible meal')
    assert.ok(app.requests.find(req => req.table === 'recipes').filter.includes('user_id.is.null'))
    const none = await bestApp({ library: incomplete, preferences, pantryNames: ['Eggs'] })
    assert.ok(nodeText(bestCard(none)).includes('No recipe currently matches your preferences, restrictions, weekly plan, and pantry ingredients.'))
    assert.equal(bestButton(none, 'Cook Tonight'), undefined)
  }
})

test('Best Match and Cook Tonight reject other-day duplicates, locks, stale recipes and incompatible tags', async () => {
  const old = bestRecipe(1, 'Old meal', ['Rice'])
  const candidate = bestRecipe(2, 'Egg meal', ['Eggs'], ['Vegan', 'Peanut-Free'])
  const meals = [{ day: 'Thursday', meal: old }, { day: 'Monday', meal: candidate }]
  const duplicate = await bestApp({ library: [old, candidate], meals, pantryNames: ['Eggs'] })
  assert.ok(nodeText(bestCard(duplicate)).includes('No suitable recommendation right now'))
  const before = structuredClone(duplicate.state.weeklyMeals)
  duplicate.state.cookTonight(candidate, 'Thursday'); duplicate.flush()
  assert.deepEqual(duplicate.state.weeklyMeals, before)
  assert.ok(duplicate.alerts.at(-1).includes('already planned'))
  const locked = await bestApp({ library: [old, candidate], meals: [meals[0]], locks: ['Thursday'], pantryNames: ['Eggs'] })
  const lockedBefore = structuredClone(locked.state.weeklyMeals)
  locked.state.cookTonight(candidate, 'Thursday'); locked.flush()
  assert.deepEqual(locked.state.weeklyMeals, lockedBefore)
  assert.deepEqual(locked.state.lockedDays, ['Thursday'])
  assert.ok(locked.alerts.at(-1).includes('locked'))
  for (const tags of [[], ['Vegan'], ['Peanut-Free']]) {
    const invalid = { ...candidate, diet_tags: tags }
    const app = await bestApp({ library: [old, invalid], meals: [meals[0]], preferences: { allergies: ['Peanut-Free'], diet_preferences: ['Vegan'] }, pantryNames: ['Eggs'] })
    const unchanged = structuredClone(app.state.weeklyMeals)
    // Supplying a stale or forged eligible object must not bypass the current library tags.
    app.state.cookTonight(candidate, 'Thursday'); app.flush()
    assert.deepEqual(app.state.weeklyMeals, unchanged)
    app.state.cookTonight({ ...candidate, id: 999 }, 'Thursday'); app.flush()
    assert.deepEqual(app.state.weeklyMeals, unchanged)
  }
  const changed = await bestApp({ library: [old, candidate], meals: [meals[0]], pantryNames: ['Eggs'] })
  clickButton(changed, '⚙️ Settings / Preferences'); clickButton(changed, 'Dairy-Free')
  changed.state.cookTonight(candidate, 'Thursday'); changed.flush()
  assert.equal(changed.state.weeklyMeals[0].meal.id, old.id)
})

test('recommendation replacement requires an explicit destination and preserves other dinners, shopping and cache', async () => {
  const old = {...bestRecipe(1, 'Old meal', []), structured_ingredients:[{amount:'1',unit:'cup',ingredient:'Rice'}]}
  const other = bestRecipe(3,'Other meal',['Milk']), candidate = bestRecipe(2,'Egg meal',['Eggs'])
  const app = await bestApp({library:[old,other,candidate],meals:[{day:'Thursday',meal:old},{day:'Monday',meal:other}],pantryNames:['Eggs'],shoppingList:{Other:[{key:'paper towels',label:'paper towels',extra:true}]}})
  const before = structuredClone(app.state.weeklyMeals)
  app.state.cookTonight(candidate); app.flush()
  assert.deepEqual(app.state.weeklyMeals,before, 'no implicit weekday replacement')
  app.state.cookTonight(candidate,'Thursday'); app.flush()
  assert.equal(app.state.weeklyMeals[0].meal.id, candidate.id)
  assert.deepEqual(app.state.weeklyMeals[1], before[1])
  const visible=Object.values(app.state.shoppingList).flat().filter(shopping.isShoppingItemVisible).map(item=>item.label)
  assert.ok(visible.includes('paper towels')); assert.ok(visible.includes('milk (1)'))
  assert.equal(visible.some(label=>label.includes('Rice')||label.includes('Eggs')),false)
  assertPlannerCacheMatches(app)
  const changed=structuredClone(app.state.weeklyMeals)
  app.state.cookTonight(candidate,'add');app.flush();assert.deepEqual(app.state.weeklyMeals,changed)
  const fresh=await bestApp({library:[candidate],pantryNames:['Eggs']})
  bestButton(fresh,'Add as Dinner').props.onClick();fresh.flush()
  assert.equal(fresh.state.weeklyMeals[0].meal.id,candidate.id)
})

test('Best Match never claims full readiness for rounded 100 percent or empty recipes', async () => {
  const nearly = bestRecipe(1, 'Nearly ready', [...Array(200).fill('Eggs'), 'Rice'])
  const app = await bestApp({ library: [nearly], pantryNames: ['Eggs'] })
  assert.equal(pantry.getPantryRecipeMatch(nearly, ['Eggs']).matchPercentage, 100)
  assert.equal(nodeText(bestCard(app)).includes('You can make this!'), false)
  assert.ok(nodeText(bestCard(app)).includes('99% Ready'))
  assert.ok(nodeText(bestCard(app)).includes('Rice'))
  assert.ok(bestButton(app, 'Add as Dinner'), 'a partially stocked recipe may still be planned')
  const empty = await bestApp({ library: [bestRecipe(2, 'Empty', [])], pantryNames: ['Eggs'] })
  assert.ok(nodeText(bestCard(empty)).includes('No suitable recommendation right now'))
})

test('Best Match Add Missing gives local Added/Already feedback, deduplicates, and preserves Pantry ownership', async () => {
  const grilled = bestRecipe(1, 'Grilled Cheese', ['Cheese', 'Butter', 'Bread'])
  const app = await bestApp({ library: [grilled], pantryNames: ['Cheese', 'Butter'] })
  const add = () => { bestButton(app, 'Add Missing').props.onClick(); app.flush() }
  add()
  assert.ok(nodeText(bestCard(app)).includes('✓ Added to Shopping List'))
  assert.deepEqual(app.state.pantryItems, ['Cheese', 'Butter'])
  assert.ok(nodeText(bestCard(app)).includes('67% Ready'))
  assert.ok(nodeText(bestCard(app)).includes('• Bread'))
  assert.equal(app.state.viewingRecipe, null)
  add()
  assert.ok(nodeText(bestCard(app)).includes('✓ Already on Shopping List'))
  assert.deepEqual(Object.values(app.state.shoppingList).flat().map(item => item.label), ['Bread'])
  assert.deepEqual(JSON.parse(app.storage.getItem(account.plannerCacheKey('A'))).shoppingList.Other.map(item => item.label), ['Bread'])
  clickButton(app, '🛒 Shop')
  assert.deepEqual(app.nodes().filter(node => node.props?.className === 'shopping-item').map(nodeText), ['Bread'])
  clickButton(app, '🥫 Pantry')
  assert.equal(app.nodes().some(node => node.props?.role === 'status'), false, 'Best Match feedback does not affect Pantry cards')
  await app.ready('B', [grilled], {}, ['Cheese', 'Butter'])
  assert.equal(nodeText(bestCard(app)).includes('✓ Already on Shopping List'), false)
})

const editFixture = (id, name = `Recipe ${id}`) => ({
  ...recipe(id, name), user_id: 'A', categories: ['Chicken'], diet_tags: ['Peanut-Free'],
  image_url: `${id}.jpg`, instructions: `Steps for ${id}`,
  structured_ingredients: [{ amount: '2', unit: 'whole', ingredient: 'eggs' }]
})
const recipeWrites = app => app.requests.filter(req => req.table === 'recipes' && ['insert', 'update'].includes(req.method))
function draftSnapshot(app) {
  const { editingRecipeId, recipeName, ingredientRows, instructions, selectedCategories, dietTags, imageUrl, imageFile, recipeUrl } = app.state
  return structuredClone({ editingRecipeId, recipeName, ingredientRows, instructions, selectedCategories, dietTags, imageUrl, imageFile, recipeUrl })
}
function assertCleanDraft(app) {
  assert.deepEqual(draftSnapshot(app), {
    editingRecipeId: null, recipeName: '', ingredientRows: [ingredients.emptyIngredientRow()],
    instructions: '', selectedCategories: [], dietTags: [], imageUrl: '', imageFile: null, recipeUrl: ''
  })
}
function enterImportUrl(app) {
  if (app.state.activeTab !== 'add-recipe') clickButton(app, '➕ Add Recipe')
  app.nodes().find(node => node.props?.placeholder === 'Paste recipe URL').props.onChange({ target: { value: 'https://example.com/import' } })
  app.flush()
}
function selectPendingImage(app) {
  app.nodes().find(node => node.props?.type === 'file').props.onChange({ target: { files: [{ name: 'pending.png' }] } })
  app.flush()
}
async function finishRecipeSave(app, saving, saved) {
  const write = recipeWrites(app).at(-1)
  write.resolve({ data: [saved], error: null }); await app.pump()
  app.requests.filter(req => req.table === 'recipes' && req.method === 'select').at(-1).resolve({ data: [saved], error: null })
  await saving; await app.pump()
}

test('Edit A → image-less import B clears identity/metadata/photo and inserts B; successful save resets every field', async () => {
  const app = appHarness(); await app.ready('A', [editFixture(101, 'Recipe A')])
  clickButton(app, '📖 Recipes'); clickButton(app, '✏️ Edit')
  selectPendingImage(app); enterImportUrl(app)
  const importing = app.state.importRecipeFromUrl(); await app.pump()
  app.requests.find(req => req.table === 'import').resolve({ data: { name: 'Recipe B', ingredients: ['Bread'], instructions: ['Toast bread.'] }, error: null })
  await importing; await app.pump()
  assert.deepEqual(draftSnapshot(app), {
    editingRecipeId: null, recipeName: 'Recipe B', ingredientRows: [{ amount: '', unit: '', ingredient: 'Bread' }],
    instructions: 'Toast bread.', selectedCategories: [], dietTags: [], imageUrl: '', imageFile: null, recipeUrl: ''
  })
  const saving = app.state.addRecipe(); await app.pump()
  const writes = recipeWrites(app)
  assert.equal(writes.length, 1); assert.equal(writes[0].method, 'insert')
  assert.equal(writes[0].payload[0].name, 'Recipe B')
  assert.deepEqual(writes[0].payload[0].diet_tags, [])
  assert.equal(writes[0].payload[0].image_url, '')
  assert.equal(app.requests.some(req => req.table === 'images'), false)
  await finishRecipeSave(app, saving, { ...recipe(102, 'Recipe B'), user_id: 'A' })
  assertCleanDraft(app)
  assert.equal(app.state.recipeSaving, false)
  assert.equal(app.reloads, 0)
  assert.equal(app.state.activeTab, 'recipes')
})

test('failed import preserves entire edit and pending image; Cancel Edit remounts file input and next Add inserts', async () => {
  const app = appHarness(); await app.ready('A', [editFixture(101)])
  clickButton(app, '📖 Recipes'); clickButton(app, '✏️ Edit'); selectPendingImage(app); enterImportUrl(app)
  const original = draftSnapshot(app)
  const importing = app.state.importRecipeFromUrl(); await app.pump()
  app.requests.find(req => req.table === 'import').resolve({ data: null, error: { message: 'Cannot import' } })
  await importing; await app.pump()
  assert.deepEqual(draftSnapshot(app), original)
  assert.ok(app.alerts.includes('Could not import that recipe.'))
  const fileKey = app.nodes().find(node => node.props?.type === 'file').props.key
  clickButton(app, '🍽 Plan'); clickButton(app, '📖 Recipes'); clickButton(app, '➕ Add Recipe')
  assert.deepEqual(draftSnapshot(app), original, 'ordinary navigation preserves drafts')
  clickButton(app, 'Cancel Edit')
  assertCleanDraft(app)
  assert.notEqual(app.nodes().find(node => node.props?.type === 'file').props.key, fileKey)
  app.nodes().find(node => node.props?.placeholder === 'Recipe name').props.onChange({ target: { value: 'Fresh recipe' } })
  app.nodes().find(node => node.props?.placeholder === 'Ingredient name').props.onChange({ target: { value: 'Rice' } })
  app.flush()
  const saving = app.state.addRecipe(); await app.pump()
  assert.equal(recipeWrites(app)[0].method, 'insert')
  assert.equal(app.requests.some(req => req.table === 'images'), false)
  await finishRecipeSave(app, saving, { ...recipe(103), user_id: 'A' }); assertCleanDraft(app)
})

test('late same-account imports cannot overwrite another edit, cancelled edit, or newer import', async () => {
  for (const transition of ['edit', 'cancel', 'newer import']) {
    const app = appHarness(); await app.ready('A', [editFixture(101), editFixture(102)])
    clickButton(app, '📖 Recipes'); app.state.beginRecipeEdit(app.state.recipes[0]); app.flush(); enterImportUrl(app)
    const first = app.state.importRecipeFromUrl(); await app.pump()
    const response = app.requests.find(req => req.table === 'import')
    if (transition === 'edit') { app.state.beginRecipeEdit(app.state.recipes[1]); app.flush() }
    else if (transition === 'cancel') clickButton(app, 'Cancel Edit')
    else {
      const next = app.state.importRecipeFromUrl(); await app.pump()
      app.requests.filter(req => req.table === 'import').at(-1).resolve({ data: { name: 'Newer import', ingredients: ['Rice'], instructions: [], image: 'new.jpg' }, error: null })
      await next; await app.pump()
    }
    const expected = draftSnapshot(app)
    response.resolve({ data: { name: 'Stale import', ingredients: ['Bread'], image: 'stale.jpg' }, error: null })
    await first; await app.pump()
    assert.deepEqual(draftSnapshot(app), expected)
  }
})

test('image upload failure aborts Add and Edit, preserves retry state, and successful retry fully resets', async () => {
  for (const editing of [true, false]) {
    const app = appHarness(); await app.ready('A', [editFixture(101)])
    clickButton(app, '📖 Recipes'); clickButton(app, '✏️ Edit')
    if (!editing) clickButton(app, 'Cancel Edit')
    if (!editing) {
      app.nodes().find(node => node.props?.placeholder === 'Recipe name').props.onChange({ target: { value: 'New recipe' } })
      app.nodes().find(node => node.props?.placeholder === 'Ingredient name').props.onChange({ target: { value: 'Eggs' } }); app.flush()
    }
    selectPendingImage(app)
    const before = draftSnapshot(app)
    const saving = app.state.addRecipe(); await app.pump()
    app.requests.find(req => req.table === 'images').resolve({ error: { message: 'Storage unavailable' } })
    await saving; await app.pump()
    assert.equal(recipeWrites(app).length, 0)
    assert.deepEqual(draftSnapshot(app), before)
    assert.equal(app.state.recipes[0].image_url, '101.jpg')
    assert.equal(app.state.recipeSaving, false)
    assert.ok(app.alerts.at(-1).includes('Your recipe was not saved'))
    const retry = app.state.addRecipe(); await app.pump()
    app.requests.filter(req => req.table === 'images').at(-1).resolve({ error: null }); await app.pump()
    const write = recipeWrites(app)[0]
    assert.equal(write.method, editing ? 'update' : 'insert')
    assert.ok((editing ? write.payload.image_url : write.payload[0].image_url).startsWith('A/'))
    await finishRecipeSave(app, retry, { ...recipe(101), user_id: 'A' }); assertCleanDraft(app)
  }
})

test('saving blocks overlapping writes, Edit/Import/Cancel transitions and pending imports; navigation remains available', async () => {
  const app = appHarness(); await app.ready('A', [editFixture(101), editFixture(102)])
  clickButton(app, '📖 Recipes'); app.state.beginRecipeEdit(app.state.recipes[0]); app.flush(); enterImportUrl(app)
  const importing = app.state.importRecipeFromUrl(); await app.pump()
  selectPendingImage(app)
  const saving = app.state.addRecipe(), duplicate = app.state.addRecipe(); await duplicate; await app.pump()
  assert.equal(app.requests.filter(req => req.table === 'images').length, 1)
  assert.equal(app.state.recipeSaving, true)
  assert.equal(app.nodes().find(node => node.type === 'fieldset').props.disabled, true)
  const snapshot = draftSnapshot(app)
  app.state.beginRecipeEdit(app.state.recipes[1]); app.state.cancelRecipeEdit()
  await app.state.importRecipeFromUrl(); app.flush()
  assert.deepEqual(draftSnapshot(app), snapshot)
  assert.equal(app.requests.filter(req => req.table === 'import').length, 1)
  app.requests.find(req => req.table === 'import').resolve({ data: { name: 'Stale response', ingredients: ['Rice'] }, error: null })
  await importing; await app.pump()
  assert.deepEqual(draftSnapshot(app), snapshot)
  clickButton(app, '🍽 Plan'); assert.equal(app.state.activeTab, 'planner')
  app.requests.find(req => req.table === 'images').resolve({ error: null }); await app.pump()
  await app.state.addRecipe(); assert.equal(recipeWrites(app).length, 1)
  assert.equal(recipeWrites(app)[0].constraints.id, 101)
  await finishRecipeSave(app, saving, { ...recipe(101), user_id: 'A' }); assertCleanDraft(app)
})

test('owned deletion requires confirmation and affected row; errors/zero rows preserve cards and drafts', async () => {
  const app = appHarness(); await app.ready('A', [editFixture(101), editFixture(102)])
  app.setConfirm(false); await app.state.deleteRecipe(101); await app.pump()
  assert.equal(app.requests.some(req => req.method === 'delete'), false)
  assert.ok(app.confirmations[0].includes('cannot be undone'))
  app.setConfirm(true)
  for (const error of [{ message: 'Delete denied' }, null]) {
    const deleting = app.state.deleteRecipe(101); await app.pump()
    const request = app.requests.filter(req => req.method === 'delete').at(-1)
    assert.deepEqual(request.constraints, { id: 101, user_id: 'A' })
    request.resolve({ data: [], error }); await deleting; await app.pump()
    assert.equal(app.state.recipes.length, 2)
    assert.ok(app.alerts.at(-1).includes(error ? 'Delete denied' : 'not deleted'))
  }
  app.state.beginRecipeEdit(app.state.recipes[0]); app.flush()
  const deleting = app.state.deleteRecipe(101); await app.pump()
  app.requests.filter(req => req.method === 'delete').at(-1).resolve({ data: [{ id: 101 }], error: null })
  await deleting; await app.pump()
  assert.deepEqual(app.state.recipes.map(item => item.id), [102]); assertCleanDraft(app)
})

test('shared recipes retain inline viewing and planning eligibility without personal mutation controls', async () => {
  const shared = { ...editFixture(101, 'Shared recipe'), user_id: null }
  const app = appHarness(); await app.ready('A', [shared, editFixture(102, 'Owned recipe')])
  clickButton(app, '📖 Recipes')
  const cards = app.nodes().filter(node => node.props?.className === 'recipe-card')
  const sharedCard = cards.find(node => nodeText(node).includes('Shared recipe'))
  const ownedCard = cards.find(node => nodeText(node).includes('Owned recipe'))
  const buttons = card => app.nodes(card).filter(node => node.type === 'button').map(nodeText)
  assert.deepEqual(buttons(sharedCard), ['View Recipe'])
  assert.ok(buttons(ownedCard).some(text => text.includes('Edit')))
  assert.ok(buttons(ownedCard).includes('Delete'))
  app.nodes(sharedCard).find(node => node.type === 'button').props.onClick(); app.flush()
  assert.equal(app.state.expandedRecipeId, 101)
  app.state.beginRecipeEdit(app.state.recipes[0]); await app.state.deleteRecipe(101); app.flush()
  assert.equal(app.state.editingRecipeId, null)
  assert.equal(app.confirmations.length, 0)
  assert.equal(app.requests.some(req => req.method === 'delete'), false)
  app.state.changeDinnerCount(2); app.flush()
  app.state.generateWeeklyMeals(); app.flush()
  assert.ok(app.state.weeklyMeals.some(item => item.meal?.id === 101))
})

test('zero-row recipe update retains edit and retry state instead of reloading', async () => {
  const app = appHarness(); await app.ready('A', [editFixture(101)])
  app.state.beginRecipeEdit(app.state.recipes[0]); app.flush()
  const snapshot = draftSnapshot(app)
  const saving = app.state.addRecipe(); await app.pump()
  recipeWrites(app)[0].resolve({ data: [], error: null }); await saving; await app.pump()
  assert.deepEqual(draftSnapshot(app), snapshot)
  assert.equal(app.state.recipeSaving, false)
  assert.equal(app.reloads, 0)
  assert.ok(app.alerts.at(-1).includes('not saved'))
})

test('late same-account deletion cannot reset a subsequently selected edit', async () => {
  const app = appHarness(); await app.ready('A', [editFixture(101), editFixture(102)])
  app.state.beginRecipeEdit(app.state.recipes[0]); app.flush()
  const deleting = app.state.deleteRecipe(101); await app.pump()
  app.state.beginRecipeEdit(app.state.recipes[1]); app.flush()
  const expected = draftSnapshot(app)
  app.requests.find(req => req.method === 'delete').resolve({ data: [{ id: 101 }], error: null })
  await deleting; await app.pump()
  assert.deepEqual(draftSnapshot(app), expected)
  assert.deepEqual(app.state.recipes.map(item => item.id), [102])
})


test('Edit scrolls the actual builder after edit content renders, including repeated editing of the same recipe', async () => {
  const app = appHarness(); await app.ready('A', [editFixture(101, 'Scroll target recipe')])
  clickButton(app, '📖 Recipes')
  assert.equal(app.scrollRequests.length, 0)
  buttonNamed(app, '✏️ Edit').props.onClick()
  assert.equal(app.scrollRequests.length, 0, 'no scroll before React commits the edit render')
  app.flush()
  assert.equal(app.scrollRequests.length, 1)
  const request = app.scrollRequests[0]
  assert.equal(request.target.props.className, 'card recipe-builder-section')
  assert.equal(request.target.props.hidden, false)
  assert.equal(request.editingRecipeId, 101)
  assert.equal(request.renderedName, 'Scroll target recipe')
  assert.deepEqual(request.options, { behavior: 'smooth', block: 'start' })
  assert.ok(app.nodes(request.target).some(node => node.type === 'button' && nodeText(node) === 'Save Changes'))
  clickButton(app, '📖 Recipes'); clickButton(app, '✏️ Edit')
  assert.equal(app.scrollRequests.length, 2, 'same-recipe Edit also requests a fresh scroll')
  clickButton(app, 'Cancel Edit')
  clickButton(app, '🍽 Plan'); clickButton(app, '📖 Recipes')
  assert.equal(app.scrollRequests.length, 2, 'Cancel/navigation do not issue stale scroll requests')
})

const preferenceWrites = app => app.requests.filter(req => req.table === 'user_preferences' && req.method === 'upsert')
const feedbackTexts = (app, role) => app.nodes().filter(node => node.props?.role === role).map(nodeText)

test('Preferences save is pending/locked synchronously, confirms success, and stales confirmation after edits', async () => {
  const app = appHarness(); await app.ready('A')
  clickButton(app, '⚙️ Settings / Preferences'); clickButton(app, 'Dairy-Free')
  const handler = buttonNamed(app, 'Save Preferences').props.onClick
  const first = handler(), repeated = handler(); app.flush(); await repeated; await app.pump()
  assert.equal(preferenceWrites(app).length, 1)
  assert.equal(buttonNamed(app, 'Saving...').props.disabled, true)
  assert.ok(feedbackTexts(app, 'status').includes('Saving your preferences…'))
  assert.equal(feedbackTexts(app, 'status').includes('✓ Preferences saved'), false)
  preferenceWrites(app)[0].resolve({ error: null }); await first; await app.pump()
  assert.ok(feedbackTexts(app, 'status').includes('✓ Preferences saved'))
  assert.equal(buttonNamed(app, 'Save Preferences').props.disabled, false)
  clickButton(app, 'Peanut-Free')
  assert.equal(feedbackTexts(app, 'status').includes('✓ Preferences saved'), false)
  assert.ok(feedbackTexts(app, 'status').includes('You have unsaved changes.'))
})

test('failed Preferences save preserves every selected value, displays an inline error, and supports retry', async () => {
  const app = appHarness(); await app.ready('A', [], { allergies: ['Sesame'], disliked_foods: 'olives' })
  clickButton(app, '⚙️ Settings / Preferences'); clickButton(app, 'Peanut-Free'); clickButton(app, 'Vegan')
  const expected = structuredClone(app.state.onboardingAnswers)
  const saving = clickButton(app, 'Save Preferences'); await app.pump()
  preferenceWrites(app)[0].resolve({ error: { message: 'offline' } }); await saving; await app.pump()
  assert.deepEqual(app.state.onboardingAnswers, expected)
  assert.ok(feedbackTexts(app, 'alert').some(text => text.includes('Could not save your preferences.')))
  assert.equal(feedbackTexts(app, 'status').includes('✓ Preferences saved'), false)
  assert.equal(buttonNamed(app, 'Save Preferences').props.disabled, false)
  const retry = clickButton(app, 'Save Preferences'); await app.pump()
  assert.deepEqual(feedbackTexts(app, 'alert'), [])
  preferenceWrites(app).at(-1).resolve({ error: null }); await retry; await app.pump()
  assert.ok(feedbackTexts(app, 'status').includes('✓ Preferences saved'))
})

test('failed onboarding save stays on completion step with visible error; repeated start is blocked and retry advances', async () => {
  const app = appHarness(); await app.ready('A', [], null)
  while (app.state.onboardingStep < 5) {
    if (app.state.onboardingStep === 3) clickButton(app, 'Dairy-Free')
    clickButton(app, 'Continue →')
  }
  const expected = structuredClone(app.state.onboardingAnswers)
  const handler = buttonNamed(app, 'Start Planning →').props.onClick
  const saving = handler(), duplicate = handler(); app.flush(); await duplicate; await app.pump()
  assert.equal(preferenceWrites(app).length, 1)
  assert.equal(buttonNamed(app, 'Saving...').props.disabled, true)
  preferenceWrites(app)[0].resolve({ error: { message: 'offline' } }); await saving; await app.pump()
  assert.equal(app.state.onboardingStep, 5)
  assert.deepEqual(app.state.onboardingAnswers, expected)
  assert.ok(feedbackTexts(app, 'alert').some(text => text.includes('Could not save your preferences.')))
  const retry = clickButton(app, 'Start Planning →'); await app.pump()
  preferenceWrites(app).at(-1).resolve({ error: null }); await retry; await app.pump()
  assert.equal(app.state.onboardingStep, 0)
})

test('a successful older snapshot never confirms edits made while saving; next request submits the newer values', async () => {
  const app = appHarness(); await app.ready('A')
  clickButton(app, '⚙️ Settings / Preferences'); clickButton(app, 'Dairy-Free')
  const originalHandler = buttonNamed(app, 'Save Preferences').props.onClick
  const saving = originalHandler(); app.flush(); await app.pump()
  clickButton(app, 'Peanut-Free')
  await originalHandler(); await app.pump()
  assert.equal(preferenceWrites(app).length, 1)
  assert.deepEqual(preferenceWrites(app)[0].payload.allergies, ['Dairy-Free'])
  preferenceWrites(app)[0].resolve({ error: null }); await saving; await app.pump()
  assert.deepEqual(app.state.onboardingAnswers.allergies, ['Dairy-Free', 'Peanut-Free'])
  assert.equal(feedbackTexts(app, 'status').includes('✓ Preferences saved'), false)
  assert.ok(feedbackTexts(app, 'status').includes('You have unsaved changes.'))
  const latest = clickButton(app, 'Save Preferences'); await app.pump()
  assert.deepEqual(preferenceWrites(app)[1].payload.allergies, ['Dairy-Free', 'Peanut-Free'])
  preferenceWrites(app)[1].resolve({ error: null }); await latest; await app.pump()
  assert.ok(feedbackTexts(app, 'status').includes('✓ Preferences saved'))
})

test('account transition clears preference save state; stale success/error cannot clear another account pending lock or feedback', async () => {
  for (const error of [null, { message: 'old account offline' }]) {
    const app = appHarness(); await app.ready('A')
    clickButton(app, '⚙️ Settings / Preferences'); clickButton(app, 'Dairy-Free')
    const oldSave = clickButton(app, 'Save Preferences'); await app.pump()
    const oldRequest = preferenceWrites(app)[0]
    await app.ready('B'); clickButton(app, '⚙️ Settings / Preferences')
    assert.deepEqual(feedbackTexts(app, 'status'), [])
    assert.deepEqual(feedbackTexts(app, 'alert'), [])
    assert.equal(buttonNamed(app, 'Save Preferences').props.disabled, false)
    clickButton(app, 'Peanut-Free')
    const currentHandler = buttonNamed(app, 'Save Preferences').props.onClick
    const currentSave = currentHandler(); app.flush(); await app.pump()
    oldRequest.resolve({ error }); await oldSave; await app.pump()
    assert.equal(buttonNamed(app, 'Saving...').props.disabled, true)
    assert.deepEqual(feedbackTexts(app, 'alert'), [])
    await currentHandler(); await app.pump()
    assert.equal(preferenceWrites(app).length, 2)
    preferenceWrites(app)[1].resolve({ error: null }); await currentSave; await app.pump()
    assert.ok(feedbackTexts(app, 'status').includes('✓ Preferences saved'))
    app.emit(null); await app.pump(); await app.ready('B'); clickButton(app, '⚙️ Settings / Preferences')
    assert.deepEqual(feedbackTexts(app, 'status'), [])
  }
})


test('household-size edits to loaded Preferences show unsaved status before the first save and after saving', async () => {
  const app = appHarness(); await app.ready('A', [], { household_size: 2 })
  clickButton(app, '⚙️ Settings / Preferences')
  assert.equal(feedbackTexts(app, 'status').includes('You have unsaved changes.'), false)
  clickButton(app, '+')
  assert.equal(app.state.onboardingAnswers.householdSize, 3)
  assert.ok(feedbackTexts(app, 'status').includes('You have unsaved changes.'))
  assert.equal(feedbackTexts(app, 'status').includes('✓ Preferences saved'), false)
  const saving = clickButton(app, 'Save Preferences'); await app.pump()
  assert.equal(preferenceWrites(app)[0].payload.household_size, 3)
  preferenceWrites(app)[0].resolve({ error: null }); await saving; await app.pump()
  assert.ok(feedbackTexts(app, 'status').includes('✓ Preferences saved'))
  assert.equal(feedbackTexts(app, 'status').includes('You have unsaved changes.'), false)
  clickButton(app, '+')
  assert.equal(app.state.onboardingAnswers.householdSize, 4)
  assert.ok(feedbackTexts(app, 'status').includes('You have unsaved changes.'))
  assert.equal(feedbackTexts(app, 'status').includes('✓ Preferences saved'), false)
})

test('loaded Preferences detect changes across fields but not a no-op household decrement', async () => {
  const app = appHarness(); await app.ready('A', [], { household_size: 1 })
  clickButton(app, '⚙️ Settings / Preferences'); clickButton(app, '−')
  assert.equal(app.state.onboardingAnswers.householdSize, 1)
  assert.equal(feedbackTexts(app, 'status').includes('You have unsaved changes.'), false)
  clickButton(app, 'Dairy-Free')
  assert.ok(feedbackTexts(app, 'status').includes('You have unsaved changes.'))
  await app.ready('B', [], { household_size: 2 }); clickButton(app, '⚙️ Settings / Preferences')
  assert.deepEqual(feedbackTexts(app, 'status'), [], 'loaded baseline cannot leak between accounts')
})


const shortageText = app => feedbackTexts(app, 'status').join(' ')
const eligibleMeal = id => bestRecipe(id, `Eligible ${id}`, [`Ingredient ${id}`], ['Vegan', 'Peanut-Free'])
const shortagePreferences = { diet_preferences: ['Vegan'], allergies: ['Peanut-Free'] }
function assertPlannerCacheMatches(app) {
  const cached = JSON.parse(app.storage.getItem(account.plannerCacheKey('A')))
  assert.deepEqual(cached.weeklyMeals, JSON.parse(JSON.stringify(app.state.weeklyMeals)))
  assert.deepEqual(cached.shoppingList, app.state.shoppingList)
  assert.deepEqual(cached.lockedDays, app.state.lockedDays)
}

test('full Generate clears stale shortage feedback and produces seven unique eligible meals', async () => {
  const library = Array.from({ length: 7 }, (_, at) => eligibleMeal(at + 1))
  const app = await bestApp({ library, preferences: shortagePreferences, meals: library.map((meal, at) => ({ day: ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'][at], meal })) })
  app.state.regenerateMeal('Tuesday'); app.flush()
  assert.ok(shortageText(app).includes('No alternative recipe is available for Dinner 2'))
  app.state.generateWeeklyMeals(); app.flush()
  assert.equal(app.state.weeklyMeals.length, 7)
  assert.equal(new Set(app.state.weeklyMeals.map(item => item.meal.id)).size, 7)
  assert.equal(shortageText(app), '')
  assertPlannerCacheMatches(app)
})

test('insufficient generation preserves every existing dinner, lock, shopping item and cache', async () => {
  const locked=bestRecipe(99,'Locked incompatible meal',['LockedIngredient']),old=bestRecipe(100,'Old unlocked meal',['OldIngredient'])
  const app=await bestApp({library:[locked,old,eligibleMeal(1),eligibleMeal(2)],preferences:shortagePreferences,meals:[{day:'Monday',meal:locked},{day:'Tuesday',meal:old}],locks:['Monday'],shoppingList:{Other:[{key:'paper towels',label:'paper towels',extra:true}]}})
  const before=structuredClone({meals:app.state.weeklyMeals,shopping:app.state.shoppingList,locks:app.state.lockedDays})
  app.state.generateWeeklyMeals();app.flush()
  assert.deepEqual({meals:app.state.weeklyMeals,shopping:app.state.shoppingList,locks:app.state.lockedDays},before)
  assert.ok(shortageText(app).includes('Could not fill all 7 dinners'))
  assert.ok(shortageText(app).includes('kept unchanged'))
  assertPlannerCacheMatches(app)
  clickButton(app,'View Recipes');assert.equal(app.state.activeTab,'recipes')
  clickButton(app,'🍽 Plan');clickButton(app,'Review Preferences');assert.equal(app.state.activeTab,'preferences')
})

test('zero eligible Generate reports no additional recipes and preserves locked meals without validating them', async () => {
  for (const locks of [[], ['Monday']]) {
    const incompatible = bestRecipe(99, 'Incompatible meal', ['OldIngredient'])
    const app = await bestApp({ library: [incompatible], preferences: shortagePreferences,
      meals: [{ day: 'Monday', meal: incompatible }], locks })
    app.state.generateWeeklyMeals(); app.flush()
    assert.equal(app.state.weeklyMeals.filter(item => item.meal).length, 1)
    assert.ok(shortageText(app).includes('Could not fill all 7 dinners'))
    assert.ok(shortageText(app).includes('kept unchanged'))
    if (locks.length) assert.equal(app.state.weeklyMeals[0].meal.id, 99)
    assert.deepEqual(app.state.lockedDays, locks)
    assertPlannerCacheMatches(app)
  }
})

test('empty unavailable recipe library gives neutral feedback and preserves cached plan, shopping and locks', async () => {
  const storage = memoryStorage(), owner = { userId: 'A', generation: 1 }
  account.persistPlannerCache(storage, owner, owner, plan(87))
  const app = appHarness(storage); app.emit('A'); await app.pump()
  for (const req of app.requests) {
    if (req.table === 'recipes') req.resolve({ data: null, error: { message: 'offline' } })
    else if (req.table === 'user_preferences') req.resolve({ data: { household_size: 2 }, error: null })
    else if (['pantry_items', 'checked_shopping_items'].includes(req.table)) req.resolve({ data: [], error: null })
  }
  await app.pump()
  const before = structuredClone({ meals: app.state.weeklyMeals, shopping: app.state.shoppingList, locks: app.state.lockedDays })
  app.state.generateWeeklyMeals(); app.flush()
  assert.ok(shortageText(app).includes('Dinnerlyst does not currently have recipes available to build the plan.'))
  assert.deepEqual({ meals: app.state.weeklyMeals, shopping: app.state.shoppingList, locks: app.state.lockedDays }, before)
  app.state.regenerateMeal('Monday'); app.flush()
  assert.ok(shortageText(app).includes('Dinner 1 is locked. Unlock it to choose another meal.'))
  assertPlannerCacheMatches(app)
})

test('Regenerate no-alternative and locked messages preserve meals; a successful replacement clears feedback', async () => {
  const a = eligibleMeal(1), b = eligibleMeal(2), unsuitable = bestRecipe(3, 'Unsuitable', ['Eggs'])
  const app = await bestApp({ library: [a,b,unsuitable], preferences: shortagePreferences,
    meals: [{ day: 'Monday', meal: a }, { day: 'Tuesday', meal: b }], locks: ['Monday'] })
  const before = structuredClone(app.state.weeklyMeals)
  app.state.regenerateMeal('Monday'); app.flush()
  assert.ok(shortageText(app).includes('Dinner 1 is locked. Unlock it to choose another meal.'))
  assert.deepEqual(app.state.weeklyMeals, before)
  app.state.regenerateMeal('Tuesday'); app.flush()
  assert.ok(shortageText(app).includes('No alternative recipe is available for Dinner 2 that matches your preferences and restrictions without repeating another planned meal. Your current meal was kept.'))
  assert.deepEqual(app.state.weeklyMeals, before)
  assertPlannerCacheMatches(app)
  const loading = app.state.getRecipes(); await app.pump()
  app.requests.filter(req => req.table === 'recipes' && req.method === 'select').at(-1).resolve({ data: [a,b,unsuitable,eligibleMeal(4)], error: null })
  await loading; await app.pump()
  app.state.regenerateMeal('Tuesday'); app.flush()
  assert.equal(app.state.weeklyMeals[1].meal.id, 4)
  assert.equal(app.state.weeklyMeals[0].meal.id, 1)
  assert.deepEqual(app.state.lockedDays, ['Monday'])
  assert.equal(shortageText(app), '')
  assertPlannerCacheMatches(app)
})

test('generator feedback is cleared on account transitions and is not persisted in planner cache', async () => {
  const app = await bestApp({ library: [eligibleMeal(1)] })
  app.state.generateWeeklyMeals(); app.flush()
  assert.ok(shortageText(app).includes('Could not fill all 4 dinners'))
  assert.equal(Object.hasOwn(JSON.parse(app.storage.getItem(account.plannerCacheKey('A'))), 'planFeedback'), false)
  await app.ready('B')
  assert.equal(shortageText(app), '')
  await app.ready('A')
  assert.equal(shortageText(app), '')
})

test('a locked empty day is preserved and explained rather than claiming new meals were validated or recipes insufficient', async () => {
  const app = await bestApp({ library: Array.from({length:7}, (_, at) => eligibleMeal(at + 1)),
    preferences: shortagePreferences, meals: [{ day: 'Monday', meal: null }], locks: ['Monday'] })
  app.state.generateWeeklyMeals(); app.flush()
  assert.equal(app.state.weeklyMeals[0].meal, null)
  assert.equal(app.state.weeklyMeals.length, 1)
  assert.ok(shortageText(app).includes('unlock an empty dinner'))
  assertPlannerCacheMatches(app)
})

test('adding a recommendation clears shortage feedback and preserves extras and pantry exclusions', async () => {
  const rice=eligibleMeal(1),eggs=bestRecipe(2,'Egg supper',['Eggs'],['Vegan','Peanut-Free'])
  const app=await bestApp({library:[rice,eggs],pantryNames:['Eggs'],preferences:shortagePreferences,shoppingList:{Other:[{key:'paper towels',label:'paper towels',extra:true}]}})
  app.state.generateWeeklyMeals();app.flush();assert.ok(shortageText(app))
  assert.equal(app.state.weeklyMeals.length,0)
  bestButton(app,'Add as Dinner').props.onClick();app.flush()
  assert.equal(app.state.weeklyMeals.length,1);assert.equal(app.state.weeklyMeals[0].meal.id,eggs.id)
  assert.equal(shortageText(app),'')
  const visible=Object.values(app.state.shoppingList).flat().filter(shopping.isShoppingItemVisible)
  assert.deepEqual(visible.map(item=>item.label),['paper towels'])
  assertPlannerCacheMatches(app)
})

test('every refused Cook Tonight guard preserves the plan, shopping, locks, cache and existing feedback', async () => {
  for (const reason of ['locked', 'already tonight', 'other day', 'incompatible', 'missing day', 'unavailable recipe', 'no recipe']) {
    const todayMeal = eligibleMeal(1), candidate = eligibleMeal(2)
    const incompatible = bestRecipe(3, 'Incompatible meal', ['Eggs'])
    const meals = reason === 'missing day' ? [{ day: 'Monday', meal: todayMeal }]
      : [{ day: 'Thursday', meal: todayMeal }, ...(reason === 'other day' ? [{ day: 'Monday', meal: candidate }] : [])]
    const app = await bestApp({ library: [todayMeal, candidate, incompatible], preferences: shortagePreferences,
      meals, locks: ['Sunday', ...(reason === 'locked' ? ['Thursday'] : [])] })
    app.state.regenerateMeal('Sunday'); app.flush()
    const feedback = shortageText(app)
    assert.ok(feedback.includes('Dinner is locked.'))
    const before = structuredClone({ meals: app.state.weeklyMeals, shopping: app.state.shoppingList, locks: app.state.lockedDays })
    const requested = reason === 'already tonight' ? todayMeal : reason === 'incompatible' ? incompatible
      : reason === 'unavailable recipe' ? { ...candidate, id: 999 } : reason === 'no recipe' ? null : candidate
    app.state.cookTonight(requested, 'Thursday'); app.flush()
    assert.deepEqual({ meals: app.state.weeklyMeals, shopping: app.state.shoppingList, locks: app.state.lockedDays }, before, reason)
    assert.equal(shortageText(app), feedback, reason)
    if (reason !== 'no recipe') assert.ok(app.alerts.length > 0, reason)
    assertPlannerCacheMatches(app)
  }
})

const deletionFixture = (id, name, rows) => ({ ...editFixture(id, name), structured_ingredients: rows })
function deletionSnapshot(app) {
  return structuredClone({ recipes: app.state.recipes, meals: app.state.weeklyMeals, shopping: app.state.shoppingList,
    locks: app.state.lockedDays, checks: app.state.checkedShoppingItems, viewing: app.state.viewingRecipe,
    expanded: app.state.expandedRecipeId, feedback: shortageText(app), cache: app.storage.getItem(account.plannerCacheKey(app.state.session.user.id)) })
}
async function resolveDeletion(app, deleting, id, error = null, returned = [{ id }]) {
  app.requests.filter(req => req.table === 'recipes' && req.method === 'delete' && req.constraints.id === id).at(-1).resolve({ data: returned, error })
  await deleting; await app.pump()
}
async function checkShoppingLabel(app, text) {
  const row = app.nodes().find(node => node.props?.className === 'shopping-item' && nodeText(node).includes(text))
  assert.ok(row, text)
  const checking = app.nodes(row).find(node => node.props?.type === 'checkbox').props.onChange({ target: { checked: true } })
  await app.pump()
  app.requests.filter(req => req.table === 'checked_shopping_items' && req.method === 'insert').at(-1).resolve({ error: null })
  await checking; await app.pump()
}

test('successful deletion cleans one/multiple assignments and locks, recalculates shared ingredients, and persists without resurrection', async () => {
  for (const days of [['Monday'], ['Monday', 'Tuesday']]) {
    const removed = deletionFixture(101, 'Delete rice recipe', [{ amount: '1', unit: 'cup', ingredient: 'Rice' }, { amount: '1', unit: 'tsp', ingredient: 'Salt' }])
    const remaining = deletionFixture(102, 'Keep rice recipe', [{ amount: '2', unit: 'cup', ingredient: 'Rice' }, { amount: '1', unit: 'tbsp', ingredient: 'Oil' }])
    const app = await bestApp({ library: [removed, remaining], pantryNames: ['Salt'],
      meals: [...days.map(day => ({ day, meal: removed })), { day: 'Thursday', meal: remaining }], locks: ['Monday', 'Thursday'],
      shoppingList: { Other: [{ key: 'paper towels', label: 'paper towels', extra: true }] } })
    clickButton(app, '🛒 Shop'); await checkShoppingLabel(app, '1 tbsp oil'); await checkShoppingLabel(app, 'paper towels')
    const checks = [...app.state.checkedShoppingItems]
    const preserved = structuredClone(app.state.weeklyMeals.find(item => item.day === 'Thursday'))
    clickButton(app, '🍽 Plan')
    app.state.regenerateMeal('Monday'); app.flush()
    assert.ok(shortageText(app).includes('Dinner 1 is locked.'))
    clickButton(app, '📖 Recipes')
    const card = app.nodes().find(node => node.props?.className === 'recipe-card' && nodeText(node).includes(removed.name))
    app.nodes(card).find(node => node.type === 'button' && nodeText(node) === 'View Recipe').props.onClick(); app.flush()
    const deleting = app.state.deleteRecipe(101); await app.pump()
    assert.ok(app.confirmations.at(-1).includes(`your plan for ${days.map(day => `Dinner ${app.state.weeklyMeals.findIndex(item => item.day === day) + 1}`).join(', ')}`))
    clickButton(app, '🍽 Plan'); clickButton(app, removed.name)
    assert.equal(app.state.viewingRecipe.id, 101)
    await resolveDeletion(app, deleting, 101)
    for (const day of days) assert.equal(app.state.weeklyMeals.find(item => item.day === day).meal, null)
    assert.deepEqual(app.state.weeklyMeals.find(item => item.day === 'Thursday'), preserved)
    assert.deepEqual(app.state.lockedDays, ['Thursday'])
    assert.deepEqual(app.state.recipes.map(item => item.id), [102])
    assert.equal(app.state.viewingRecipe, null)
    assert.equal(app.state.expandedRecipeId, null)
    assert.equal(detailModals(app).length, 0)
    assert.ok(shortageText(app).includes('was removed from'))
    assert.equal(shortageText(app).includes('Dinner 1 is locked.'), false)
    const visible = Object.values(app.state.shoppingList).flat().filter(item => !item.pantryHidden)
    assert.deepEqual(visible.map(item => item.label).sort(), ['2 cup rice', '1 tbsp oil', 'paper towels'].sort())
    assert.deepEqual(app.state.checkedShoppingItems, checks)
    assert.equal(shopping.isShoppingItemChecked(visible.find(item => item.label === '1 tbsp oil'), checks), true)
    assert.equal(shopping.isShoppingItemChecked(visible.find(item => item.label === 'paper towels'), checks), true)
    assertPlannerCacheMatches(app)
    const reloaded = appHarness(app.storage); await reloaded.ready('A', [remaining], {}, ['Salt'])
    assert.equal(reloaded.state.weeklyMeals.some(item => item.meal?.id === 101), false)
    assert.deepEqual(reloaded.state.lockedDays, ['Thursday'])
    assertPlannerCacheMatches(reloaded)
  }
})

test('deletion cancellation, errors and zero-row responses leave all recipe/planner/shopping/detail/cache state untouched', async () => {
  for (const outcome of ['cancel', 'error', 'zero rows']) {
    const removed = editFixture(101)
    const app = await bestApp({ library: [removed], meals: [{ day: 'Monday', meal: removed }], locks: ['Monday'] })
    clickButton(app, removed.name)
    app.state.regenerateMeal('Monday'); app.flush()
    const before = deletionSnapshot(app)
    if (outcome === 'cancel') app.setConfirm(false)
    const deleting = app.state.deleteRecipe(101); await app.pump()
    if (outcome === 'cancel') {
      await deleting; assert.equal(app.requests.some(req => req.method === 'delete'), false)
    } else await resolveDeletion(app, deleting, 101, outcome === 'error' ? { message: 'Delete denied' } : null, [])
    assert.deepEqual(deletionSnapshot(app), before, outcome)
    if (outcome !== 'cancel') assert.ok(app.alerts.length > 0)
  }
})

test('delayed deletion success cleans current assignments only, preserving newer Cook Tonight edits, locks and shopping extras', async () => {
  const removed = bestRecipe(101, 'Delete rice', ['Rice'])
  const remaining = bestRecipe(102, 'Keep milk', ['Milk'])
  const replacement = bestRecipe(103, 'New eggs', ['Eggs'])
  const closeMatch = bestRecipe(104, 'Egg bread', ['Eggs', 'Bread'])
  const app = await bestApp({ library: [removed, remaining, replacement, closeMatch], pantryNames: ['Eggs'],
    meals: [{ day: 'Monday', meal: removed }, { day: 'Tuesday', meal: remaining }, { day: 'Thursday', meal: removed }], locks: ['Monday', 'Tuesday'] })
  const deleting = app.state.deleteRecipe(101); await app.pump()
  assert.ok(app.confirmations.at(-1).includes('Dinner 1, Dinner 3'))
  app.state.cookTonight(replacement, 'Thursday'); app.flush()
  assert.equal(app.state.weeklyMeals.find(item => item.day === 'Thursday').meal.id, 103)
  const thursdayCard = app.nodes().find(node => node.props?.className?.startsWith('meal-card') && nodeText(node).includes('Dinner 3'))
  app.nodes(thursdayCard).find(node => node.type === 'button' && nodeText(node) === 'Lock').props.onClick(); app.flush()
  clickButton(app, '🥫 Pantry')
  const card = app.nodes().find(node => node.props?.className === 'pantry-match-card' && nodeText(node).includes('Egg bread'))
  app.nodes(card).find(node => node.type === 'button' && nodeText(node).includes('Add Missing')).props.onClick({ stopPropagation() {} }); app.flush()
  await resolveDeletion(app, deleting, 101)
  assert.equal(app.state.weeklyMeals.find(item => item.day === 'Monday').meal, null)
  assert.equal(app.state.weeklyMeals.find(item => item.day === 'Tuesday').meal.id, 102)
  assert.equal(app.state.weeklyMeals.find(item => item.day === 'Thursday').meal.id, 103)
  assert.deepEqual([...app.state.lockedDays].sort(), ['Tuesday', 'Thursday'].sort())
  const visible = Object.values(app.state.shoppingList).flat().filter(item => !item.pantryHidden)
  assert.ok(visible.some(item => item.label === 'Bread' && item.extra))
  assert.equal(visible.some(item => item.label.toLowerCase().includes('rice')), false)
  assert.equal(visible.some(item => item.label.toLowerCase().includes('eggs')), false)
  assert.ok(visible.some(item => item.label.toLowerCase().includes('milk')))
  assertPlannerCacheMatches(app)
})

test('stale-account successful deletion cannot clean the current account planner or cache', async () => {
  const removed = editFixture(101)
  const app = await bestApp({ library: [removed], meals: [{ day: 'Monday', meal: removed }], locks: ['Monday'] })
  const deleting = app.state.deleteRecipe(101); await app.pump()
  const bOwner = { userId: 'B', generation: 1 }
  account.persistPlannerCache(app.storage, bOwner, bOwner, { weeklyMeals: [{ day: 'Monday', meal: { ...removed, user_id: 'B' } }], shoppingList: {}, lockedDays: ['Monday'] })
  await app.ready('B', [{ ...removed, user_id: 'B' }])
  const before = deletionSnapshot(app)
  await resolveDeletion(app, deleting, 101)
  assert.deepEqual(deletionSnapshot(app), before)
})

test('two delayed successful deletions reconcile from the latest plan without resurrecting either recipe', async () => {
  const a = editFixture(101), b = editFixture(102)
  const app = await bestApp({ library: [a,b], meals: [{ day: 'Monday', meal: a }, { day: 'Tuesday', meal: b }], locks: ['Monday', 'Tuesday'] })
  const first = app.state.deleteRecipe(101), second = app.state.deleteRecipe(102); await app.pump()
  for (const req of app.requests.filter(req => req.method === 'delete')) req.resolve({ data: [{ id: req.constraints.id }], error: null })
  await Promise.all([first, second]); await app.pump()
  assert.deepEqual(app.state.weeklyMeals.map(item => item.meal), [null, null])
  assert.deepEqual(app.state.lockedDays, [])
  assert.deepEqual(app.state.recipes, [])
  assert.equal(Object.values(app.state.shoppingList).flat().filter(item => !item.pantryHidden).length, 0)
  assertPlannerCacheMatches(app)
})

async function assertEligibilityAcrossPlanningPaths(candidate, preferences, eligible) {
  const old = bestRecipe(800, 'Existing meal', ['Rice'])
  const app = await bestApp({ library: [old, candidate], preferences,
    meals: [{ day: 'Thursday', meal: old }], pantryNames: ['Eggs'] })
  assert.equal(Boolean(bestButton(app, 'Add as Dinner')), eligible, 'Best Match eligibility')
  app.state.cookTonight(candidate, 'Thursday'); app.flush()
  assert.equal(app.state.weeklyMeals[0].meal.id, eligible ? candidate.id : old.id, 'Cook Tonight guard')
  const cached = account.loadPlannerCache(app.storage, 'A')
  assert.deepEqual(cached.weeklyMeals, app.state.weeklyMeals)
  assert.deepEqual(cached.shoppingList, app.state.shoppingList)

  const swap = await bestApp({ library: [old, candidate], preferences,
    meals: [{ day: 'Thursday', meal: old }], pantryNames: ['Eggs'] })
  swap.state.regenerateMeal('Thursday'); swap.flush()
  assert.equal(swap.state.weeklyMeals[0].meal.id, eligible ? candidate.id : old.id, 'Regenerate eligibility')
  const generation = await bestApp({ library: [candidate], preferences, pantryNames: ['Eggs'] })
  generation.state.changeDinnerCount(1); generation.flush()
  generation.state.generateWeeklyMeals(); generation.flush()
  assert.equal(generation.state.weeklyMeals.some(item => item.meal?.id === candidate.id), eligible, 'Generate eligibility')
  const generatedCache = account.loadPlannerCache(generation.storage, 'A')
  assert.deepEqual(generatedCache.weeklyMeals, generation.state.weeklyMeals)
  assert.deepEqual(generatedCache.shoppingList, generation.state.shoppingList)
}

test('owned recipes may omit each soft lifestyle tag across all four planning paths', async () => {
  const candidate = { ...bestRecipe(801, 'Personal supper', ['Eggs']), user_id: 'A' }
  for (const diet_preferences of [[], ['High Protein'], ['Anti-Inflammatory'], ['Low Carb'], ['Keto'], ['Mediterranean'], ['High Protein', 'Mediterranean']]) {
    await assertEligibilityAcrossPlanningPaths(candidate, { diet_preferences }, true)
  }
})

test('hard dietary requirements and every restriction remain mandatory for owned and shared recipes', async () => {
  for (const user_id of ['A', null]) {
    for (const tag of ['Vegetarian', 'Vegan', ...supportedRestrictions]) {
      const candidate = { ...bestRecipe(801, 'Compatible supper', ['Eggs']), user_id }
      // Dietary requirements stay hard even when Gluten-Free is selected here.
      await assertEligibilityAcrossPlanningPaths(candidate, { diet_preferences: [tag] }, false)
      await assertEligibilityAcrossPlanningPaths({ ...candidate, diet_tags: [tag] }, { diet_preferences: [tag] }, true)
      if (supportedRestrictions.includes(tag)) {
        await assertEligibilityAcrossPlanningPaths(candidate, { allergies: [tag] }, false)
        await assertEligibilityAcrossPlanningPaths({ ...candidate, diet_tags: [tag] }, { allergies: [tag] }, true)
      }
    }
  }
})

test('shared recipes still require soft tags while personal recipes still require all combined hard tags', async () => {
  for (const tag of ['High Protein', 'Anti-Inflammatory', 'Low Carb', 'Keto', 'Mediterranean']) {
    const candidate = { ...bestRecipe(801, 'Shared supper', ['Eggs']), user_id: null }
    await assertEligibilityAcrossPlanningPaths(candidate, { diet_preferences: [tag] }, false)
    await assertEligibilityAcrossPlanningPaths({ ...candidate, diet_tags: [tag] }, { diet_preferences: [tag] }, true)
  }
  const hard = ['Vegan', 'Gluten-Free', 'Dairy-Free', 'Peanut-Free']
  const preferences = { diet_preferences: ['High Protein', 'Vegan', 'Gluten-Free'], allergies: ['Dairy-Free', 'Peanut-Free'] }
  const candidate = { ...bestRecipe(801, 'Personal supper', ['Eggs'], hard), user_id: 'A' }
  await assertEligibilityAcrossPlanningPaths(candidate, preferences, true)
  for (const missing of hard) {
    await assertEligibilityAcrossPlanningPaths({ ...candidate, diet_tags: hard.filter(tag => tag !== missing) }, preferences, false)
  }
})

const latestRequest = (app, table, method = 'select') => app.requests.filter(req => req.table === table && req.method === method).at(-1)
async function failedInitialLoads(tables) {
  const app = appHarness(); app.emit('A'); await app.pump()
  for (const req of app.requests.filter(req => ['recipes', 'pantry_items', 'checked_shopping_items', 'user_preferences'].includes(req.table))) {
    req.resolve(tables.includes(req.table) ? { data: null, error: { message: 'Offline' } } :
      { data: req.table === 'user_preferences' ? { household_size: 2 } : [], error: null })
  }
  await app.pump()
  return app
}

test('recipe loading failure is not an empty library; Retry distinguishes a genuinely empty response', async () => {
  const app = await failedInitialLoads(['recipes'])
  clickButton(app, '📖 Recipes')
  assert.ok(nodeText(app.nodes()).includes('Could not load recipes'))
  assert.equal(nodeText(app.nodes()).includes('No recipes yet.'), false)
  assert.equal(nodeText(app.nodes()).includes('No recipes found.'), false)
  clickButton(app, 'Retry loading recipes'); await app.pump()
  assert.ok(nodeText(app.nodes()).includes('Loading recipes…'))
  latestRequest(app, 'recipes').resolve({ data: [], error: null }); await app.pump()
  assert.ok(nodeText(app.nodes()).includes('No recipes yet.'))
  assert.equal(nodeText(app.nodes()).includes('Could not load recipes'), false)
})

test('failed recipe refresh retains the library and a confirmed save is not reported as failed', async () => {
  const app = appHarness(); await app.ready('A', [editFixture(101)])
  clickButton(app, '📖 Recipes'); app.state.beginRecipeEdit(app.state.recipes[0]); app.flush()
  const saving = app.state.addRecipe(); await app.pump()
  latestRequest(app, 'recipes', 'update').resolve({ data: [editFixture(101)], error: null }); await app.pump()
  latestRequest(app, 'recipes').resolve({ data: null, error: { message: 'Offline' } }); await saving; await app.pump()
  assert.equal(app.alerts.length, 0)
  assert.equal(app.reloads, 0)
  assert.equal(app.state.recipes[0].id, 101)
  assert.ok(nodeText(app.nodes()).includes('Your recipe was saved, but the recipe list could not refresh.'))
  assertCleanDraft(app)
  clickButton(app, 'Retry loading recipes'); await app.pump()
  latestRequest(app, 'recipes').resolve({ data: [editFixture(101)], error: null }); await app.pump()
  assert.equal(app.state.recipeLoad, 'ready')
})

test('Pantry load failures are visible and retryable without claiming an empty Pantry', async () => {
  const app = await failedInitialLoads(['pantry_items']); clickButton(app, '🥫 Pantry')
  assert.ok(nodeText(app.nodes()).includes('Could not load your Pantry.'))
  assert.equal(nodeText(app.nodes()).includes('Your pantry is empty.'), false)
  assert.equal(app.nodes().find(node => node.props?.className === 'pantry-add-button').props.disabled, true)
  clickButton(app, 'Retry Pantry'); await app.pump()
  latestRequest(app, 'pantry_items').resolve({ data: [{ item_name: 'Rice' }], error: null }); await app.pump()
  assert.deepEqual(app.state.pantryItems, ['Rice'])
  assert.equal(app.state.pantryLoad, 'ready')
})

test('Pantry failed writes preserve input/items; a synchronous lock prevents races and retries preserve unrelated items', async () => {
  const app = appHarness(); await app.ready('A', [], {}, ['Milk']); clickButton(app, '🥫 Pantry')
  app.nodes().find(node => node.props?.id === 'pantry-ingredient').props.onChange({ target: { value: 'Rice' } }); app.flush()
  const adding = app.state.changePantryItem('Rice', false, true)
  await app.state.changePantryItem('Eggs'); await app.pump()
  assert.equal(app.requests.filter(req => req.table === 'pantry_items' && req.method === 'insert').length, 1)
  latestRequest(app, 'pantry_items', 'insert').reject(new Error('Offline')); await adding; await app.pump()
  assert.equal(app.state.pantrySearch, 'Rice')
  assert.deepEqual(app.state.pantryItems, ['Milk'])
  assert.ok(nodeText(app.nodes()).includes('Could not add that ingredient.'))
  const retry = app.state.changePantryItem('Rice', false, true); await app.pump()
  latestRequest(app, 'pantry_items', 'insert').resolve({ error: null }); await retry; await app.pump()
  assert.deepEqual(app.state.pantryItems, ['Milk', 'Rice'])
  assert.equal(app.state.pantrySearch, '')
  const removing = app.state.changePantryItem('Milk', true); await app.pump()
  latestRequest(app, 'pantry_items', 'delete').resolve({ error: { message: 'Denied' } }); await removing; await app.pump()
  assert.deepEqual(app.state.pantryItems, ['Milk', 'Rice'])
  assert.ok(nodeText(app.nodes()).includes('Could not remove that ingredient.'))
  const removed = app.state.changePantryItem('Milk', true); await app.pump()
  latestRequest(app, 'pantry_items', 'delete').resolve({ error: null }); await removed; await app.pump()
  assert.deepEqual(app.state.pantryItems, ['Rice'])
})

test('checked-state load failure disables checks and offers Retry without treating remote state as known', async () => {
  const app = await failedInitialLoads(['checked_shopping_items']); clickButton(app, '🛒 Shop')
  assert.ok(nodeText(app.nodes()).includes('Could not load checked items.'))
  const before = app.requests.length
  await app.state.changeShoppingCheck('Rice', true)
  assert.equal(app.requests.length, before)
  clickButton(app, 'Retry checked items'); await app.pump()
  latestRequest(app, 'checked_shopping_items').resolve({ data: [{ item_name: 'rice' }], error: null }); await app.pump()
  assert.equal(app.state.checkedLoad, 'ready')
  assert.deepEqual(app.state.checkedShoppingItems, ['rice'])
})

test('check writes have per-item pending protection, visible failures and retry', async () => {
  const app = appHarness(); await app.ready('A'); clickButton(app, '🛒 Shop')
  const first = app.state.changeShoppingCheck('Rice', true)
  await app.state.changeShoppingCheck('Rice', false); await app.pump()
  assert.equal(app.requests.filter(req => req.table === 'checked_shopping_items' && req.method !== 'select').length, 1)
  latestRequest(app, 'checked_shopping_items', 'insert').resolve({ error: { message: 'Offline' } }); await first; await app.pump()
  assert.deepEqual(app.state.checkedShoppingItems, [])
  assert.ok(nodeText(app.nodes()).includes('Could not save that check.'))
  const retry = app.state.changeShoppingCheck('Rice', true); await app.pump()
  latestRequest(app, 'checked_shopping_items', 'insert').resolve({ error: null }); await retry; await app.pump()
  assert.deepEqual(app.state.checkedShoppingItems, [shopping.asShoppingItem('Rice').key])
})

test('partial uncheck failure reloads authoritative aliases; failed reconciliation remains visibly retryable', async () => {
  for (const reconcileFails of [false, true]) {
    const app = appHarness(); await app.ready('A'); clickButton(app, '🛒 Shop')
    const ingredient = { key: 'canonical', label: 'Rice', extra: true, legacyGroups: [['old rice']] }
    const unchecking = app.state.changeShoppingCheck(ingredient, false); await app.pump()
    latestRequest(app, 'checked_shopping_items', 'delete').resolve({ error: null }); await app.pump()
    assert.equal(latestRequest(app, 'checked_shopping_items', 'delete').constraints.item_name, 'old rice')
    latestRequest(app, 'checked_shopping_items', 'delete').resolve({ error: { message: 'Offline' } }); await app.pump()
    assert.equal(app.state.checkedLoad, 'loading')
    latestRequest(app, 'checked_shopping_items').resolve(reconcileFails ? { data: null, error: { message: 'Offline' } } : { data: [{ item_name: 'old rice' }], error: null })
    await unchecking; await app.pump()
    assert.equal(app.state.checkedLoad, reconcileFails ? 'error' : 'ready')
    assert.ok(app.nodes().some(node => node.props?.role === 'alert'))
    if (!reconcileFails) assert.deepEqual(app.state.checkedShoppingItems, ['old rice'])
  }
})

test('pending import disables conflicting browser editing, exposes Importing, and unlocks preserved draft after failure', async () => {
  const app = appHarness(); await app.ready('A', [editFixture(101)]); clickButton(app, '📖 Recipes')
  app.state.beginRecipeEdit(app.state.recipes[0]); app.flush(); enterImportUrl(app)
  const before = draftSnapshot(app)
  const importing = app.state.importRecipeFromUrl(); await app.pump()
  assert.equal(app.nodes().find(node => node.type === 'fieldset').props.disabled, true)
  assert.ok(nodeText(app.nodes()).includes('Importing…'))
  clickButton(app, '📖 Recipes')
  assert.equal(app.nodes().find(node => node.type === 'button' && nodeText(node) === '✏️ Edit').props.disabled, true)
  clickButton(app, '➕ Add Recipe')
  latestRequest(app, 'import', 'import').reject(new Error('Offline')); await importing; await app.pump()
  assert.deepEqual(draftSnapshot(app), before)
  assert.equal(app.nodes().find(node => node.type === 'fieldset').props.disabled, false)
  assert.ok(app.alerts.at(-1).includes('Could not import'))
})

test('late load errors and import completions cannot leak failure status into another account', async () => {
  const app = appHarness(); await app.ready('A'); clickButton(app, '📖 Recipes'); enterImportUrl(app)
  const importing = app.state.importRecipeFromUrl(); await app.pump()
  const response = latestRequest(app, 'import', 'import')
  const loading = app.state.getRecipes(); await app.pump(); const load = latestRequest(app, 'recipes')
  await app.ready('B')
  response.resolve({ data: null, error: { message: 'A failure' } }); load.resolve({ data: null, error: { message: 'A failure' } })
  await Promise.all([importing, loading]); await app.pump()
  assert.equal(app.state.recipeLoad, 'ready'); assert.equal(app.state.importing, false)
  assert.equal(app.alerts.length, 0)
})

test('older same-account recipe loads cannot replace a newer response or reintroduce a load error', async () => {
  const app = appHarness(); await app.ready('A')
  const first = app.state.getRecipes(); await app.pump(); const older = latestRequest(app, 'recipes')
  const next = app.state.getRecipes(); await app.pump(); const newer = latestRequest(app, 'recipes')
  newer.resolve({ data: [recipe(991)], error: null }); await next; await app.pump()
  older.resolve({ data: null, error: { message: 'Old error' } }); await first; await app.pump()
  assert.equal(app.state.recipeLoad, 'ready')
  assert.deepEqual(app.state.recipes.map(item => item.id), [991])
})

test('partial uncheck reconciliation waits for other item writes and preserves their successful checked state', async () => {
  const app = appHarness(); await app.ready('A')
  const unchecking = app.state.changeShoppingCheck({ key: 'canonical', label: 'Rice', legacyGroups: [['old rice']] }, false)
  const checking = app.state.changeShoppingCheck('Milk', true); await app.pump()
  const selectsBefore = app.requests.filter(req => req.table === 'checked_shopping_items' && req.method === 'select').length
  latestRequest(app, 'checked_shopping_items', 'delete').resolve({ error: { message: 'Offline' } }); await app.pump()
  assert.equal(app.requests.filter(req => req.table === 'checked_shopping_items' && req.method === 'select').length, selectsBefore)
  latestRequest(app, 'checked_shopping_items', 'insert').resolve({ error: null }); await app.pump()
  const milk = shopping.asShoppingItem('Milk').key
  latestRequest(app, 'checked_shopping_items').resolve({ data: [{ item_name: milk }, { item_name: 'old rice' }], error: null })
  await Promise.all([unchecking, checking]); await app.pump()
  assert.deepEqual(app.state.checkedShoppingItems, [milk, 'old rice'])
})

test('client import uses a longer bounded timeout and preserves the draft when the invocation times out', async () => {
  const app = appHarness(); await app.ready('A', [editFixture(101)]); clickButton(app, '📖 Recipes')
  app.state.beginRecipeEdit(app.state.recipes[0]); app.flush(); enterImportUrl(app)
  const before = draftSnapshot(app)
  const importing = app.state.importRecipeFromUrl(); await app.pump()
  const invocation = latestRequest(app, 'import', 'import')
  assert.equal(invocation.options.timeout, 80_000)
  assert.equal(app.state.importing, true)
  invocation.resolve({ data: null, error: { message: 'Function timed out' } })
  await importing; await app.pump()
  assert.deepEqual(draftSnapshot(app), before)
  assert.equal(app.state.importing, false)
  assert.equal(app.nodes().find(node => node.type === 'fieldset').props.disabled, false)
  assert.equal(app.alerts.at(-1), 'Could not import that recipe.')
})

const invitedUser = { invited_at: '2026-10-01T00:00:00Z', user_metadata: { favorite_color: 'green' } }
const passwordHeading = app => app.nodes().some(node => node.type === 'h1' && nodeText(node) === 'Set Your Password')
function enterSetupPasswords(app, password = 'Beta-password-123', confirmation = password) {
  app.nodes().find(node => node.props?.id === 'setup-password').props.onChange({ target: { value: password } })
  app.nodes().find(node => node.props?.id === 'setup-confirm-password').props.onChange({ target: { value: confirmation } })
  app.flush()
}
function submitSetupPassword(app) {
  return app.nodes().find(node => node.type === 'form').props.onSubmit({ preventDefault() {} })
}
const completedInvite = id => ({ id, ...invitedUser, user_metadata: { ...invitedUser.user_metadata, password_setup_complete: true } })

test('invited users see password setup before preference loading or onboarding, including after refresh', async () => {
  const app = appHarness()
  app.emit('A', true, invitedUser)
  assert.equal(passwordHeading(app), true, 'gate renders on the first authenticated render')
  assert.equal(app.nodes().some(node => node.type === 'button' && nodeText(node).includes('Continue')), false)
  await app.pump()
  for (const req of app.requests.filter(req => ['recipes', 'pantry_items', 'checked_shopping_items', 'user_preferences'].includes(req.table))) {
    req.resolve({ data: req.table === 'user_preferences' ? null : [], error: null })
  }
  await app.pump()
  assert.equal(app.state.onboardingStep, 1)
  assert.equal(passwordHeading(app), true)
  const reloaded = appHarness(app.storage)
  await reloaded.ready('A', [], null, [], invitedUser)
  assert.equal(passwordHeading(reloaded), true, 'URL intent or browser-local completion is not needed to enforce the gate')
})

test('invalid/mismatched passwords show inline errors without writes or clearing the gate', async () => {
  const app = appHarness(); await app.ready('A', [], null, [], invitedUser)
  for (const [password, confirmation, message] of [['short', 'short', 'at least 8'], ['', '', 'at least 8'], ['Beta-password-123', 'Different-password', 'do not match']]) {
    enterSetupPasswords(app, password, confirmation)
    await submitSetupPassword(app); await app.pump()
    assert.equal(passwordHeading(app), true)
    assert.ok(app.nodes().some(node => node.props?.role === 'alert' && nodeText(node).includes(message)))
  }
  assert.equal(app.requests.some(req => req.method === 'updateUser'), false)
})

test('password update failures preserve fields and the gate, unlock retry, and never advance onboarding', async () => {
  for (const rejection of [false, true]) {
    const app = appHarness(); await app.ready('A', [], null, [], invitedUser)
    enterSetupPasswords(app)
    const saving = submitSetupPassword(app); await app.pump()
    const request = latestRequest(app, 'auth', 'updateUser')
    if (rejection) request.reject(new Error('Network unavailable'))
    else request.resolve({ data: { user: null }, error: { message: 'Password does not meet the project password policy.' } })
    await saving; await app.pump()
    assert.equal(passwordHeading(app), true)
    assert.equal(app.state.newPassword, 'Beta-password-123')
    assert.equal(app.state.confirmPassword, 'Beta-password-123')
    assert.equal(app.state.onboardingStep, 1)
    assert.equal(app.nodes().find(node => node.type === 'button' && nodeText(node) === 'Set Password').props.disabled, false)
    assert.ok(app.nodes().some(node => node.props?.role === 'alert'))
  }
})

test('successful password setup atomically submits password/marker, blocks overlaps, and continues to onboarding', async () => {
  const app = appHarness(); await app.ready('A', [], null, [], invitedUser); enterSetupPasswords(app)
  const saving = submitSetupPassword(app)
  await app.state.completePasswordSetup(); await app.pump()
  assert.equal(app.requests.filter(req => req.method === 'updateUser').length, 1)
  assert.equal(app.nodes().find(node => node.type === 'button' && nodeText(node) === 'Saving...').props.disabled, true)
  assert.ok(nodeText(app.nodes()).includes('Saving your password…'))
  const request = latestRequest(app, 'auth', 'updateUser')
  assert.deepEqual(request.payload, { password: 'Beta-password-123', data: { password_setup_complete: true } })
  // Supabase emits USER_UPDATED before resolving updateUser; that event alone must not open the gate.
  app.emitSession('USER_UPDATED', { user: completedInvite('A') })
  assert.equal(passwordHeading(app), true)
  request.resolve({ data: { user: completedInvite('A') }, error: null }); await saving; await app.pump()
  assert.equal(passwordHeading(app), false)
  assert.equal(app.state.passwordSetupRequired, false)
  assert.equal(app.state.onboardingStep, 1)
  assert.equal(app.state.newPassword, '')
  assert.equal(app.state.confirmPassword, '')
  assert.equal(app.state.session.user.user_metadata.favorite_color, 'green')
  const refreshed = appHarness(app.storage)
  await refreshed.ready('A', [], null, [], completedInvite('A'))
  assert.equal(passwordHeading(refreshed), false)
})

test('ordinary login and completed invited users are not forced through password setup', async () => {
  for (const user of [{}, completedInvite('A')]) {
    const app = appHarness(); await app.ready('A', [], {}, [], user)
    assert.equal(passwordHeading(app), false)
    assert.equal(app.state.passwordSetupRequired, false)
    app.emitSession('TOKEN_REFRESHED', { user: { id: 'A', ...user } })
    assert.equal(passwordHeading(app), false)
  }
})

test('PASSWORD_RECOVERY opens setup even with a completion marker; normal refresh events cannot dismiss it', async () => {
  const app = appHarness(); await app.ready('A', [], {}, [], completedInvite('A'))
  app.emitSession('PASSWORD_RECOVERY', { user: completedInvite('A') })
  assert.equal(passwordHeading(app), true)
  app.emitSession('SIGNED_IN', { user: completedInvite('A') })
  app.emitSession('TOKEN_REFRESHED', { user: completedInvite('A') })
  assert.equal(passwordHeading(app), true)
  enterSetupPasswords(app)
  const saving = submitSetupPassword(app); await app.pump()
  latestRequest(app, 'auth', 'updateUser').resolve({ data: { user: completedInvite('A') }, error: null })
  await saving; await app.pump()
  assert.equal(passwordHeading(app), false)
  assert.equal(app.state.onboardingStep, 0)
})

test('captured recovery/invite intent gates a restored initial session before onboarding', async () => {
  for (const callbackType of ['invite', 'recovery']) {
    const app = appHarness(memoryStorage(), null, callbackType)
    app.resolveInitialSession({ data: { session: { user: { id: 'A' } } }, error: null })
    await app.pump()
    assert.equal(passwordHeading(app), true)
  }
})

test('stale password success/error and auth update events cannot change another account', async () => {
  for (const fails of [false, true]) {
    const app = appHarness(); await app.ready('A', [], null, [], invitedUser); enterSetupPasswords(app)
    const saving = submitSetupPassword(app); await app.pump()
    const request = latestRequest(app, 'auth', 'updateUser')
    await app.ready('B')
    const before = structuredClone({ session: app.state.session, meals: app.state.weeklyMeals, onboarding: app.state.onboardingStep })
    app.emitSession('USER_UPDATED', { user: completedInvite('A') })
    app.emitSession('TOKEN_REFRESHED', { user: completedInvite('A') })
    request.resolve(fails ? { data: { user: null }, error: { message: 'A error' } } : { data: { user: completedInvite('A') }, error: null })
    await saving; await app.pump()
    assert.deepEqual({ session: app.state.session, meals: app.state.weeklyMeals, onboarding: app.state.onboardingStep }, before)
    assert.equal(passwordHeading(app), false)
    assert.equal(app.state.passwordSetupStatus, null)
    assert.equal(app.state.newPassword, '')
  }
})

test('late initial-session restoration cannot replace a newer signed-in account or gate it', async () => {
  const app = appHarness(); await app.ready('B')
  app.resolveInitialSession({ data: { session: { user: { id: 'A', ...invitedUser } } }, error: null })
  await app.pump()
  assert.equal(app.state.session.user.id, 'B')
  assert.equal(passwordHeading(app), false)
})

test('callback intent is captured before SDK initialization without retaining invitation/recovery tokens', () => {
  const source = readFileSync(new URL('../src/supabase.js', import.meta.url), 'utf8').replace(/^import .*\n/gm, '').replaceAll('export const ', 'const ')
  for (const type of ['invite', 'recovery', 'signup']) {
    const fakeWindow = { location: { hash: `#access_token=DO_NOT_RETAIN&refresh_token=DO_NOT_RETAIN&type=${type}`, search: '' } }
    const result = new Function('createClient', 'window', source + '\nreturn { initialAuthCallbackType }')(
      () => { fakeWindow.location.hash = ''; return {} }, fakeWindow)
    assert.deepEqual(result, { initialAuthCallbackType: type === 'signup' ? null : type })
    assert.equal(JSON.stringify(result).includes('DO_NOT_RETAIN'), false)
  }
})

test('an unsuccessful callback with no session cannot force a later ordinary login through setup', async () => {
  const app = appHarness(memoryStorage(), null, 'recovery')
  app.resolveInitialSession({ data: { session: null }, error: null }); await app.pump()
  await app.ready('A')
  assert.equal(passwordHeading(app), false)
})

const resultsScrolls = app => app.scrollRequests.filter(request => nodeText(request.target).includes('Your Dinner Plan'))
const scrollTestDays = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']

test('changed full Generate scrolls the This Week target once, only after the results render', async () => {
  const app = appHarness(); await app.ready('A', Array.from({ length: 7 }, (_, index) => recipe(700 + index)))
  assert.equal(resultsScrolls(app).length, 0)
  app.state.generateWeeklyMeals()
  assert.equal(resultsScrolls(app).length, 0, 'no scroll before React commits the new plan')
  app.flush()
  assert.equal(resultsScrolls(app).length, 1)
  const request = resultsScrolls(app)[0]
  assert.equal(request.target.props.className, 'section-header')
  assert.equal(app.nodes(request.target).find(node => node.type === 'h2').props.children[0], 'Your Dinner Plan')
  assert.deepEqual(request.options, { behavior: 'smooth', block: 'start' })
  assert.equal(request.renderedMeals.filter(item => item.meal).length, 4)
  assert.deepEqual(request.renderedMeals, app.state.weeklyMeals)
  assertPlannerCacheMatches(app)
  clickButton(app, '⚙️ Settings / Preferences'); clickButton(app, '🍽 Plan')
  assert.equal(resultsScrolls(app).length, 1, 'returning to Plan cannot replay a consumed request')
})

test('changed partial Generate scrolls and reduced-motion Generate requests non-smooth scrolling', async () => {
  for (const reducedMotion of [false, true]) {
    const app = appHarness(memoryStorage(), null, null, reducedMotion)
    await app.ready('A', [recipe(701)])
    app.state.changeDinnerCount(1); app.flush()
    app.state.generateWeeklyMeals(); app.flush()
    assert.equal(resultsScrolls(app).length, 1)
    assert.deepEqual(resultsScrolls(app)[0].options, { behavior: reducedMotion ? 'auto' : 'smooth', block: 'start' })
    assert.equal(app.state.weeklyMeals.filter(item => item.meal).length, 1)
    assert.equal(shortageText(app), '')
    assertPlannerCacheMatches(app)
  }
})

test('Generate never scrolls on an empty library, zero assignments, unchanged assignments, or all locked days', async () => {
  const candidate = recipe(701)
  for (const scenario of ['empty library', 'zero eligible', 'unchanged', 'locked']) {
    const storage = memoryStorage(), owner = { userId: 'A', generation: 1 }
    const meals = scrollTestDays.map((day, at) => ({ day, meal: at === 0 ? candidate : null }))
    const locks = scenario === 'locked' ? scrollTestDays : []
    account.persistPlannerCache(storage, owner, owner, { weeklyMeals: meals, shoppingList: {}, lockedDays: locks })
    const app = appHarness(storage)
    await app.ready('A', scenario === 'empty library' ? [] : [candidate], scenario === 'zero eligible' ? { allergies: ['Peanut-Free'] } : {})
    app.state.generateWeeklyMeals(); app.flush()
    assert.equal(resultsScrolls(app).length, 0, scenario)
    if (scenario === 'locked' || scenario === 'unchanged') assert.deepEqual(app.state.weeklyMeals.map(item => item.meal?.id ?? null), meals.map(item => item.meal?.id ?? null))
    if (scenario === 'zero eligible') assert.equal(app.state.weeklyMeals[0].meal.id, candidate.id, 'shortage preserves existing assignments')
    assertPlannerCacheMatches(app)
  }
})

test('Regenerate, Cook Tonight, cache restoration, recipe refresh and lock updates never request results scrolling', async () => {
  const old = bestRecipe(701, 'Rice meal', ['Rice']), other = bestRecipe(702, 'Egg meal', ['Eggs'])
  const app = await bestApp({ library: [old, other], meals: [{ day: 'Thursday', meal: old }], pantryNames: ['Eggs'] })
  assert.equal(resultsScrolls(app).length, 0, 'cache restoration')
  app.state.regenerateMeal('Thursday'); app.flush()
  assert.equal(app.state.weeklyMeals[0].meal.id, other.id)
  assert.equal(resultsScrolls(app).length, 0, 'Regenerate')
  app.state.cookTonight(old, 'Thursday'); app.flush()
  assert.equal(app.state.weeklyMeals[0].meal.id, old.id)
  assert.equal(resultsScrolls(app).length, 0, 'Cook Tonight')
  clickButton(app, 'Lock')
  assert.equal(resultsScrolls(app).length, 0, 'lock-only update')
  const loading = app.state.getRecipes(); await app.pump()
  latestRequest(app, 'recipes').resolve({ data: [old, other], error: null }); await loading; await app.pump()
  assert.equal(resultsScrolls(app).length, 0, 'recipe refresh')
  assertPlannerCacheMatches(app)
})

test('leaving Plan or changing accounts cancels an unconsumed Generate scroll request', async () => {
  const app = appHarness(); await app.ready('A', [recipe(701)])
  app.state.generateWeeklyMeals()
  clickButton(app, '⚙️ Settings / Preferences')
  assert.equal(resultsScrolls(app).length, 0)
  clickButton(app, '🍽 Plan')
  assert.equal(resultsScrolls(app).length, 0, 'no delayed scroll on returning')
  // Change the assignments so this second Generate would qualify for scrolling.
  const fresh = appHarness(); await fresh.ready('A', [recipe(702)])
  fresh.state.generateWeeklyMeals()
  fresh.emit('B')
  await fresh.pump()
  assert.equal(resultsScrolls(fresh).length, 0)
  await fresh.ready('C', [recipe(703)])
  assert.equal(resultsScrolls(fresh).length, 0, 'new accounts cannot inherit a scroll request')
})

const recipeBuilder = app => app.nodes().find(node => node.props?.className === 'card recipe-builder-section')
function enterNewRecipe(app, name = 'New supper') {
  clickButton(app, '➕ Add Recipe')
  app.nodes().find(node => node.props?.placeholder === 'Recipe name').props.onChange({ target: { value: name } })
  app.nodes().find(node => node.props?.placeholder === 'Ingredient name').props.onChange({ target: { value: 'Rice' } })
  app.flush()
}

test('five primary destinations keep one mounted builder exclusively visible in Add Recipe', async () => {
  const app = appHarness(); await app.ready('A', [editFixture(101)])
  const nav = app.nodes().find(node => node.type === 'nav' && node.props['aria-label'] === 'Main navigation')
  assert.deepEqual(app.nodes(nav).filter(node => node.type === 'button').map(nodeText), ['🍽 Plan', '📖 Recipes', '➕ Add Recipe', '🛒 Shop', '🥫 Pantry'])
  for (const [label, destination] of [['📖 Recipes', 'recipes'], ['➕ Add Recipe', 'add-recipe'], ['🛒 Shop', 'shopping'], ['🥫 Pantry', 'pantry'], ['🍽 Plan', 'planner']]) {
    clickButton(app, label)
    assert.equal(app.state.activeTab, destination)
    assert.equal(recipeBuilder(app).props.hidden, destination !== 'add-recipe')
    assert.equal(app.nodes().filter(node => node.props?.className === 'card recipe-builder-section').length, 1)
    assert.equal(app.nodes().filter(node => node.props?.placeholder === 'Paste recipe URL').length, 1)
    const currentNav = app.nodes().find(node => node.type === 'nav')
    assert.equal(app.nodes(currentNav).find(node => node.props?.['aria-current'] === 'page').props.children[0].trim(), label)
    assert.equal(app.nodes().some(node => node.props?.className === 'recipe-card'), destination === 'recipes')
  }
})

test('Add Recipe draft, URL and pending image survive navigation without remounting the file input', async () => {
  const app = appHarness(); await app.ready('A', [editFixture(101)])
  enterNewRecipe(app); enterImportUrl(app); selectPendingImage(app)
  const original = draftSnapshot(app)
  const fileKey = app.nodes().find(node => node.props?.type === 'file').props.key
  for (const label of ['📖 Recipes', '🍽 Plan', '🛒 Shop', '🥫 Pantry', '⚙️ Settings / Preferences', '➕ Add Recipe']) {
    clickButton(app, label)
    assert.deepEqual(draftSnapshot(app), original)
    assert.equal(app.nodes().find(node => node.props?.type === 'file').props.key, fileKey)
  }
  assert.equal(recipeBuilder(app).props.hidden, false)
})

test('owned Edit opens and scrolls the populated Add Recipe form; Cancel restores a clean Add form', async () => {
  const app = appHarness(); await app.ready('A', [editFixture(101, 'Owned supper')])
  clickButton(app, '📖 Recipes'); clickButton(app, '✏️ Edit')
  assert.equal(app.state.activeTab, 'add-recipe')
  assert.equal(app.state.editingRecipeId, 101)
  assert.equal(app.nodes(recipeBuilder(app)).find(node => node.type === 'h2').props.children[0], 'Edit Recipe')
  assert.equal(app.scrollRequests.at(-1).renderedName, 'Owned supper')
  const original = draftSnapshot(app)
  clickButton(app, '📖 Recipes'); clickButton(app, '➕ Add Recipe')
  assert.deepEqual(draftSnapshot(app), original)
  clickButton(app, 'Cancel Edit')
  assertCleanDraft(app)
  assert.equal(app.state.activeTab, 'add-recipe')
  assert.equal(app.nodes(recipeBuilder(app)).find(node => node.type === 'h2').props.children[0], 'Add a Recipe')
})

test('successful creation returns to an unfiltered Recipes library without reloading', async () => {
  const existing = editFixture(101, 'Existing supper'), saved = { ...recipe(102, 'New supper'), user_id: 'A', categories: ['Beef'] }
  const app = appHarness(); await app.ready('A', [existing])
  clickButton(app, '📖 Recipes')
  app.nodes().find(node => node.props?.placeholder === 'Search recipes...').props.onChange({ target: { value: 'Existing' } })
  app.nodes().find(node => node.type === 'select').props.onChange({ target: { value: 'Chicken' } }); app.flush()
  enterNewRecipe(app)
  const saving = app.state.addRecipe(); await app.pump()
  latestRequest(app, 'recipes', 'insert').resolve({ data: [saved], error: null }); await app.pump()
  latestRequest(app, 'recipes').resolve({ data: [existing, saved], error: null }); await saving; await app.pump()
  assert.equal(app.state.activeTab, 'recipes')
  assert.equal(app.state.searchTerm, '')
  assert.equal(app.state.selectedCategory, 'All')
  assert.ok(app.nodes().some(node => node.props?.className === 'recipe-card' && nodeText(node).includes('New supper')))
  assert.equal(recipeBuilder(app).props.hidden, true)
  assert.equal(app.reloads, 0)
  assertCleanDraft(app)
})

test('successful Edit returns to Recipes, while failed saves retain the populated form and draft', async () => {
  for (const fail of [false, true]) {
    const app = appHarness(); await app.ready('A', [editFixture(101)])
    clickButton(app, '📖 Recipes'); clickButton(app, '✏️ Edit')
    const original = draftSnapshot(app)
    const saving = app.state.addRecipe(); await app.pump()
    if (fail) {
      latestRequest(app, 'recipes', 'update').resolve({ data: null, error: { message: 'Save denied' } }); await saving; await app.pump()
      assert.equal(app.state.activeTab, 'add-recipe')
      assert.deepEqual(draftSnapshot(app), original)
    } else {
      await finishRecipeSave(app, saving, editFixture(101))
      assert.equal(app.state.activeTab, 'recipes')
      assertCleanDraft(app)
    }
    assert.equal(app.reloads, 0)
  }
})

test('confirmed creation with failed list refresh returns to Recipes and Retry reveals the saved recipe', async () => {
  const app = appHarness(); await app.ready('A', [])
  enterNewRecipe(app)
  const saved = { ...recipe(102, 'New supper'), user_id: 'A' }
  const saving = app.state.addRecipe(); await app.pump()
  latestRequest(app, 'recipes', 'insert').resolve({ data: [saved], error: null }); await app.pump()
  latestRequest(app, 'recipes').resolve({ data: null, error: { message: 'Offline' } }); await saving; await app.pump()
  assert.equal(app.state.activeTab, 'recipes')
  assert.ok(nodeText(app.nodes()).includes('Your recipe was saved, but the recipe list could not refresh.'))
  assert.equal(app.alerts.length, 0)
  assertCleanDraft(app)
  clickButton(app, 'Retry loading recipes'); await app.pump()
  latestRequest(app, 'recipes').resolve({ data: [saved], error: null }); await app.pump()
  assert.ok(app.nodes().some(node => node.props?.className === 'recipe-card' && nodeText(node).includes('New supper')))
  assert.equal(app.reloads, 0)
})

const shoppingRows = app => app.nodes().filter(node => node.props?.className === 'shopping-item')
const shoppingRow = (app, label) => shoppingRows(app).find(row => app.nodes(row).some(node => node.props?.className === 'shopping-item-label' && nodeText(node) === label))
function trashShoppingRow(app, label) {
  const row = shoppingRow(app, label)
  assert.ok(row, label)
  const button = app.nodes(row).find(node => node.props?.className === 'shopping-remove')
  assert.equal(button.props.type, 'button')
  assert.equal(button.props['aria-label'], `Remove ${label} from shopping list`)
  button.props.onClick(); app.flush()
}
const removalRecipe = (id, amount = '3') => ({ ...recipe(id, `Garlic supper ${id}`), user_id: 'A',
  structured_ingredients: [{ amount, unit: 'cloves', ingredient: 'garlic' }, { amount: '1', unit: 'cup', ingredient: 'rice' }] })
async function removalApp() {
  const first = removalRecipe(901), second = removalRecipe(902, '7')
  return bestApp({ library: [first, second], meals: [{ day: 'Thursday', meal: first }],
    shoppingList: { Other: [{ key: 'Bread', label: 'Bread', extra: true, legacyGroups: [['Bread']] }] } })
}

test('trash hides generated and extra rows from shopping/progress, preserves checks, and Restore recovers them', async () => {
  const app = await removalApp(); clickButton(app, '🛒 Shop')
  const checking = app.nodes(shoppingRow(app, 'garlic — 3 cloves')).find(node => node.props?.type === 'checkbox').props.onChange({ target: { checked: true } })
  await app.pump(); latestRequest(app, 'checked_shopping_items', 'insert').resolve({ error: null }); await checking; await app.pump()
  const checked = [...app.state.checkedShoppingItems]
  const requestsBefore = app.requests.length
  const beforeRecipe = structuredClone(app.state.recipes)
  trashShoppingRow(app, 'garlic — 3 cloves'); trashShoppingRow(app, 'Bread')
  assert.equal(shoppingRows(app).length, 1)
  assert.equal(app.nodes().find(node => node.props?.className === 'shopping-progress-count').props.children[0], 0)
  assert.deepEqual(app.state.checkedShoppingItems, checked)
  assert.deepEqual(app.state.recipes, beforeRecipe)
  assert.equal(app.requests.length, requestsBefore, 'removal never deletes checked records or recipes')
  assert.equal(Object.values(app.state.shoppingList).flat().filter(item => item.userRemoved).length, 2)
  assertPlannerCacheMatches(app)
  clickButton(app, '🍽 Plan')
  assert.deepEqual(app.nodes().find(node => node.type === 'p' && nodeText(node).includes('items checked')).props.children.filter(value => typeof value === 'number'), [0, 1])
  clickButton(app, '🛒 Shop'); clickButton(app, 'Restore removed items')
  assert.equal(shoppingRows(app).length, 3)
  assert.equal(app.nodes(shoppingRow(app, 'garlic — 3 cloves')).find(node => node.props?.type === 'checkbox').props.checked, true)
  assert.equal(app.nodes().find(node => node.props?.className === 'shopping-progress-count').props.children[0], 1)
  assert.equal(nodeText(app.nodes()).includes('Restore removed items'), false)
  assert.equal(app.requests.length, requestsBefore)
  assertPlannerCacheMatches(app)
})

test('UI removals survive Regenerate/Generate quantity changes and full cache reload', async () => {
  const app = await removalApp(); clickButton(app, '🛒 Shop'); trashShoppingRow(app, 'garlic — 3 cloves')
  app.state.regenerateMeal('Thursday'); app.flush()
  assert.equal(shoppingRows(app).some(row => nodeText(row).includes('garlic')), false)
  assert.ok(Object.values(app.state.shoppingList).flat().some(item => item.label === 'garlic — 7 cloves' && item.userRemoved))
  app.state.changeDinnerCount(2); app.flush()
  app.state.generateWeeklyMeals(); app.flush()
  assert.ok(Object.values(app.state.shoppingList).flat().some(item => item.label === 'garlic — 10 cloves' && item.userRemoved))
  assertPlannerCacheMatches(app)
  const reloaded = appHarness(app.storage); await reloaded.ready('A', [removalRecipe(901), removalRecipe(902, '7')])
  clickButton(reloaded, '🛒 Shop')
  assert.equal(shoppingRows(reloaded).some(row => nodeText(row).includes('garlic')), false)
  assert.ok(shoppingRow(reloaded, 'Bread'))
  assert.ok(shoppingRow(reloaded, '2 cup rice'))
  clickButton(reloaded, 'Restore removed items')
  assert.ok(shoppingRow(reloaded, 'garlic — 10 cloves'))
  assertPlannerCacheMatches(reloaded)
})

test('shopping removals and stale trash/restore callbacks stay isolated across accounts and logout', async () => {
  const app = await removalApp(); clickButton(app, '🛒 Shop')
  const staleTrash = app.nodes(shoppingRow(app, 'Bread')).find(node => node.props?.className === 'shopping-remove').props.onClick
  trashShoppingRow(app, 'garlic — 3 cloves')
  const staleRestore = app.nodes().find(node => node.type === 'button' && nodeText(node) === 'Restore removed items').props.onClick
  const bOwner = { userId: 'B', generation: 1 }, bRecipe = { ...removalRecipe(903), user_id: 'B' }
  account.persistPlannerCache(app.storage, bOwner, bOwner, { weeklyMeals: [{ day: 'Thursday', meal: bRecipe }], shoppingList: {}, lockedDays: [] })
  await app.ready('B', [bRecipe]); clickButton(app, '🛒 Shop')
  const before = structuredClone(app.state.shoppingList)
  staleTrash(); staleRestore(); app.flush()
  assert.deepEqual(app.state.shoppingList, before)
  assert.ok(shoppingRow(app, 'garlic — 3 cloves'))
  assert.equal(Object.values(app.state.shoppingList).flat().some(item => item.userRemoved), false)
  app.emit(null)
  assert.deepEqual(app.state.shoppingList, {})
  await app.ready('A', [removalRecipe(901), removalRecipe(902, '7')]); clickButton(app, '🛒 Shop')
  assert.equal(shoppingRow(app, 'garlic — 3 cloves'), undefined)
  assert.ok(shoppingRow(app, 'Bread'))
  assertPlannerCacheMatches(app)
})

test('late checkbox success cannot resurrect a removed row and Restore retains its completed checked state', async () => {
  const app = await removalApp(); clickButton(app, '🛒 Shop')
  const checking = app.nodes(shoppingRow(app, 'garlic — 3 cloves')).find(node => node.props?.type === 'checkbox').props.onChange({ target: { checked: true } })
  await app.pump()
  trashShoppingRow(app, 'garlic — 3 cloves')
  latestRequest(app, 'checked_shopping_items', 'insert').resolve({ error: null }); await checking; await app.pump()
  assert.equal(shoppingRow(app, 'garlic — 3 cloves'), undefined)
  assert.equal(app.nodes().find(node => node.props?.className === 'shopping-progress-count').props.children[0], 0)
  assert.equal(app.requests.some(req => req.table === 'checked_shopping_items' && req.method === 'delete'), false)
  clickButton(app, 'Restore removed items')
  assert.equal(app.nodes(shoppingRow(app, 'garlic — 3 cloves')).find(node => node.props?.type === 'checkbox').props.checked, true)
})

test('Pantry Add Missing explicitly restores removed extras or generated ingredients without duplicates or opening a modal', async () => {
  for (const planned of [false, true]) {
    const target = bestRecipe(904, 'Egg bread supper', ['Eggs', 'Bread'])
    const app = await bestApp({ library: [target], meals: planned ? [{ day: 'Thursday', meal: target }] : [], pantryNames: ['Eggs'] })
    const addMissing = () => {
      clickButton(app, '🥫 Pantry')
      const card = app.nodes().find(node => node.props?.className === 'pantry-match-card' && nodeText(node).includes('Egg bread supper'))
      let stopped = false
      app.nodes(card).find(node => node.type === 'button' && nodeText(node).includes('Shopping List')).props.onClick({ stopPropagation() { stopped = true } }); app.flush()
      assert.equal(stopped, true)
      assert.equal(detailModals(app).length, 0)
    }
    if (!planned) addMissing()
    clickButton(app, '🛒 Shop'); trashShoppingRow(app, planned ? 'bread' : 'Bread')
    addMissing()
    assert.ok(nodeText(app.nodes()).includes('✓ Added to Shopping List'))
    addMissing()
    assert.ok(nodeText(app.nodes()).includes('✓ Already on Shopping List'))
    clickButton(app, '🛒 Shop')
    assert.equal(shoppingRows(app).filter(row => nodeText(row).toLowerCase().includes('bread')).length, 1)
    assert.deepEqual(app.state.pantryItems, ['Eggs'])
    assertPlannerCacheMatches(app)
  }
})


test('Recipe Library covers omit ingredients while View/Hide preserves complete recipe details', async () => {
  const owned = { ...recipe(101, 'Personal cookbook recipe'), user_id: 'A',
    ingredients: ['First ingredient', 'Second ingredient', 'Third ingredient', 'Fourth ingredient'],
    instructions: 'Prepare everything.\n\nCook and serve.', diet_tags: ['High Protein'], categories: ['Chicken'] }
  const shared = { ...recipe(102, 'Shared cookbook recipe'), user_id: null }
  const app = appHarness(); await app.ready('A', [owned, shared])
  clickButton(app, '📖 Recipes')
  const cards = () => app.nodes().filter(node => node.props?.className === 'recipe-card')
  const personal = () => cards().find(node => nodeText(node).includes(owned.name))
  const ingredientRows = () => app.nodes(personal()).filter(node => node.type === 'li').map(nodeText)
  assert.deepEqual(ingredientRows(), [])
  assert.equal(app.nodes(personal()).some(node => node.props?.className === 'more-ingredients'), false)
  assert.ok(nodeText(personal()).includes('High Protein'))
  app.nodes(personal()).find(node => node.type === 'button' && nodeText(node) === 'View Recipe').props.onClick(); app.flush()
  assert.deepEqual(ingredientRows(), owned.ingredients)
  assert.ok(nodeText(personal()).includes('Prepare everything.'))
  assert.ok(nodeText(personal()).includes('Cook and serve.'))
  app.nodes(personal()).find(node => node.type === 'button' && nodeText(node) === 'Hide Recipe').props.onClick(); app.flush()
  assert.deepEqual(ingredientRows(), [])
  assert.deepEqual(app.state.recipes.find(item => item.id === owned.id).ingredients, owned.ingredients)
  const sharedCard = cards().find(node => nodeText(node).includes(shared.name))
  assert.deepEqual(app.nodes(sharedCard).filter(node => node.type === 'button').map(nodeText), ['View Recipe'])
})


test('Shop labels contain checkbox and complete ingredient text, while Remove remains separate', async () => {
  const app = await removalApp(); clickButton(app, '🛒 Shop')
  for (const row of shoppingRows(app)) {
    const label = app.nodes(row).find(n => n.type === 'label' && n.props.className === 'shopping-check-label')
    assert.ok(label)
    assert.equal(app.nodes(label).filter(n => n.props?.type === 'checkbox').length, 1)
    assert.ok(app.nodes(label).some(n => n.props?.className === 'shopping-item-label'))
    assert.equal(app.nodes(label).filter(n => n.type === 'button').length, 0)
    assert.ok(app.nodes(row).some(n => n.props?.className === 'shopping-remove' && n.props['aria-label'].startsWith('Remove ')))
  }
  const groups = app.nodes().filter(n => n.props?.className === 'shopping-group')
  assert.ok(groups.length > 0)
  for (const group of groups) {
    const count = app.nodes(group).filter(n => n.props?.className === 'shopping-item').length
    assert.ok(count > 0)
    assert.equal(app.nodes(app.nodes(group).find(n => n.props?.className === 'shopping-group-heading')).find(n => n.type === 'span').props.children[0], count)
  }
  const bar = app.nodes().find(n => n.props?.role === 'progressbar')
  assert.equal(bar.props['aria-valuenow'], 0)
  assert.equal(bar.props['aria-valuemax'], shoppingRows(app).length)
})

test('Shop distinguishes no plan, partial plan and no visible grocery requirements without false completion', async () => {
  const empty = appHarness(); await empty.ready('A', []); clickButton(empty, '🛒 Shop')
  assert.ok(nodeText(empty.nodes()).includes('No dinner plan yet'))
  assert.equal(empty.nodes().some(n => n.props?.role === 'progressbar'), false)
  assert.equal(nodeText(empty.nodes()).includes('All set —'), false)
  clickButton(empty, 'Go to Plan'); assert.equal(empty.state.activeTab, 'planner')
  const app = await removalApp(); clickButton(app, '🛒 Shop')
  assert.equal(app.nodes().some(n => n.type === 'p' && n.props?.children?.[0] === 'Your plan has '), false, 'one filled slot is a complete one-dinner plan')
  for (const row of [...shoppingRows(app)]) trashShoppingRow(app, nodeText(app.nodes(row).find(n => n.props?.className === 'shopping-item-label')))
  assert.ok(nodeText(app.nodes()).includes('No visible grocery requirements'))
  assert.ok(nodeText(app.nodes()).includes('Restore removed items'))
  assert.equal(nodeText(app.nodes()).includes('All set —'), false)
})

test('Shop completion and progress update only after successful checkbox saves', async () => {
  const app = await bestApp({ library: [], shoppingList: { Other: [{ key: 'Bread', label: 'Bread', extra: true }] } })
  clickButton(app, '🛒 Shop')
  const input = app.nodes(shoppingRow(app, 'Bread')).find(n => n.props?.type === 'checkbox')
  const saving = input.props.onChange({ target: { checked: true } }); await app.pump()
  assert.equal(nodeText(app.nodes()).includes('All set —'), false)
  assert.equal(app.nodes(shoppingRow(app, 'Bread')).find(n => n.props?.type === 'checkbox').props.disabled, true)
  latestRequest(app, 'checked_shopping_items', 'insert').resolve({ error: null }); await saving; await app.pump()
  assert.ok(nodeText(app.nodes()).includes('All set — every visible grocery item is checked.'))
  assert.equal(app.nodes().find(n => n.props?.role === 'progressbar').props['aria-valuenow'], 1)
})

test('Shop withholds progress during checked loading/errors and retains retry behavior', async () => {
  const app = await removalApp(); clickButton(app, '🛒 Shop')
  const reload = app.state.loadCheckedShoppingItems(); await app.pump()
  assert.equal(app.nodes().some(n => n.props?.role === 'progressbar'), false)
  assert.ok(nodeText(app.nodes()).includes('Loading checked items'))
  latestRequest(app, 'checked_shopping_items').reject(new Error('Offline')); await reload; await app.pump()
  assert.equal(app.nodes().some(n => n.props?.role === 'progressbar'), false)
  assert.ok(nodeText(app.nodes()).includes('Retry checked items'))
  clickButton(app, 'Retry checked items'); await app.pump()
  latestRequest(app, 'checked_shopping_items').resolve({ data: [], error: null }); await app.pump()
  assert.ok(app.nodes().some(n => n.props?.role === 'progressbar'))
})

test('Shop reports pantry-load failures and retries without changing list identities', async () => {
  const app = await removalApp(); clickButton(app, '🛒 Shop')
  const keys = shoppingRows(app).map(n => app.nodes(n).find(c => c.props?.className === 'shopping-item-label').props.children)
  const reload = app.state.loadPantryItems(); await app.pump()
  assert.ok(nodeText(app.nodes()).includes('Updating your grocery requirements'))
  latestRequest(app, 'pantry_items').reject(new Error('Offline')); await reload; await app.pump()
  assert.ok(nodeText(app.nodes()).includes('Pantry information could not load'))
  assert.equal(app.nodes().some(n => n.props?.role === 'progressbar'), false)
  clickButton(app, 'Retry pantry'); await app.pump()
  latestRequest(app, 'pantry_items').resolve({ data: [], error: null }); await app.pump()
  assert.deepEqual(shoppingRows(app).map(n => app.nodes(n).find(c => c.props?.className === 'shopping-item-label').props.children), keys)
  assert.ok(app.nodes().some(n => n.props?.role === 'progressbar'))
})


test('Shop display regrouping and clean labels cause no cache or Supabase writes', async () => {
  const meal = { ...recipe(501, 'Seasoned salmon'), user_id: 'A',
    ingredients: ['salmon', 'black pepper', '1 yellow onion, diced', 'garlic', 'butter beans'] }
  const app = await bestApp({ library: [meal], meals: [{ day:'Monday',meal }] })
  const before = structuredClone(app.state.shoppingList)
  const cached = app.storage.getItem(account.plannerCacheKey('A'))
  const requests = app.requests.length
  let writes = 0
  const originalSet = app.storage.setItem
  app.storage.setItem = (...args) => { writes++; return originalSet(...args) }
  clickButton(app, '🛒 Shop')
  assert.deepEqual(app.state.shoppingList,before)
  assert.equal(app.storage.getItem(account.plannerCacheKey('A')),cached)
  assert.equal(app.requests.length,requests)
  assert.equal(writes,0)
  const heading = app.nodes().find(n=>n.type==='h3' && nodeText(n)==='Meat & Seafood')
  assert.ok(heading)
  assert.ok(shoppingRow(app,'1 yellow onion, diced'))
  assert.equal(app.nodes().some(n=>n.props?.className==='shopping-item-label' && nodeText(n).endsWith('(1)')),false)
  const allOriginal = Object.values(before).flat().filter(shopping.isShoppingItemVisible)
  assert.equal(shoppingRows(app).length,allOriginal.length)
  const count = app.nodes().find(n=>n.props?.className==='shopping-progress-count')
  assert.equal(count.props.children[2],allOriginal.length)
  clickButton(app,'🍽 Plan');clickButton(app,'🛒 Shop')
  assert.equal(writes,0)
  assert.equal(app.requests.length,requests)
  const item = Object.values(before).flat().find(x=>x.label==='1 yellow onion, diced (1)')
  const check = app.nodes(shoppingRow(app,'1 yellow onion, diced')).find(n=>n.props?.type==='checkbox').props.onChange({target:{checked:true}})
  await app.pump()
  const insert=latestRequest(app,'checked_shopping_items','insert')
  assert.equal(insert.payload.item_name,item.key)
  insert.resolve({error:null});await check;await app.pump()
  const row=shoppingRow(app,'1 yellow onion, diced')
  assert.equal(app.nodes(row).find(n=>n.props?.type==='checkbox').props.checked,true)
  const remove=app.nodes(row).find(n=>n.props?.className==='shopping-remove')
  assert.equal(remove.props['aria-label'],'Remove 1 yellow onion, diced from shopping list')
  remove.props.onClick();app.flush()
  const removed=Object.values(app.state.shoppingList).flat().find(x=>x.key===item.key)
  assert.equal(removed.userRemoved,true)
  assert.equal(removed.label,item.label)
  assert.deepEqual(removed.legacyGroups,item.legacyGroups)
  assert.equal(shopping.shoppingRemovalKey(removed),shopping.shoppingRemovalKey(item))
})


test('Pantry presentation provides an accessible add form, named removal and explicit recipe detail buttons', async () => {
  const app = await pantryDetailApp()
  const root = app.nodes().find(n => n.props?.className?.includes('pantry-page'))
  assert.ok(root)
  assert.ok(nodeText(app.nodes()).includes('Pantry tracks what you have, not how much.'))
  assert.ok(nodeText(app.nodes()).includes('Quick Add'))
  const label = app.nodes().find(n => n.type === 'label' && n.props.htmlFor === 'pantry-ingredient')
  assert.equal(nodeText(label),'Add Ingredient')
  const input = app.nodes().find(n => n.props?.id === 'pantry-ingredient')
  assert.equal(input.props['aria-describedby'],'pantry-add-help')
  assert.ok(app.nodes().find(n => n.props?.id === 'pantry-add-help'))
  const remove = app.nodes().find(n => n.props?.className === 'pantry-remove')
  assert.equal(remove.props['aria-label'],'Remove Eggs')
  const before = structuredClone(app.state.shoppingList), requests = app.requests.length
  const card = app.nodes().find(n => n.props?.className === 'pantry-match-card' && nodeText(n).includes('Egg supper'))
  const view = app.nodes(card).find(n => n.type === 'button' && nodeText(n) === 'View Recipe')
  assert.equal(view.props.type,'button')
  let stopped = false
  view.props.onClick({stopPropagation(){stopped=true}});app.flush()
  assert.equal(stopped,true)
  assert.equal(detailModals(app).length,1)
  assert.equal(app.state.viewingRecipe.id,91)
  assert.deepEqual(app.state.shoppingList,before)
  assert.equal(app.requests.length,requests)
  closeDetails(app)
  const missing = app.nodes().find(n => n.props?.className === 'pantry-match-card' && nodeText(n).includes('Plain eggs'))
  assert.ok(app.nodes(missing).some(n => n.props?.className === 'pantry-photo-placeholder'))
})

test('Pantry ingredient counts and recommendation states distinguish empty, loading, unavailable and no matches', async () => {
  const app = appHarness();await app.ready('A',[],{},[]);clickButton(app,'🥫 Pantry')
  assert.ok(nodeText(app.nodes()).includes('Your pantry is empty.'))
  const heading = app.nodes().find(n => n.props?.className === 'pantry-section-heading')
  assert.equal(app.nodes(heading).find(n => n.type === 'span').props.children[0],0)
  const loading = app.state.loadPantryItems();await app.pump()
  assert.ok(nodeText(app.nodes()).includes('Finding meals from your pantry'))
  assert.equal(nodeText(app.nodes()).includes('Your pantry is empty.'),false)
  latestRequest(app,'pantry_items').reject(new Error('Offline'));await loading;await app.pump()
  assert.ok(nodeText(app.nodes()).includes('Meal suggestions are unavailable until your pantry loads.'))
  assert.equal(app.nodes().some(n => n.props?.className === 'pantry-match-card'),false)
  clickButton(app,'Retry Pantry');await app.pump()
  latestRequest(app,'pantry_items').resolve({data:[{item_name:'An exceptionally long ingredient name with meaningful (parentheses)'}],error:null});await app.pump()
  assert.ok(nodeText(app.nodes()).includes('No matching recipes yet.'))
  assert.deepEqual(app.state.pantryItems,['An exceptionally long ingredient name with meaningful (parentheses)'])
  const section = app.nodes().find(n => n.props?.className === 'pantry-section-heading')
  assert.equal(app.nodes(section).find(n => n.type === 'span').props.children[0],1)
})

test('Pantry recipe load failure has its own retry instead of a false no-match state', async () => {
  const app = await failedInitialLoads(['recipes']);clickButton(app,'🥫 Pantry')
  assert.ok(nodeText(app.nodes()).includes('Meal suggestions are unavailable because recipes could not load.'))
  assert.equal(nodeText(app.nodes()).includes('No matching recipes yet.'),false)
  clickButton(app,'Retry recipes');await app.pump()
  assert.ok(nodeText(app.nodes()).includes('Finding meals from your pantry'))
  latestRequest(app,'recipes').resolve({data:[],error:null});await app.pump()
  assert.equal(nodeText(app.nodes()).includes('Meal suggestions are unavailable'),false)
})

const dinnerSlots = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday']
const dinnerLibrary = () => Array.from({length:9}, (_, i) => eligibleMeal(3000+i))

test('fresh accounts default to four and generate exactly every selected count from one through seven', async () => {
  for (let count=1;count<=7;count++) {
    const app=appHarness();await app.ready('A',dinnerLibrary(),shortagePreferences)
    assert.equal(app.state.preferredDinnerCount,4)
    const picker=app.nodes().find(node=>node.props?.id==='dinner-count')
    assert.ok(picker);picker.props.onChange({target:{value:String(count)}});app.flush()
    clickButton(app,'Generate My Meal Plan')
    assert.equal(app.state.weeklyMeals.length,count)
    assert.equal(new Set(app.state.weeklyMeals.map(item=>item.meal.id)).size,count)
    assert.ok(app.state.weeklyMeals.every(item=>item.meal.diet_tags.includes('Vegan')&&item.meal.diet_tags.includes('Peanut-Free')))
    const cards=app.nodes().filter(node=>node.props?.className?.startsWith('meal-card'))
    assert.deepEqual(cards.map(card=>card.props.key),app.state.weeklyMeals.map(item=>item.day))
    assert.deepEqual(cards.map(card=>nodeText(app.nodes(card).find(node=>node.props?.className==='meal-day'))),Array.from({length:count},(_,i)=>`Dinner ${i+1}`))
    assert.equal(JSON.parse(app.storage.getItem(account.plannerCacheKey('A'))).preferredDinnerCount,count)
  }
})

test('count edits never truncate existing plans or locks; refresh preserves the separate count and assignments', async () => {
  const library=dinnerLibrary(),meals=dinnerSlots.map((day,i)=>({day,meal:library[i]}))
  const app=await bestApp({library,meals,locks:['Monday','Sunday']})
  assert.equal(app.state.preferredDinnerCount,7)
  const before=structuredClone(app.state.weeklyMeals)
  app.state.changeDinnerCount(2);app.flush()
  assert.deepEqual(app.state.weeklyMeals,before)
  app.state.generateWeeklyMeals();app.flush()
  assert.deepEqual(app.state.weeklyMeals,before)
  assert.deepEqual(app.state.lockedDays,['Monday','Sunday'])
  assert.ok(shortageText(app).includes('Remove specific dinners'))
  const reload=appHarness(app.storage);await reload.ready('A',library)
  assert.equal(reload.state.preferredDinnerCount,2)
  assert.deepEqual(reload.state.weeklyMeals,before)
  assert.deepEqual(reload.state.lockedDays,['Monday','Sunday'])
})

test('specific middle removal preserves stable identities, ordering, other locks and checks; locked removal needs confirmation', async () => {
  const library=dinnerLibrary(),app=await bestApp({library,meals:dinnerSlots.slice(0,4).map((day,i)=>({day,meal:library[i]})),locks:['Monday','Wednesday']})
  const others=structuredClone(app.state.weeklyMeals.filter(item=>item.day!=='Tuesday'))
  app.nodes().find(node=>node.props?.['aria-label']==='Remove Dinner 2').props.onClick();app.flush()
  assert.deepEqual(app.state.weeklyMeals,others)
  assert.deepEqual(app.state.lockedDays,['Monday','Wednesday'])
  assert.equal(app.state.preferredDinnerCount,7)
  assert.ok(nodeText(app.nodes()).includes('Dinner 3'))
  assert.equal(nodeText(app.nodes()).includes('Monday'),false)
  app.state.removeDinner('Wednesday');app.flush()
  assert.ok(app.confirmations.at(-1).includes('locked Dinner 2'))
  assert.deepEqual(app.state.lockedDays,['Monday'])
  assert.deepEqual(app.state.weeklyMeals.map(item=>item.day),['Monday','Thursday'])
  const storage=memoryStorage(),owner={userId:'A',generation:1}
  account.persistPlannerCache(storage,owner,owner,{weeklyMeals:[{day:'Sunday',meal:library[0]}],shoppingList:{},lockedDays:['Sunday'],preferredDinnerCount:4})
  const cancelled=appHarness(storage,'Thursday');await cancelled.ready('A',library);cancelled.setConfirm(false)
  const before=structuredClone(cancelled.state.weeklyMeals)
  cancelled.state.removeDinner('Sunday');cancelled.flush()
  assert.deepEqual(cancelled.state.weeklyMeals,before);assert.deepEqual(cancelled.state.lockedDays,['Sunday'])
})

test('Add Dinner respects seven-slot limit, exclusions and duplicate prevention without changing existing assignments', async () => {
  const library=dinnerLibrary(),app=await bestApp({library,meals:[{day:'Sunday',meal:library[0]}],locks:['Sunday'],preferences:shortagePreferences})
  const first=structuredClone(app.state.weeklyMeals[0])
  for(let i=0;i<6;i++){clickButton(app,'+ Add Dinner');assert.deepEqual(app.state.weeklyMeals[0],first)}
  assert.equal(app.state.weeklyMeals.length,7)
  assert.equal(new Set(app.state.weeklyMeals.map(item=>item.meal.id)).size,7)
  assert.equal(buttonNamed(app,'+ Add Dinner').props.disabled,true)
  app.state.addDinner();app.flush();assert.equal(app.state.weeklyMeals.length,7)
  assert.deepEqual(app.state.lockedDays,['Sunday'])
  const scarce=await bestApp({library:[library[0]],meals:[{day:'Sunday',meal:library[0]}]})
  scarce.state.addDinner();scarce.flush();assert.equal(scarce.state.weeklyMeals.length,1)
  assert.ok(shortageText(scarce).includes('No additional suitable recipe'))
})

test('adding and removing dinners rebuilds quantities while preserving extras, checked identities, removals and Pantry exclusions', async () => {
  const row=(id,amount)=>({...bestRecipe(id,`Rice dinner ${id}`,['Salt']),structured_ingredients:[{amount,unit:'cup',ingredient:'Rice'},{amount:'1',unit:'tsp',ingredient:'Salt'}]})
  const a=row(4001,'1'),b=row(4002,'2')
  const app=await bestApp({library:[a,b],meals:[{day:'Friday',meal:a}],pantryNames:['Salt'],shoppingList:{Other:[{key:'paper towels',label:'paper towels',extra:true}]}})
  clickButton(app,'🛒 Shop');await checkShoppingLabel(app,'paper towels');await checkShoppingLabel(app,'1 cup rice')
  const checked=[...app.state.checkedShoppingItems],writes=app.requests.length
  clickButton(app,'🍽 Plan');app.state.addDinner();app.flush()
  let visible=Object.values(app.state.shoppingList).flat().filter(shopping.isShoppingItemVisible)
  assert.ok(visible.some(item=>item.label==='3 cup rice'))
  assert.equal(visible.some(item=>/salt/i.test(item.label)),false)
  assert.deepEqual(app.state.checkedShoppingItems,checked)
  assert.ok(shopping.isShoppingItemChecked(visible.find(item=>item.label==='paper towels'),checked))
  assert.equal(shopping.isShoppingItemChecked(visible.find(item=>item.label==='3 cup rice'),checked),false,'changed quantities are not silently marked checked')
  clickButton(app,'🛒 Shop');trashShoppingRow(app,'3 cup rice');clickButton(app,'🍽 Plan')
  const added=app.state.weeklyMeals[1].day
  app.state.removeDinner(added);app.flush()
  const marker=Object.values(app.state.shoppingList).flat().find(item=>item.label==='1 cup rice')
  assert.ok(marker.userRemoved)
  assert.deepEqual(app.state.checkedShoppingItems,checked)
  assert.equal(app.requests.length,writes,'planner edits do not write shopping checks or other Supabase data')
  clickButton(app,'🛒 Shop');clickButton(app,'Restore removed items')
  visible=Object.values(app.state.shoppingList).flat().filter(shopping.isShoppingItemVisible)
  assert.ok(visible.some(item=>item.label==='1 cup rice'))
  assertPlannerCacheMatches(app)
})

test('recommendation controls add or replace explicitly, respect locks and never target the calendar weekday', async () => {
  const a=eligibleMeal(5001),b=eligibleMeal(5002),candidate=bestRecipe(5003,'Recommended',['Eggs'],['Vegan','Peanut-Free'])
  const app=await bestApp({library:[a,b,candidate],meals:[{day:'Sunday',meal:a},{day:'Monday',meal:b}],locks:['Sunday'],pantryNames:['Eggs'],preferences:shortagePreferences})
  const before=structuredClone(app.state.weeklyMeals)
  assert.equal(bestButton(app,'Replace Selected Dinner').props.disabled,true)
  const select=app.nodes().find(node=>node.props?.id==='recommendation-dinner')
  assert.ok(app.nodes(select).find(node=>node.type==='option'&&node.props.value==='Sunday').props.disabled)
  app.state.cookTonight(candidate,'Sunday');app.flush();assert.deepEqual(app.state.weeklyMeals,before)
  select.props.onChange({target:{value:'Monday'}});app.flush()
  bestButton(app,'Replace Selected Dinner').props.onClick();app.flush()
  assert.deepEqual(app.state.weeklyMeals[0],before[0]);assert.equal(app.state.weeklyMeals[1].meal.id,candidate.id)
  assert.deepEqual(app.state.lockedDays,['Sunday'])
  assertPlannerCacheMatches(app)
  const full=await bestApp({library:dinnerLibrary().concat(candidate),meals:dinnerSlots.map((day,i)=>({day,meal:dinnerLibrary()[i]})),pantryNames:['Eggs']})
  assert.equal(bestButton(full,'Add as Dinner').props.disabled,true)
  const fullBefore=structuredClone(full.state.weeklyMeals)
  full.state.cookTonight(candidate,'add');full.flush();assert.deepEqual(full.state.weeklyMeals,fullBefore)
})

test('count preference is isolated on account switching and stale callbacks cannot change another account', async () => {
  const library=dinnerLibrary(),app=appHarness();await app.ready('A',library)
  app.state.changeDinnerCount(2);app.flush();app.state.generateWeeklyMeals();app.flush()
  const a=structuredClone(app.state.weeklyMeals),stale={add:app.state.addDinner,remove:app.state.removeDinner,count:app.state.changeDinnerCount,recommend:app.state.cookTonight,generate:app.state.generateWeeklyMeals}
  await app.ready('B',library);assert.equal(app.state.preferredDinnerCount,4);assert.equal(app.state.weeklyMeals.length,0)
  stale.count(7);stale.add();stale.remove('Monday');stale.recommend(library[3],'add');stale.generate();app.flush()
  assert.equal(app.state.preferredDinnerCount,4);assert.equal(app.state.weeklyMeals.length,0)
  app.state.changeDinnerCount(6);app.flush()
  await app.ready('A',library);assert.equal(app.state.preferredDinnerCount,2);assert.deepEqual(app.state.weeklyMeals,a)
  await app.ready('B',library);assert.equal(app.state.preferredDinnerCount,6)
})

test('invalid count metadata does not discard a valid legacy plan; invalid picker values are ignored', async () => {
  for(const preferredDinnerCount of [0,8,'4',null,1.5]){
    const storage=memoryStorage(),value={version:1,userId:'A',...plan(87),preferredDinnerCount}
    storage.setItem(account.plannerCacheKey('A'),JSON.stringify(value))
    const loaded=account.loadPlannerCache(storage,'A')
    assert.deepEqual(loaded.weeklyMeals,plan(87).weeklyMeals)
    assert.ok(storage.getItem(account.plannerCacheKey('A')))
    const app=appHarness(storage);await app.ready('A',[recipe(87)])
    assert.equal(app.state.preferredDinnerCount,7)
    for(const value of [0,8,'bad',1.5]){app.state.changeDinnerCount(value);app.flush();assert.equal(app.state.preferredDinnerCount,7)}
    assert.equal(app.state.weeklyMeals[0].meal.id,87);assert.deepEqual(app.state.lockedDays,['Monday'])
  }
})

test('locks, swipe regeneration and empty legacy slots survive dynamic dinner numbering', async () => {
  const library=dinnerLibrary(),app=await bestApp({library,meals:[{day:'Sunday',meal:library[0]},{day:'Wednesday',meal:null}],locks:['Wednesday']})
  const cards=()=>app.nodes().filter(node=>node.props?.className?.startsWith('meal-card'))
  const first=cards()[0]
  first.props.onTouchStart({targetTouches:[{clientX:220}]});app.flush()
  cards()[0].props.onTouchEnd({changedTouches:[{clientX:20}]});app.flush()
  assert.notEqual(app.state.weeklyMeals[0].meal.id,library[0].id)
  assert.equal(app.state.weeklyMeals[1].meal,null);assert.deepEqual(app.state.lockedDays,['Wednesday'])
  app.state.toggleDayLock('Wednesday');app.flush();app.state.regenerateMeal('Wednesday');app.flush()
  assert.ok(app.state.weeklyMeals[1].meal)
  app.state.toggleDayLock('Sunday');app.flush()
  const before=structuredClone(app.state.weeklyMeals)
  app.state.regenerateMeal('Sunday');app.flush();assert.deepEqual(app.state.weeklyMeals,before)
  clickButton(app,app.state.weeklyMeals[0].meal.name);assert.equal(app.state.viewingRecipe.id,app.state.weeklyMeals[0].meal.id)
})


test('selecting a smaller count immediately explains specific removal without changing plan, locks or shopping', async () => {
  const library=dinnerLibrary(),app=await bestApp({library,meals:dinnerSlots.slice(0,4).map((day,i)=>({day,meal:library[i]})),locks:['Monday']})
  const before=structuredClone({meals:app.state.weeklyMeals,locks:app.state.lockedDays,shopping:app.state.shoppingList})
  const help=()=>app.nodes().find(node=>node.props?.id==='dinner-count-help')
  app.nodes().find(node=>node.props?.id==='dinner-count').props.onChange({target:{value:'2'}});app.flush()
  assert.equal(app.state.preferredDinnerCount,2)
  assert.ok(nodeText(help()).includes('Your plan still contains 4 dinners. Remove specific dinner cards to reach 2.'))
  assert.equal(help().props.role,'status')
  assert.equal(app.nodes().find(node=>node.props?.id==='dinner-count').props['aria-describedby'],'dinner-count-help')
  assert.deepEqual({meals:app.state.weeklyMeals,locks:app.state.lockedDays,shopping:app.state.shoppingList},before)
  app.state.changeDinnerCount(4);app.flush();assert.equal(help(),undefined)
  app.state.changeDinnerCount(2);app.flush()
  app.state.removeDinner('Tuesday');app.flush();assert.ok(help())
  app.state.removeDinner('Wednesday');app.flush();assert.equal(help(),undefined)
  assert.deepEqual(app.state.lockedDays,['Monday'])
})

test('plan count reads zero, one or multiple dinners planned with correct singular', async () => {
  const library=dinnerLibrary()
  for(const count of [0,1,2,7]){
    const app=await bestApp({library,meals:dinnerSlots.slice(0,count).map((day,i)=>({day,meal:library[i]}))})
    const header=app.nodes().find(node=>node.props?.className==='section-header')
    assert.equal(nodeText(app.nodes(header).find(node=>node.type==='p'&&nodeText(node).includes('planned'))),`${count} ${count===1?'dinner':'dinners'} planned`)
    assert.equal(nodeText(header).includes('dinner slots'),false)
  }
})


const openDiscovery = app => clickButton(app, 'Mix It Up — discover a dinner')
const discoveryCard = app => app.nodes().find(node => node.props?.className === 'discovery-card')
const chooseCollection = (app, value) => { app.nodes().find(node => node.props?.['aria-label'] === 'Recipe collection').props.onChange({target:{value}}); app.flush() }

test('discovery presents exactly one eligible recipe, passes without persistence and exhausts without repeats', async () => {
  const library=dinnerLibrary(), app=await bestApp({library,preferences:shortagePreferences})
  const before=structuredClone({meals:app.state.weeklyMeals,shopping:app.state.shoppingList}),writes=app.requests.length
  openDiscovery(app)
  const seen=new Set()
  while(app.state.discoveryRecipe) {
    const recipe=app.state.discoveryRecipe
    assert.ok(!seen.has(recipe.id));seen.add(recipe.id)
    assert.equal(app.nodes().filter(node=>node.props?.className==='discovery-card').length,1)
    assert.ok(recipe.diet_tags.includes('Vegan'));assert.ok(recipe.diet_tags.includes('Peanut-Free'))
    clickButton(app,'Pass')
  }
  assert.equal(seen.size,library.length)
  assert.ok(nodeText(app.nodes()).includes('You’ve explored every dinner'))
  assert.deepEqual({meals:app.state.weeklyMeals,shopping:app.state.shoppingList},before)
  assert.equal(app.requests.length,writes)
  assert.equal(app.storage.getItem(discovery.favoritesKey('A')),null)
  clickButton(app,'Browse again');assert.ok(app.state.discoveryRecipe)
})

test('Love It saves only favorites; collection combines with search/category and persists after refresh', async () => {
  const library=dinnerLibrary(),app=await bestApp({library,meals:[{day:'Sunday',meal:library[0]}],locks:['Sunday']})
  const before=structuredClone({meals:app.state.weeklyMeals,shopping:app.state.shoppingList,locks:app.state.lockedDays,checks:app.state.checkedShoppingItems})
  const cache=app.storage.getItem(account.plannerCacheKey('A')),writes=app.requests.length
  openDiscovery(app);const loved=app.state.discoveryRecipe
  clickButton(app,'Love It')
  assert.deepEqual(app.state.favoriteIds,[loved.id])
  assert.deepEqual({meals:app.state.weeklyMeals,shopping:app.state.shoppingList,locks:app.state.lockedDays,checks:app.state.checkedShoppingItems},before)
  assert.equal(app.storage.getItem(account.plannerCacheKey('A')),cache)
  assert.equal(app.requests.length,writes)
  clickButton(app,'📖 Recipes');chooseCollection(app,'favorites')
  let cards=app.nodes().filter(node=>node.props?.className==='recipe-card')
  assert.equal(cards.length,1);assert.ok(nodeText(cards[0]).includes(loved.name))
  app.nodes().find(node=>node.props?.placeholder==='Search recipes...').props.onChange({target:{value:'does not exist'}});app.flush()
  assert.equal(app.nodes().filter(node=>node.props?.className==='recipe-card').length,0)
  const reload=appHarness(app.storage);await reload.ready('A',library)
  assert.deepEqual(reload.state.favoriteIds,[loved.id])
  openDiscovery(reload);assert.equal(reload.state.discoveryQueue.length,library.length,'discovery session resets on refresh')
})

test('discovery View Recipe opens existing details without advancing, and return retains the browsing session', async () => {
  const app=await bestApp({library:dinnerLibrary()});openDiscovery(app)
  const current=app.state.discoveryRecipe.id
  clickButton(app,'View Recipe');assert.equal(app.state.viewingRecipe.id,current)
  assert.equal(app.state.discoveryRecipe.id,current);closeDetails(app)
  clickButton(app,'Pass');const next=app.state.discoveryRecipe.id
  clickButton(app,'Back to Plan');openDiscovery(app)
  assert.equal(app.state.discoveryRecipe.id,next)
  assert.ok(!app.state.discoveryQueue.includes(current))
})

test('discovery Add to Plan appends without loving, replacing, unlocking or changing the count preference', async () => {
  const library=dinnerLibrary(),app=await bestApp({library,meals:[{day:'Sunday',meal:library[0]}],locks:['Sunday']})
  openDiscovery(app)
  if(app.state.discoveryRecipe.id===library[0].id) clickButton(app,'Pass')
  const first=structuredClone(app.state.weeklyMeals[0]),candidate=app.state.discoveryRecipe.id,count=app.state.preferredDinnerCount,writes=app.requests.length
  clickButton(app,'Add to Plan')
  assert.equal(app.state.weeklyMeals.length,2)
  assert.deepEqual(app.state.weeklyMeals[0],first)
  assert.equal(app.state.weeklyMeals[1].meal.id,candidate)
  assert.deepEqual(app.state.lockedDays,['Sunday']);assert.equal(app.state.preferredDinnerCount,count)
  assert.deepEqual(app.state.favoriteIds,[]);assert.equal(app.requests.length,writes)
  assertPlannerCacheMatches(app)
})

test('discovery disables duplicate/full-plan additions and unavailable favorites', async () => {
  const library=dinnerLibrary(),app=await bestApp({library:[library[0]],meals:[{day:'Monday',meal:library[0]}]})
  openDiscovery(app);assert.equal(buttonNamed(app,'Add to Plan').props.disabled,true)
  const full=await bestApp({library,meals:dinnerSlots.map((day,i)=>({day,meal:library[i]}))})
  openDiscovery(full);assert.equal(buttonNamed(full,'Add to Plan').props.disabled,true)
  const before=structuredClone(full.state.weeklyMeals)
  full.state.discover('add');full.flush();assert.deepEqual(full.state.weeklyMeals,before)
  const broken=memoryStorage();broken.setItem(discovery.favoritesKey('A'),'bad')
  const error=appHarness(broken);await error.ready('A',library);openDiscovery(error)
  assert.equal(buttonNamed(error,'Love It').props.disabled,true)
  assert.ok(nodeText(error.nodes()).includes('Favorites could not be loaded or saved'))
})

test('discovery swipe actions and accessible buttons agree; vertical/canceled/button-origin gestures do nothing', async () => {
  const app=await bestApp({library:dinnerLibrary()});openDiscovery(app)
  const start=(x=150,y=100,control=false)=>discoveryCard(app).props.onTouchStart({target:{closest:()=>control},touches:[{clientX:x,clientY:y}]})
  const end=(x,y)=>{discoveryCard(app).props.onTouchEnd({changedTouches:[{clientX:x,clientY:y}]});app.flush()}
  const first=app.state.discoveryRecipe.id
  start();end(160,240);assert.equal(app.state.discoveryRecipe.id,first)
  start();discoveryCard(app).props.onTouchCancel();end(50,100);assert.equal(app.state.discoveryRecipe.id,first)
  start(150,100,true);end(50,100);assert.equal(app.state.discoveryRecipe.id,first)
  start();end(50,100);assert.notEqual(app.state.discoveryRecipe.id,first);assert.deepEqual(app.state.favoriteIds,[])
  const second=app.state.discoveryRecipe.id
  start();end(250,100);assert.deepEqual(app.state.favoriteIds,[second])
  assert.equal(app.state.weeklyMeals.length,0)
})

test('favorites/discovery reset on account switch and stale actions cannot affect the next account', async () => {
  const library=dinnerLibrary(),app=await bestApp({library});openDiscovery(app)
  const stale=app.state.discover,old=app.state.discoveryRecipe.id
  clickButton(app,'Love It');assert.deepEqual(app.state.favoriteIds,[old])
  await app.ready('B',library);assert.deepEqual(app.state.favoriteIds,[]);assert.equal(app.state.discoveryQueue,null)
  stale('love');stale('add');app.flush();assert.deepEqual(app.state.favoriteIds,[]);assert.equal(app.state.weeklyMeals.length,0)
  await app.ready('A',library);assert.deepEqual(app.state.favoriteIds,[old]);assert.equal(app.state.discoveryQueue,null)
})

test('discovery rechecks restrictions, has no-match state and guards repeated actions before render', async () => {
  const safe=eligibleMeal(9001),unsafe={...eligibleMeal(9002),diet_tags:[]}
  const app=await bestApp({library:[safe,unsafe],preferences:shortagePreferences});openDiscovery(app)
  assert.equal(app.state.discoveryRecipe.id,safe.id)
  app.state.discover('love');app.state.discover('love');app.flush()
  assert.deepEqual(app.state.favoriteIds,[safe.id]);assert.equal(app.state.discoveryRecipe,undefined)
  const empty=await bestApp({library:[unsafe],preferences:shortagePreferences});openDiscovery(empty)
  assert.ok(nodeText(empty.nodes()).includes('No matching dinners right now'))
  assert.equal(discoveryCard(empty),undefined)
})


test('failed favorites writes keep the current card and all planner data unchanged', async () => {
  const app=await bestApp({library:dinnerLibrary()});openDiscovery(app)
  const current=app.state.discoveryRecipe.id,before=structuredClone({meals:app.state.weeklyMeals,shopping:app.state.shoppingList})
  const original=app.storage.setItem
  app.storage.setItem=(key,value)=>{if(key===discovery.favoritesKey('A')) throw new Error('Quota');original(key,value)}
  clickButton(app,'Love It')
  assert.equal(app.state.discoveryRecipe.id,current);assert.deepEqual(app.state.favoriteIds,[])
  assert.equal(app.state.favoritesError,true)
  assert.deepEqual({meals:app.state.weeklyMeals,shopping:app.state.shoppingList},before)
  app.storage.setItem=original
  clickButton(app,'Retry Favorites');clickButton(app,'Love It')
  assert.deepEqual(app.state.favoriteIds,[current])
})

test('loving preserves existing favorites written by another tab and favorite category filtering composes', async () => {
  const library=dinnerLibrary();library[0].categories=['Chicken']
  const app=await bestApp({library});openDiscovery(app)
  const id=app.state.discoveryRecipe.id,other=library.find(recipe=>recipe.id!==id).id
  discovery.saveFavorites(app.storage,{userId:'A',generation:1},{userId:'A',generation:1},[other])
  clickButton(app,'Love It');assert.deepEqual(new Set(app.state.favoriteIds),new Set([other,id]))
  clickButton(app,'📖 Recipes');chooseCollection(app,'favorites')
  app.nodes().find(node=>node.type==='select'&&node.props.value==='All').props.onChange({target:{value:'Chicken'}});app.flush()
  const cards=app.nodes().filter(node=>node.props?.className==='recipe-card')
  assert.equal(cards.length,app.state.favoriteIds.includes(library[0].id)?1:0)
})

test('discovery unavailable state does not expose stale cards or allow actions', async () => {
  const app=await bestApp({library:dinnerLibrary()});openDiscovery(app)
  const current=app.state.discoveryRecipe
  const pending=app.state.getRecipes();await app.pump()
  assert.equal(discoveryCard(app),undefined);assert.ok(nodeText(app.nodes()).includes('Loading recipes'))
  app.state.discover('love',current);app.flush();assert.deepEqual(app.state.favoriteIds,[])
  latestRequest(app,'recipes').resolve({data:null,error:{message:'unavailable'}});await pending;await app.pump()
  assert.equal(discoveryCard(app),undefined);assert.ok(nodeText(app.nodes()).includes('Retry loading recipes'))
})
