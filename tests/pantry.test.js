import test from 'node:test'
import assert from 'node:assert/strict'
import { pantryHasIngredient } from '../src/pantry.js'
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
