import test from 'node:test'
import assert from 'node:assert/strict'
import { favoritesKey, loadFavorites, saveFavorites, shuffledRecipeIds, swipeAction } from '../src/discovery.js'
const storage = () => { const values = new Map(); return { values, getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) } }

test('shuffle keeps each ID exactly once without mutating recipes', () => {
  const recipes = [{id:1},{id:2},{id:3},{id:1}], before = structuredClone(recipes)
  const ids = shuffledRecipeIds(recipes, () => 0)
  assert.deepEqual(new Set(ids), new Set([1,2,3])); assert.equal(ids.length,3)
  assert.deepEqual(recipes,before); assert.notDeepEqual(ids,[1,2,3])
  assert.deepEqual(shuffledRecipeIds([]),[])
})
test('favorites persist separately for each account, deduplicate and reject stale owners', () => {
  const s=storage(), a={userId:'A',generation:1}, b={userId:'B',generation:2}
  s.setItem('planner','untouched')
  assert.equal(saveFavorites(s,a,a,[1,1,2]),true)
  assert.deepEqual(loadFavorites(s,'A'),{ids:[1,2],error:false})
  assert.deepEqual(loadFavorites(s,'B'),{ids:[],error:false})
  assert.equal(saveFavorites(s,a,b,[3]),false)
  assert.equal(saveFavorites(s,{userId:'A',generation:0},a,[3]),false)
  assert.equal(s.getItem('planner'),'untouched')
  assert.deepEqual(loadFavorites(s,null),{ids:[],error:false})
})
test('unavailable, malformed and wrong-owner favorites never get silently erased', () => {
  const s=storage()
  for(const raw of ['invalid', 'null', JSON.stringify({version:1,userId:'B',ids:[1]}),JSON.stringify({version:1,userId:'A',ids:[{}]})]) {
    s.setItem(favoritesKey('A'),raw)
    assert.equal(loadFavorites(s,'A').error,true)
    assert.equal(s.getItem(favoritesKey('A')),raw)
  }
  assert.equal(loadFavorites(null,'A').error,true)
  assert.equal(saveFavorites(null,{userId:'A',generation:1},{userId:'A',generation:1},[1]),false)
})
test('discovery gestures require horizontal intent and preserve vertical scrolling', () => {
  const start={x:150,y:100}
  assert.equal(swipeAction(start,{clientX:50,clientY:105}),'pass')
  assert.equal(swipeAction(start,{clientX:250,clientY:105}),'love')
  for(const end of [{clientX:160,clientY:100},{clientX:160,clientY:250},{clientX:250,clientY:200}]) assert.equal(swipeAction(start,end),null)
  assert.equal(swipeAction(null,{clientX:200,clientY:100}),null)
})
