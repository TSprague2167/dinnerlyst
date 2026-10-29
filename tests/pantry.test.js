import test from 'node:test'
import assert from 'node:assert/strict'
import { pantryHasIngredient, getPantryRecipeMatch } from '../src/pantry.js'
import { buildShoppingList, rebuildShoppingList, isShoppingItemChecked, shoppingCheckIdentities } from '../src/shoppingList.js'
import { shoppingRemovalKey, isShoppingItemVisible, removeShoppingItem, restoreRemovedShoppingItems, addMissingShoppingItems, shoppingContainsIngredient } from '../src/shoppingList.js'
const visible = list => Object.values(list).flat().filter(item => !item.pantryHidden)
const meal = structured_ingredients => ({ day: 'Monday', meal: { id: 57, structured_ingredients } })
const oilMeals = [meal([{ item: 'olive oil', quantity: 2, unit: 'tbsp' }]),
  meal([{ ingredient: 'olive oil', amount: '3', unit: 'tablespoons' }])]

test('exact matching, whitespace, conservative plurals and meaningful distinctions', () => {
  for (const [ingredient, pantry] of [[' OLIVE  oil ','olive oil'],['eggs','egg'],['egg','eggs'],['tomatoes','tomato'],['tomato','tomatoes'],['chicken breast','chicken breast']]) {
    assert.equal(pantryHasIngredient(ingredient,[pantry]),true)
  }
  for (const name of ['chicken breast','chicken thighs','chicken broth']) assert.equal(pantryHasIngredient(name,['chicken']),false)
  assert.equal(pantryHasIngredient('rice vinegar',['rice']),false)
  assert.equal(pantryHasIngredient('fresh spinach',['spinach']),false)
})

test('both structured schemas excluded before aggregation; remaining quantities unchanged', () => {
  assert.equal(visible(buildShoppingList(oilMeals))[0].label,'5 tbsp olive oil')
  assert.deepEqual(visible(buildShoppingList(oilMeals,['olive oil'])),[])
  const mixed = [...oilMeals,meal([{amount:'1/2',unit:'cup',ingredient:'rice'},{quantity:1.5,unit:'cup',item:'rice'}])]
  assert.deepEqual(visible(buildShoppingList(mixed,['olive oil'])).map(item=>item.label),['2 cup rice'])
})

test('legacy strings retain opaque labels while known quantity/unit prefixes allow Pantry exclusion', () => {
  const meals=[{meal:{ingredients:['olive oil','eggs','2 tbsp olive oil','rice vinegar','chicken broth']}}]
  const labels=visible(buildShoppingList(meals,['olive oil','egg','rice','chicken'])).map(item=>item.label)
  assert.deepEqual(labels.sort(),['rice vinegar (1)','chicken broth (1)'].sort())
})

test('pantry add/remove preserves extras, quantities, checked identities and legacy aliases across refresh', () => {
  const generated=buildShoppingList(oilMeals)
  generated.Other[0].legacyGroups.forEach(group=>group.push('olive oil (2)'))
  generated.Other.push({key:'paper towels',label:'paper towels',extra:true,legacyGroups:[['paper towels']]})
  const original=generated.Other[0]
  const checked=[original.key,'olive oil (2)','paper towels']
  const hidden=rebuildShoppingList(generated,oilMeals,oilMeals,['olive oil'])
  assert.deepEqual(visible(hidden).map(item=>item.label),['paper towels'])
  const reloaded=JSON.parse(JSON.stringify(hidden))
  const restored=rebuildShoppingList(reloaded,oilMeals,oilMeals,[])
  const oil=visible(restored).find(item=>item.label==='5 tbsp olive oil')
  assert.equal(oil.key,original.key)
  assert.equal(isShoppingItemChecked(oil,checked),true)
  assert.equal(isShoppingItemChecked(oil,['olive oil (2)']),true)
  assert.ok(shoppingCheckIdentities(oil).includes('olive oil (2)'))
  assert.ok(visible(restored).some(item=>item.label==='paper towels'))
  assert.equal(visible(hidden).filter(item=>isShoppingItemChecked(item,checked)).length,1)
})

const qualifies = match => match.totalCount > 0 && match.matchedCount / match.totalCount >= 0.5

test('Pantry recipe matches use both structured schemas and format missing quantities', () => {
  for (const rows of [
    [{ item: 'eggs', quantity: 2, unit: 'whole' }, { item: 'olive oil', quantity: 2, unit: 'tbsp' }],
    [{ ingredient: 'eggs', amount: '2', unit: 'whole' }, { ingredient: 'olive oil', amount: '2', unit: 'tbsp' }],
  ]) {
    const match = getPantryRecipeMatch({ id: 57, structured_ingredients: rows, ingredients: ['incorrect fallback'] }, [' EGG '])
    assert.equal(match.id, 57)
    assert.equal(match.matchedCount, 1)
    assert.equal(match.totalCount, 2)
    assert.equal(match.matchPercentage, 50)
    assert.equal(qualifies(match), true)
    assert.deepEqual(match.missingIngredients, ['2 tbsp olive oil'])
  }
})

test('legacy Pantry matches normalize known quantity/unit prefixes and preserve unmatched strings', () => {
  const match = getPantryRecipeMatch({ ingredients: ['tomatoes', 'chicken broth', 'rice vinegar', '2 tbsp olive oil'] }, ['tomato', 'chicken', 'rice', 'olive oil'])
  assert.equal(match.matchedCount, 2)
  assert.equal(match.totalCount, 4)
  assert.equal(match.matchPercentage, 50)
  assert.equal(qualifies(match), true)
  assert.deepEqual(match.missingIngredients, ['chicken broth', 'rice vinegar'])
})

test('eligibility includes exactly half and excludes below half and empty recipes', () => {
  const half = getPantryRecipeMatch({ ingredients: ['eggs', 'rice'] }, ['egg'])
  assert.equal(qualifies(half), true)
  const below = getPantryRecipeMatch({ ingredients: ['eggs', 'rice', 'milk'] }, ['egg'])
  assert.equal(qualifies(below), false)
  // A rounded 50% must not make an actual ratio below half qualify.
  const rounded = getPantryRecipeMatch({ ingredients: [...Array(50).fill('eggs'), ...Array(51).fill('rice')] }, ['egg'])
  assert.equal(rounded.matchPercentage, 50)
  assert.equal(qualifies(rounded), false)
  const empty = getPantryRecipeMatch({ ingredients: [] }, ['egg'])
  assert.equal(empty.totalCount, 0)
  assert.equal(empty.matchedCount, 0)
  assert.equal(empty.matchPercentage, 0)
  assert.deepEqual(empty.missingIngredients, [])
  assert.equal(qualifies(empty), false)
})


test('Pantry comparisons recognize quantity/unit prefixes and exact garlic clove aliases', () => {
  for (const name of ['3 cloves garlic', 'garlic cloves', 'garlic clove', '1 clove garlic',
    ' 3   CLOVES  Garlic ', '1/2 tsp garlic', '1 1/2 teaspoons garlic', '0.5 cup garlic', '2 tbsp olive oil']) {
    const pantryName = name.includes('olive oil') ? 'olive oil' : 'garlic'
    assert.equal(pantryHasIngredient(name, [pantryName]), true, name)
  }
  assert.equal(pantryHasIngredient('garlic', ['garlic cloves']), true)
  assert.equal(pantryHasIngredient('garlic', ['3 cloves garlic']), true)
  const match = getPantryRecipeMatch({ ingredients: ['3 cloves garlic', 'garlic cloves', '1 cup rice vinegar'] }, ['garlic'])
  assert.equal(match.matchedCount, 2)
  assert.deepEqual(match.missingIngredients, ['1 cup rice vinegar'])
})

test('Pantry comparison never uses substring matches or strips unrecognized ingredient words', () => {
  for (const [name, pantryName] of [
    ['garlic powder', 'garlic'], ['1 tsp garlic powder', 'garlic'], ['3 cloves garlic powder', 'garlic'],
    ['rice vinegar', 'rice'], ['2 cups rice vinegar', 'rice'], ['cauliflower rice', 'rice'], ['1 cup cauliflower rice', 'rice'],
    ['3 bunches garlic', 'garlic'], ['3 garlic', 'garlic'], ['cloves garlic', 'garlic'],
    ['1/0 tsp garlic', 'garlic'], ['five cloves garlic', 'garlic'], ['12 grain bread', 'bread'],
  ]) assert.equal(pantryHasIngredient(name, [pantryName]), false, name)
})

test('garlic generated entries hide and restore unchanged labels/keys/checked aliases while manual extras stay visible', () => {
  const meals = [
    meal([{ amount: '3', unit: 'cloves', ingredient: 'garlic' }, { amount: '1', unit: 'cup', ingredient: 'rice' }]),
    meal([{ amount: '2', unit: 'clove', ingredient: 'garlic' }, { amount: '2', unit: 'cups', ingredient: 'rice' }]),
    { meal: { ingredients: ['3 cloves garlic', 'garlic cloves'] } },
    meal([{ amount: '', unit: '', ingredient: '3 cloves garlic' }]),
  ]
  const original = buildShoppingList(meals)
  const generated = visible(original)
  const garlic = generated.filter(item => item.label.includes('garlic'))
  assert.equal(garlic.length, 3)
  assert.ok(garlic.some(item => item.label === 'garlic — 5 cloves'))
  assert.ok(garlic.some(item => item.label === '3 cloves garlic (2)'))
  assert.equal(generated.find(item => item.label.includes('rice')).label, '3 cup rice')
  const extra = { key: '3 cloves garlic', label: '3 cloves garlic', extra: true, legacyGroups: [['3 cloves garlic']] }
  original.Other.push(extra)
  const checked = [...garlic.map(item => item.key), extra.key]
  const before = JSON.stringify(meals)
  const hidden = rebuildShoppingList(original, meals, meals, ['garlic'])
  assert.deepEqual(visible(hidden).map(item => item.label).sort(), ['3 cup rice', '3 cloves garlic'].sort())
  assert.equal(visible(hidden).find(item => item.extra).key, extra.key)
  assert.equal(isShoppingItemChecked(visible(hidden).find(item => item.extra), checked), true)
  assert.equal(JSON.stringify(meals), before, 'comparison must not mutate recipe quantities or source text')
  const restored = rebuildShoppingList(JSON.parse(JSON.stringify(hidden)), meals, meals, [])
  for (const item of garlic) {
    const result = visible(restored).find(value => value.key === item.key)
    assert.equal(result.label, item.label)
    assert.equal(isShoppingItemChecked(result, checked), true)
    assert.deepEqual(shoppingCheckIdentities(result), shoppingCheckIdentities(item))
  }
  assert.equal(visible(restored).find(item => item.label.includes('rice')).label, '3 cup rice')
  assert.ok(visible(restored).some(item => item.extra && item.label === '3 cloves garlic'))
})


const removalVisible = list => Object.values(list).flat().filter(isShoppingItemVisible)
const allItems = list => Object.values(list).flat()

test('structured removals ignore aggregate quantity but preserve ingredient/unit distinctions and recipe data', () => {
  const initial = [meal([{ amount: '3', unit: 'cloves', ingredient: 'garlic' }])]
  const changed = [meal([{ amount: '7', unit: 'clove', ingredient: 'garlic' },
    { amount: '2', unit: 'tsp', ingredient: 'garlic' }, { amount: '1', unit: 'tsp', ingredient: 'garlic powder' }])]
  const previous = buildShoppingList(initial)
  const original = allItems(previous)[0]
  const snapshot = JSON.stringify({ initial, changed, previous })
  const removed = removeShoppingItem(previous, original)
  assert.equal(removalVisible(removed).length, 0)
  assert.equal(allItems(removed)[0].key, original.key)
  assert.deepEqual(allItems(removed)[0].legacyGroups, original.legacyGroups)
  const rebuilt = rebuildShoppingList(JSON.parse(JSON.stringify(removed)), initial, changed)
  const garlic = allItems(rebuilt).find(item => item.label === 'garlic — 7 cloves')
  assert.equal(garlic.userRemoved, true)
  assert.equal(shoppingRemovalKey(garlic), shoppingRemovalKey(original))
  assert.deepEqual(removalVisible(rebuilt).map(item => item.label).sort(), ['2 tsp garlic', '1 tsp garlic powder'].sort())
  assert.equal(JSON.stringify({ initial, changed, previous }), snapshot)
})

test('legacy removals use exact source text, survive occurrence-count changes, and do not use Pantry aliases', () => {
  const oldMeals = [{ meal: { ingredients: ['3 cloves garlic', 'garlic cloves'] } }]
  const moreMeals = [...oldMeals, { meal: { ingredients: ['3 cloves garlic'] } }]
  const previous = buildShoppingList(oldMeals)
  const target = allItems(previous).find(item => item.label === '3 cloves garlic (1)')
  const removed = removeShoppingItem(previous, target)
  const rebuilt = rebuildShoppingList(removed, oldMeals, moreMeals)
  assert.ok(allItems(rebuilt).some(item => item.label === '3 cloves garlic (2)' && item.userRemoved))
  assert.deepEqual(removalVisible(rebuilt).map(item => item.label), ['garlic cloves (1)'])
  assert.notEqual(shoppingRemovalKey(target), shoppingRemovalKey(allItems(previous).find(item => item.label === 'garlic cloves (1)')))
})

test('manual and unclassified extras use exact keys and persist removals even with no planned recipes', () => {
  const previous = { Other: [{ key: 'garlic', label: 'garlic', extra: true }, '3 cloves garlic'] }
  const removed = removeShoppingItem(previous, '3 cloves garlic')
  const rebuilt = rebuildShoppingList(JSON.parse(JSON.stringify(removed)), [], [])
  assert.deepEqual(removalVisible(rebuilt).map(item => item.label), ['garlic'])
  assert.ok(allItems(rebuilt).some(item => item.key === '3 cloves garlic' && item.userRemoved))
  const restored = restoreRemovedShoppingItems(rebuilt, [])
  assert.deepEqual(removalVisible(restored).map(item => item.label).sort(), ['garlic', '3 cloves garlic'].sort())
})

test('generated removal markers survive an absent ingredient and suppress its later return without restoring obsolete rows', () => {
  const meals = [meal([{ amount: '3', unit: 'cloves', ingredient: 'garlic' }])]
  const previous = buildShoppingList(meals)
  const removed = removeShoppingItem(previous, allItems(previous)[0])
  const absent = rebuildShoppingList(removed, meals, [])
  assert.equal(allItems(absent).length, 1)
  assert.equal(removalVisible(absent).length, 0)
  assert.equal(removalVisible(rebuildShoppingList(absent, [], meals)).length, 0)
  assert.equal(allItems(restoreRemovedShoppingItems(absent, [])).length, 0, 'Restore does not resurrect ingredients from deleted meals')
})

test('Pantry exclusion and manual removal remain independent while restoration preserves checked aliases', () => {
  const meals = [meal([{ amount: '3', unit: 'cloves', ingredient: 'garlic' }])]
  const original = allItems(buildShoppingList(meals))[0]
  original.legacyGroups[0].push('old garlic check')
  const removed = removeShoppingItem({ Other: [original] }, original)
  const hidden = rebuildShoppingList(removed, meals, meals, ['garlic'])
  assert.equal(allItems(hidden)[0].pantryHidden, true)
  assert.equal(allItems(hidden)[0].userRemoved, true)
  const noPantry = rebuildShoppingList(hidden, meals, meals, [])
  assert.equal(removalVisible(noPantry).length, 0, 'removing Pantry garlic does not override a user removal')
  const restoredWithPantry = restoreRemovedShoppingItems(hidden, meals, ['garlic'])
  assert.equal(allItems(restoredWithPantry)[0].userRemoved, undefined)
  assert.equal(removalVisible(restoredWithPantry).length, 0, 'Restore does not override Pantry exclusion')
  const restored = rebuildShoppingList(restoredWithPantry, meals, meals, [])
  const item = removalVisible(restored)[0]
  assert.equal(item.key, original.key)
  assert.equal(isShoppingItemChecked(item, [original.key]), true)
  assert.equal(isShoppingItemChecked(item, ['old garlic check']), true)
  assert.deepEqual(shoppingCheckIdentities(item), shoppingCheckIdentities(original))
})

test('Add Missing restores matching removed extras and generated sources without duplicates or unrelated restoration', () => {
  const meals = [meal([{ amount: '3', unit: 'cloves', ingredient: 'garlic' }, { amount: '2', unit: 'cup', ingredient: 'rice' }])]
  let previous = buildShoppingList(meals)
  for (const item of allItems(previous)) previous = removeShoppingItem(previous, item)
  previous.Other.push({ key: 'Bread', label: 'Bread', extra: true, userRemoved: true })
  let restored = addMissingShoppingItems(previous, ['3 cloves garlic', 'Bread'], meals)
  assert.deepEqual(removalVisible(restored).map(item => item.label).sort(), ['garlic — 3 cloves', 'Bread'].sort())
  assert.ok(allItems(restored).some(item => item.label === '2 cup rice' && item.userRemoved))
  assert.equal(shoppingContainsIngredient(restored, '3 cloves garlic'), true)
  assert.equal(shoppingContainsIngredient(restored, 'Bread'), true)
  assert.equal(shoppingContainsIngredient(restored, '2 cup rice'), false)
  restored = addMissingShoppingItems(restored, ['3 cloves garlic', 'Bread'], meals)
  assert.equal(removalVisible(restored).length, 2)
  const pantryHidden = addMissingShoppingItems(previous, ['3 cloves garlic'], meals, ['garlic'])
  assert.ok(allItems(pantryHidden).some(item => item.generated && item.pantryHidden))
  assert.deepEqual(removalVisible(pantryHidden).map(item => item.label), ['3 cloves garlic'], 'an explicit extra is still allowed even when Pantry hides the generated ingredient')
})
