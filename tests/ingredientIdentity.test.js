import test from 'node:test'
import assert from 'node:assert/strict'
import { canonicalIngredient, parseIngredientText } from '../src/ingredientIdentity.js'
import { pantryHasIngredient } from '../src/pantry.js'
import { buildPreviousShoppingList } from '../src/shoppingLegacy.js'
import { buildShoppingList, rebuildShoppingList, isShoppingItemChecked, shoppingCheckIdentities,
  isShoppingItemVisible, removeShoppingItem, restoreRemovedShoppingItems } from '../src/shoppingList.js'

const entries = list => Object.values(list).flat()
const visible = list => entries(list).filter(isShoppingItemVisible)
const legacy = (...ingredients) => [{meal:{ingredients}}]
const rows = (...structured_ingredients) => [{meal:{structured_ingredients}}]
const row = (ingredient, amount, unit = '') => ({ingredient, amount, unit})

test('canonical names share targeted aliases without erasing ingredient form', () => {
  for (const [source, expected] of [['Oregano','dried oregano'],['DRIED oregano','dried oregano'],
    ['whole lemons','lemon'],['Lemons','lemon'],['lemon, sliced','lemon'],['fresh garlic cloves','garlic']]) {
    assert.equal(canonicalIngredient(source), expected)
    assert.equal(pantryHasIngredient(source,[expected]),true)
    assert.equal(pantryHasIngredient(expected,[source]),true)
  }
  for (const [a,b] of [['fresh oregano','dried oregano'],['lemon juice','lemon'],['lemon zest','whole lemon'],
    ['garlic powder','garlic'],['dried basil','fresh basil'],['rice vinegar','rice'],['lemon slices','lemon'],
    ['red onion','yellow onion']]) assert.equal(pantryHasIngredient(a,[b]),false,`${a} != ${b}`)
})

test('unquantified aliases consolidate occurrences without inventing quantities', () => {
  const list = visible(buildShoppingList(legacy('Oregano','dried oregano','Lemon','whole lemon','fresh oregano','lemon juice')))
  assert.equal(list.length,4)
  assert.equal(list.find(x=>x.label==='Oregano (2)').sourceCounts.length,2)
  assert.equal(list.find(x=>x.label==='Lemon (2)').legacyGroups.length,2)
})

test('explicit counts and whole-count aliases aggregate across both structured schemas and legacy text', () => {
  const meals = [...rows(row('Lemon','1'), {item:'whole lemons',quantity:2,unit:'whole'}), ...legacy('3 lemons')]
  assert.deepEqual(visible(buildShoppingList(meals)).map(x=>x.label),['6 lemons'])
  assert.deepEqual(visible(buildShoppingList(meals,['whole lemon'])),[])
})

for (const [a,b,expected] of [
  [row('Oregano','1','tbsp'),row('dried oregano','2','tsp'),'5 tsp dried oregano'],
  [row('rice','1','cup'),row('rice','1','tablespoon'),'51 tsp rice'],
  [row('beef','1','pound'),row('beef','8','oz'),'24 oz beef'],
  [row('rice','1','kg'),row('rice','250','grams'),'1250 g rice'],
  [row('milk','1','liter'),row('milk','250','ml'),'1250 ml milk'],
]) test(`compatible units: ${expected}`,()=> {
  assert.deepEqual(visible(buildShoppingList(rows(a,b))).map(x=>x.label),[expected])
})

test('incompatible dimensions and uncertain amounts stay separate', () => {
  const meals=rows(row('dried oregano','1','tsp'),row('oregano','2','g'),row('fresh oregano','1','tsp'),
    row('oregano','to taste'),row('lemon juice','1','tbsp'),row('whole lemon','1','whole'))
  assert.equal(visible(buildShoppingList(meals)).length,6)
  for (const text of ['1-2 lemons','1/0 tsp oregano','a pinch of oregano','3 bunches garlic','3 garlic']) {
    assert.equal(parseIngredientText(text).amount,null)
  }
  assert.equal(visible(buildShoppingList(rows(row('rice','1','cup'),row('rice','1','g')))).length,2)
})

test('Pantry matching excludes the same identities from structured and legacy recipes', () => {
  const meals=[...rows(row('Oregano','1','tsp'),row('whole lemon','2'),row('garlic cloves','3','clove')),
    ...legacy('2 tsp dried oregano','1 lemon','fresh oregano','lemon juice','garlic powder')]
  const before=structuredClone(meals)
  assert.deepEqual(visible(buildShoppingList(meals,['DRIED OREGANO','whole lemons','Fresh garlic']))
    .map(x=>x.label).sort(),['fresh oregano (1)','lemon juice (1)','garlic powder (1)'].sort())
  assert.deepEqual(meals,before)
})

test('historical generated labels migrate without becoming manual extras or changing persisted checks', () => {
  const meals=[...rows(row('Oregano','1','tbsp'),row('dried oregano','2','tsp')),...legacy('Lemon','whole lemon')]
  const old=buildPreviousShoppingList(meals),checked=entries(old).map(x=>x.key)
  const before=JSON.stringify({old,checked,meals})
  const result=visible(rebuildShoppingList(old,meals,meals))
  assert.equal(result.length,2)
  for(const item of result)assert.equal(isShoppingItemChecked(item,checked),true)
  for(const item of result) {
    const partial=checked.filter(key=>key!==entries(old).find(x=>shoppingCheckIdentities(item).includes(x.key)).key)
    assert.equal(isShoppingItemChecked(item,partial),false,'combined item requires every former source to be checked')
  }
  assert.equal(JSON.stringify({old,checked,meals}),before)
  const oldest=Object.fromEntries(Object.entries(old).map(([k,v])=>[k,v.map(x=>x.label)]))
  assert.equal(visible(rebuildShoppingList(oldest,meals,meals)).length,2)
})

test('cache refresh and Pantry hide/restore preserve migrated checkbox aliases without writes', () => {
  const meals=[...rows(row('oregano','1','tbsp'),row('dried oregano','2','tsp')),...legacy('Lemon','whole lemon')]
  const old=buildPreviousShoppingList(meals),checked=entries(old).map(x=>x.key)
  let list=rebuildShoppingList(old,meals,meals)
  for(let n=0;n<3;n++) {
    list=rebuildShoppingList(JSON.parse(JSON.stringify(list)),meals,meals,['oregano','lemon'])
    assert.equal(visible(list).length,0)
    list=rebuildShoppingList(JSON.parse(JSON.stringify(list)),meals,meals,[])
    assert.equal(visible(list).length,2)
    for(const item of visible(list))assert.equal(isShoppingItemChecked(item,checked),true)
  }
})

test('changed aggregate quantities do not inherit an earlier aggregate checkbox key', () => {
  const oldMeals=rows(row('oregano','1','tbsp'),row('dried oregano','2','tsp'))
  const old=buildShoppingList(oldMeals),oldKey=visible(old)[0].key
  const changed=rebuildShoppingList(old,oldMeals,rows(row('oregano','2','tbsp'),row('dried oregano','2','tsp')))
  assert.equal(isShoppingItemChecked(visible(changed)[0],[oldKey]),false)
})

test('existing measured removals survive alias/unit consolidation; Restore remains reversible', () => {
  const meals=rows(row('oregano','1','tbsp'),row('dried oregano','2','tsp'))
  const old=buildPreviousShoppingList(meals)
  const removed=removeShoppingItem(old,entries(old)[0])
  const rebuilt=rebuildShoppingList(removed,meals,meals)
  assert.equal(visible(rebuilt).length,0)
  assert.equal(visible(restoreRemovedShoppingItems(rebuilt,meals)).length,1)
})

test('old opaque quantified removals exclude only their original contribution', () => {
  const meals=legacy('1 lemon','2 whole lemons')
  const old=buildPreviousShoppingList(meals)
  const removed=removeShoppingItem(old,entries(old).find(x=>x.label==='1 lemon (1)'))
  const rebuilt=rebuildShoppingList(removed,meals,meals)
  assert.deepEqual(visible(rebuilt).map(x=>x.label),['2 lemons'])
  assert.deepEqual(visible(restoreRemovedShoppingItems(rebuilt,meals)).map(x=>x.label),['3 lemons'])
})

test('manual extras remain explicit even when Pantry owns the same ingredient', () => {
  const meals=legacy('Lemon','whole lemon')
  const old=buildPreviousShoppingList(meals)
  old.Other.push({key:'extra lemon',label:'Lemon',extra:true})
  const result=rebuildShoppingList(old,meals,meals,['lemon'])
  assert.deepEqual(visible(result).map(x=>x.key),['extra lemon'])
})

test('old unquantified checks reconcile to measured rows only for an unambiguous replacement', () => {
  const before=legacy('Oregano'),old=buildPreviousShoppingList(before),key=entries(old)[0].key
  const after=rows(row('dried oregano','1','tsp'))
  assert.equal(isShoppingItemChecked(visible(rebuildShoppingList(old,before,after))[0],[key]),true)
  const ambiguous=rows(row('dried oregano','1','tsp'),row('dried oregano','2','g'))
  for(const item of visible(rebuildShoppingList(old,before,ambiguous)))assert.equal(isShoppingItemChecked(item,[key]),false)
})

test('unusual labels and unknown units remain literal and cannot resolve object prototype properties', () => {
  for(const text of ['constructor','__proto__','vitamin B12 (1)','bread (gluten-free)']) {
    assert.equal(typeof canonicalIngredient(text),'string')
    assert.equal(visible(buildShoppingList(legacy(text))).length,1)
    assert.equal(pantryHasIngredient(text,[text]),true)
  }
  assert.deepEqual(visible(buildShoppingList(rows(row('rice','1','constructor')))).map(x=>x.label),['1 constructor rice'])
})

test('legacy alias removals preserve only the removed contribution, including reordered sources', () => {
  const meals=legacy('Oregano','dried oregano','Lemon','whole lemon')
  const old=buildPreviousShoppingList(meals)
  const removed=removeShoppingItem(old,entries(old).find(x=>x.label==='Oregano (1)'))
  let result=rebuildShoppingList(removed,meals,meals)
  assert.deepEqual(visible(result).map(x=>x.label).sort(),['dried oregano (1)','Lemon (2)'].sort())
  result=rebuildShoppingList(JSON.parse(JSON.stringify(result)),meals,legacy('whole lemon','Lemon','dried oregano','Oregano'))
  assert.equal(visible(result).filter(x=>x.label.includes('oregano')).length,1)
  assert.equal(visible(result).find(x=>x.label.includes('oregano')).label,'dried oregano (1)')
  assert.equal(visible(restoreRemovedShoppingItems(result,meals)).length,2)
})
