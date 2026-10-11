import test from 'node:test'
import assert from 'node:assert/strict'
import { pantryHasIngredient, getPantryRecipeMatch } from '../src/pantry.js'
import { buildShoppingList, rebuildShoppingList, isShoppingItemChecked, shoppingCheckIdentities } from '../src/shoppingList.js'
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

test('legacy strings stay opaque; only exact unambiguous names are excluded', () => {
  const meals=[{meal:{ingredients:['olive oil','eggs','2 tbsp olive oil','rice vinegar','chicken broth']}}]
  const labels=visible(buildShoppingList(meals,['olive oil','egg','rice','chicken'])).map(item=>item.label)
  assert.deepEqual(labels.sort(),['2 tbsp olive oil (1)','rice vinegar (1)','chicken broth (1)'].sort())
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

test('legacy Pantry matches stay conservative and preserve missing strings', () => {
  const match = getPantryRecipeMatch({ ingredients: ['tomatoes', 'chicken broth', 'rice vinegar', '2 tbsp olive oil'] }, ['tomato', 'chicken', 'rice', 'olive oil'])
  assert.equal(match.matchedCount, 1)
  assert.equal(match.totalCount, 4)
  assert.equal(match.matchPercentage, 25)
  assert.equal(qualifies(match), false)
  assert.deepEqual(match.missingIngredients, ['chicken broth', 'rice vinegar', '2 tbsp olive oil'])
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
