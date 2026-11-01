import test from 'node:test'
import assert from 'node:assert/strict'
import { shoppingDisplayLabel, shoppingDisplayCategory, shoppingDisplayGroups } from '../src/shoppingDisplay.js'
import { buildShoppingList, isShoppingItemVisible, isShoppingItemChecked, shoppingRemovalKey, shoppingCheckIdentities } from '../src/shoppingList.js'

const generated = text => Object.values(buildShoppingList([{ meal: { ingredients: [text] } }])).flat()[0]
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value) } return value }

test('display hides only singleton suffixes proven by generated metadata', () => {
  for (const source of ['1 yellow onion, diced', 'salt and pepper, to taste', '2 tablespoons tomato paste', 'bread (gluten-free)', 'Box (1)']) {
    const item = freeze(generated(source))
    assert.equal(shoppingDisplayLabel(item), source)
    assert.equal(item.key, `${source} (1)`)
    assert.equal(item.label, `${source} (1)`)
  }
  const item = generated('onion')
  for (const unchanged of ['onion (1)', { ...item, generated: false }, { ...item, extra: true },
    { ...item, legacyGroups: [] }, { ...item, key: 'unrelated' },
    { ...item, legacyGroups: [['different source', item.label]] },
    { ...item, legacyGroups: [['onion']] }]) {
    assert.equal(shoppingDisplayLabel(unchanged), typeof unchanged === 'string' ? unchanged : unchanged.label)
  }
  const repeated = Object.values(buildShoppingList([{ meal: { ingredients: ['onion', 'onion'] } }])).flat()[0]
  assert.equal(shoppingDisplayLabel(repeated), 'onion (2)')
})

test('targeted categories distinguish fresh ingredients, seasonings and lookalikes', () => {
  const cases = [
    ['black pepper','Produce','Pantry'], ['1/2 tsp ground black pepper','Produce','Pantry'],
    ['salt and pepper, to taste','Produce','Pantry'], ['salt-and-pepper','Produce','Pantry'],
    ['2 tablespoons tomato paste','Produce','Pantry'], ['butter beans','Dairy','Pantry'],
    ['garlic powder','Other','Pantry'], ['3 cloves garlic','Other','Produce'],
    ['fresh garlic','Other','Produce'], ['garlic cloves','Other','Produce'],
    ['4 fillets salmon','Other','Meat'], ['frozen salmon fillets','Other','Meat'],
    ['butter','Dairy','Dairy'], ['red bell pepper','Produce','Produce'],
    ['garlic butter','Dairy','Dairy'], ['garlic salt','Other','Other'],
    ['salmon sauce','Pantry','Pantry'], ['tomato paste sauce','Produce','Produce'],
    ['butter bean salad dressing','Dairy','Dairy'], ['black peppercorn sauce','Pantry','Pantry'],
    ['yellow onion','Produce','Produce'], ['rice','Pantry','Pantry'],
  ]
  for (const [text, original, expected] of cases) assert.equal(shoppingDisplayCategory(generated(text),original),expected,text)
  const structured = Object.values(buildShoppingList([{meal:{structured_ingredients:[{amount:'3',unit:'cloves',ingredient:'garlic'}]}}])).flat()[0]
  assert.equal(shoppingDisplayCategory(structured, 'Other'), 'Produce')
})

test('display grouping preserves every visible reference, identity, quantity and check state', () => {
  const list = { Produce:[generated('black pepper'),generated('1 yellow onion, diced')],
    Meat:[], Dairy:[generated('butter beans'), generated('butter')], Pantry:[generated('red bell pepper')],
    Other:[generated('salmon'),generated('garlic'),{...generated('garlic powder'),userRemoved:true},
      {...generated('tomato paste'),pantryHidden:true}, 'manual groceries (1)'] }
  const before = structuredClone(list)
  const visible = Object.values(list).flat().filter(isShoppingItemVisible)
  const checked = visible.filter((_,i)=>i%2===0).map(x=>typeof x==='string'?x:x.key)
  const ids = visible.map(x=>[shoppingRemovalKey(x),shoppingCheckIdentities(x)])
  freeze(list)
  const grouped = shoppingDisplayGroups(list)
  const after = grouped.flatMap(([,items])=>items)
  assert.equal(after.length,visible.length)
  for (const item of visible) assert.equal(after.filter(x=>x===item).length,1)
  assert.deepEqual(list,before)
  assert.equal(after.filter(x=>isShoppingItemChecked(x,checked)).length,visible.filter(x=>isShoppingItemChecked(x,checked)).length)
  assert.deepEqual(visible.map(x=>[shoppingRemovalKey(x),shoppingCheckIdentities(x)]),ids)
  assert.equal(grouped.find(([name])=>name==='Meat')[1][0],list.Other[0])
  assert.equal(grouped.find(([name])=>name==='Pantry')[1].includes(list.Produce[0]),true)
  assert.equal(shoppingDisplayLabel(list.Other.at(-1)),'manual groceries (1)')
})

test('regrouping never deduplicates distinct source rows or drops unfamiliar categories', () => {
  const first = generated('black pepper'), second = {...first}
  const list = freeze({Produce:[first], Other:[second], Special:[{key:'tea',label:'tea',extra:true}]})
  const result = shoppingDisplayGroups(list)
  assert.equal(result.find(([name])=>name==='Pantry')[1].length,2)
  assert.equal(result.find(([name])=>name==='Special')[1][0],list.Special[0])
  assert.equal(result.flatMap(([,items])=>items).length,3)
})


test('singleton provenance accepts case differences without rewriting stored ingredients or identities', () => {
  for (const source of ['Pasta noodles', 'PaStA NoOdLeS', 'SALT and Pepper, to Taste', 'Bread (Gluten-Free)']) {
    const item = Object.values(buildShoppingList([{meal:{structured_ingredients:[{amount:'',unit:'',ingredient:source}]}}])).flat()[0]
    const original = structuredClone(item)
    freeze(item)
    assert.equal(shoppingDisplayLabel(item), item.label.slice(0, -4))
    assert.deepEqual(item, original)
    assert.deepEqual(shoppingCheckIdentities(item), shoppingCheckIdentities(original))
    assert.equal(shoppingRemovalKey(item), shoppingRemovalKey(original))
  }
  for (const label of ['Pasta noodles (1)', 'Bread (Gluten-Free)', 'Box (1)', 'Vitamin B12 (1)']) {
    const manual = freeze({key:label,label,extra:true,legacyGroups:[[label]]})
    assert.equal(shoppingDisplayLabel(manual),label)
    assert.equal(shoppingDisplayLabel(label),label)
  }
  const repeated = Object.values(buildShoppingList([{meal:{structured_ingredients:[
    {amount:'',unit:'',ingredient:'Pasta noodles'}, {amount:'',unit:'',ingredient:'Pasta noodles'}]}}])).flat()[0]
  assert.equal(shoppingDisplayLabel(repeated), 'pasta noodles (2)')
  const incomplete = {key:'pasta noodles (1)',label:'pasta noodles (1)',generated:true,legacyGroups:[['Pasta noodles']]}
  assert.equal(shoppingDisplayLabel(incomplete),'pasta noodles (1)')
})
