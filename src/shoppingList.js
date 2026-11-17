import { pantryHasIngredient } from './pantry.js'
import { formatIngredient, normalizeStructuredIngredients } from './ingredients.js'

import { canonicalIngredient, parseIngredientText, ingredientMeasure, parseAmount, countNames, plurals } from './ingredientIdentity.js'
import { buildPreviousShoppingList } from './shoppingLegacy.js'
export { parseAmount } from './ingredientIdentity.js'
const quantityText = amount => String(Number(amount.toFixed(8)))
export function shoppingCategory(name) {
  const value = name.toLowerCase()
  if (value.includes('bouillon')) return 'Pantry'
  if (['lettuce','tomato','onion','pepper','potato','carrot','spinach','avocado','lemon','lime'].some(word => value.includes(word))) return 'Produce'
  if (['beef','chicken','pork','turkey','sausage','bacon'].some(word => value.includes(word))) return 'Meat'
  if (['cheese','milk','cream','yogurt','butter'].some(word => value.includes(word))) return 'Dairy'
  if (['rice','pasta','noodle','tortilla','bread','sauce','beans'].some(word => value.includes(word))) return 'Pantry'
  return 'Other'
}
export function asShoppingItem(item) {
  return typeof item === 'string' ? { key: item, label: item, legacyGroups: [[item]] } : item
}
export function isShoppingItemChecked(item, checked) {
  const entry = asShoppingItem(item)
  return checked.includes(entry.key) || (entry.legacyGroups?.length > 0 &&
    entry.legacyGroups.every(group => group.some(alias => checked.includes(alias))))
}
export function shoppingCheckIdentities(item) {
  const entry = asShoppingItem(item)
  return [...new Set([entry.key, ...(entry.legacyGroups || []).flat()])]
}
// Removal identities are separate from quantity-sensitive checked-item keys.
export function shoppingRemovalKey(value) {
  const item = asShoppingItem(value)
  if (item.extra || !item.generated) return JSON.stringify(['extra', item.key])
  if (item.key.startsWith('shopping:v1:')) {
    try {
      const parts = JSON.parse(item.key.slice('shopping:v1:'.length))
      if (Array.isArray(parts) && parts.length === 3 && parts.every(part => typeof part === 'string')) {
        const name = canonicalIngredient(parts[0])
        return JSON.stringify(['structured', name, ingredientMeasure(name, parts[1]).family])
      }
    } catch { /* A legacy key remains exact rather than guessed. */ }
  }
  return JSON.stringify(['legacy', item.legacyGroups?.[0]?.[0] ?? item.key])
}
export function isShoppingItemVisible(value) {
  const item = asShoppingItem(value)
  return !item.pantryHidden && !item.userRemoved
}
function mapShoppingItems(list, transform) {
  return Object.fromEntries(Object.entries(list).map(([category, entries]) => [category, entries.map(item => transform(asShoppingItem(item)))]))
}
export function removeShoppingItem(list, value) {
  const identity = shoppingRemovalKey(value)
  return mapShoppingItems(list, item => shoppingRemovalKey(item) === identity ? { ...item, userRemoved: true } : item)
}
function clearShoppingRemoval(item) {
  const restored = { ...item }
  delete restored.userRemoved
  return restored
}
export function restoreRemovedShoppingItems(list, meals, pantryNames = []) {
  return rebuildShoppingList(mapShoppingItems(list, clearShoppingRemoval), meals, meals, pantryNames)
}
function itemHasSource(item, source) {
  return item.label === source || (item.generated && item.legacyGroups?.some(group => group[0] === source))
}
export function shoppingContainsIngredient(list, source) {
  return Object.values(list).flat().some(value => isShoppingItemVisible(value) && itemHasSource(asShoppingItem(value), source))
}
export function addMissingShoppingItems(list, missingIngredients, meals, pantryNames = []) {
  const removed = new Set(Object.values(list).flat().map(asShoppingItem)
    .filter(item => item.userRemoved && missingIngredients.some(source => itemHasSource(item, source)))
    .map(shoppingRemovalKey))
  const restored = removed.size ? rebuildShoppingList(mapShoppingItems(list, item =>
    removed.has(shoppingRemovalKey(item)) ? clearShoppingRemoval(item) : item), meals, meals, pantryNames) : list
  const result = { ...restored, Other: [...(restored.Other || [])] }
  for (const source of missingIngredients) {
    if (!shoppingContainsIngredient(result, source)) result.Other.push({ ...asShoppingItem(source), extra: true })
  }
  return result
}

export function buildShoppingList(meals, pantryNames = [], excludedSources = new Set()) {
  const groups = new Map(), oldCounts = new Map()
  for (const { meal } of meals) {
    if (!meal) continue
    const rows = normalizeStructuredIngredients(meal.structured_ingredients)
    const entries = rows ? rows.map(row => ({ row, text: formatIngredient(row) })) :
      (Array.isArray(meal.ingredients) ? meal.ingredients : []).filter(text => typeof text === 'string').map(text => ({ text }))
    for (const { row, text } of entries) {
      if (!text.trim() || excludedSources.has(text) || pantryHasIngredient(row?.ingredient ?? text, pantryNames)) continue
      oldCounts.set(text, (oldCounts.get(text) || 0) + 1)
      const parsed = parseIngredientText(text)
      const explicitAmount = row ? parseAmount(row.amount) : null
      const amount = explicitAmount ?? parsed.amount
      let name = explicitAmount !== null ? canonicalIngredient(row.ingredient) : parsed.name
      const measure = ingredientMeasure(name, explicitAmount !== null ? row.unit : parsed.unit)
      if (measure.unit === 'cube' && name.includes('bouillon')) name = name.replace(/ cubes?$/, '')
      const structured = amount !== null
      const groupKey = JSON.stringify([structured ? 'structured' : 'opaque', name, structured ? measure.family : ''])
      if (!groups.has(groupKey)) {
        groups.set(groupKey, { name, structured, amount: 0, texts: new Set(), units: new Set(), measure, count: 0, label: row ? name : text })
      }
      const group = groups.get(groupKey)
      group.amount += (amount || 0) * measure.factor
      group.count++
      group.texts.add(text)
      group.units.add(measure.unit)
    }
  }
  const categories = { Produce: [], Meat: [], Dairy: [], Pantry: [], Other: [] }
  for (const group of groups.values()) {
    const { name, structured } = group
    // Keep existing single-unit labels/keys; only mixed compatible units use a base unit.
    const unit = group.units.size === 1 ? group.measure.unit : group.measure.base
    const amount = group.amount / (group.units.size === 1 ? group.measure.factor : 1)
    let label = `${group.label} (${group.count})`
    if (structured) {
      const quantity = quantityText(amount)
      if (unit === 'whole' && countNames.includes(name)) label = `${quantity} ${amount === 1 ? name : plurals[name] || name + 's'}`
      else if (unit === 'cube' || unit === 'clove') label = `${name} — ${quantity} ${unit}${amount === 1 ? '' : 's'}`
      else label = [quantity, unit, name].filter(Boolean).join(' ')
    }
    const key = structured ? `shopping:v1:${JSON.stringify([name, unit, quantityText(amount)])}` : label
    const legacyGroups = [...group.texts].map(text => [text, `${text} (${oldCounts.get(text)})`])
    const sourceCounts = [...group.texts].map(text => [text, oldCounts.get(text)])
    categories[shoppingCategory(name)].push({ key, label, legacyGroups, sourceCounts, generated: true })
  }
  return categories
}

function sourceCounts(item) {
  if (Array.isArray(item.sourceCounts)) return new Map(item.sourceCounts)
  const counts = new Map()
  for (const group of item.legacyGroups || []) {
    const text = group[0]
    const suffix = group.find(alias => typeof alias === 'string' && alias.startsWith(text + ' (') && /^ \(\d+\)$/.test(alias.slice(text.length)))
    if (!suffix) return null
    counts.set(text, Number(suffix.slice(text.length + 2, -1)))
  }
  return counts.size ? counts : null
}
function physicalKey(item) {
  if (!item.key.startsWith('shopping:v1:')) return null
  try {
    const [rawName, unit, amount] = JSON.parse(item.key.slice('shopping:v1:'.length))
    const name = canonicalIngredient(rawName), measure = ingredientMeasure(name, unit), value = parseAmount(amount)
    return value === null ? null : JSON.stringify([name, measure.family, quantityText(value * measure.factor)])
  } catch { return null }
}
function preserveChecks(items, priorItems) {
  for (const item of items) {
    for (const prior of priorItems) {
      if (!prior.generated || prior.extra) continue
      const oldCounts = sourceCounts(prior), counts = sourceCounts(item)
      const samePhysical = physicalKey(prior) !== null && physicalKey(prior) === physicalKey(item)
      const covered = oldCounts && counts && [...oldCounts].every(([text, count]) => counts.get(text) === count)
      // Preserve the existing opaque-to-structured compatibility rule, but only
      // for unquantified names with exactly one possible new measured item.
      const rawNames = (prior.legacyGroups || []).map(group => group[0])
      const candidates = !prior.key.startsWith('shopping:v1:') && rawNames.length &&
        rawNames.every(text => parseIngredientText(text).amount === null) &&
        !items.some(entry => !entry.key.startsWith('shopping:v1:') &&
          entry.legacyGroups.some(group => rawNames.includes(group[0]))) ? items.filter(entry =>
          entry.key.startsWith('shopping:v1:') && rawNames.every(text =>
            canonicalIngredient(text) === JSON.parse(entry.key.slice('shopping:v1:'.length))[0])) : []
      const migrated = candidates.length === 1 && candidates[0] === item
      for (const group of item.legacyGroups) {
        // Keep AND semantics between source groups: checking one former item
        // must not check a newly merged item that still has unchecked sources.
        if (samePhysical || migrated || (covered && oldCounts.has(group[0]))) group.push(prior.key)
        if (covered) {
          const previous = prior.legacyGroups?.find(old => old[0] === group[0])
          if (previous) group.push(...previous)
        }
        group.splice(0, group.length, ...new Set(group))
      }
    }
  }
}

export function refreshWeeklyMeals(meals, recipes) {
  const byId = new Map(recipes.map(recipe => [String(recipe.id), recipe]))
  return meals.map(item => {
    const current = item.meal && byId.get(String(item.meal.id))
    return item.meal ? { ...item, meal: current || null } : item
  })
}

export function rebuildShoppingList(previous, oldMeals, refreshedMeals, pantryNames = []) {
  const priorItems = Object.values(previous || {}).flat().map(asShoppingItem)
  const removed = new Set(priorItems.filter(item => item.userRemoved).map(shoppingRemovalKey))
  const applyRemovals = list => mapShoppingItems(list, item =>
    removed.has(shoppingRemovalKey(item)) ? { ...item, userRemoved: true } : item)
  const oldGenerated = [
    ...Object.values(buildShoppingList(oldMeals)).flat(),
    ...Object.values(buildPreviousShoppingList(oldMeals)).flat(),
  ]
  const provenance = priorItems.map(item => item.generated || item.extra ? item :
    oldGenerated.find(old => old.label === item.label) || item)
  const generated = buildShoppingList(refreshedMeals)
  // An older removed item can now join a normalized total. Exclude only its
  // original sources, preserving the other former item's visible contribution.
  const excludedSources = new Set()
  for (const prior of provenance) {
    if (!prior.userRemoved || !prior.generated || prior.key.startsWith('shopping:v1:')) continue
    const sources = new Set((prior.legacyGroups || []).map(group => group[0]))
    for (const item of Object.values(generated).flat()) {
      const matching = item.legacyGroups.filter(group => sources.has(group[0]))
      if (matching.length && (item.key.startsWith('shopping:v1:') ||
          shoppingRemovalKey(item) !== shoppingRemovalKey(prior) ||
          item.legacyGroups.some(group => !sources.has(group[0])))) {
        for (const group of matching) excludedSources.add(group[0])
      }
    }
  }
  const oldLabels = new Set(oldGenerated.map(item => item.label))
  const result = excludedSources.size ? buildShoppingList(refreshedMeals, [], excludedSources) : generated
  const newItems = Object.values(result).flat()
  preserveChecks(newItems, provenance)
  for (const [category, entries] of Object.entries(previous || {})) {
    if (!Array.isArray(entries)) continue
    for (const value of entries) {
      const item = asShoppingItem(value)
      // Old lists have no provenance. Only remove exact reconstructed generated
      // labels; retain all unknown items to avoid losing manually added groceries.
      if (item.userRemoved) {
        // Keep a marker even when no current recipe needs this ingredient.
        // A changed aggregate quantity can reuse the marker's removal identity.
        const represented = Object.values(result).flat().some(entry => shoppingRemovalKey(entry) === shoppingRemovalKey(item))
        if (!represented) {
          if (!result[category]) result[category] = []
          result[category].push(item)
        }
      } else if (item.extra || (!item.generated && !oldLabels.has(item.label))) {
        if (!result[category]) result[category] = []
        if (!result[category].some(entry => entry.key === item.key)) result[category].push(item)
      }
    }
  }
  if (!pantryNames.length) return applyRemovals(result)
  const visible = buildShoppingList(refreshedMeals, pantryNames, excludedSources)
  const visibleByKey = new Map(Object.values(visible).flat().map(item => [item.key, item]))
  for (const [category, entries] of Object.entries(result)) {
    visible[category] ||= []
    for (const item of entries) {
      if (!item.generated || item.extra) {
        visible[category].push(item)
      } else if (visibleByKey.has(item.key)) {
        visibleByKey.get(item.key).legacyGroups = item.legacyGroups
      } else {
        // Retain only invisible checkbox metadata so pantry removal/refresh can
        // restore compatibility aliases without touching persisted checked rows.
        visible[category].push({ ...item, pantryHidden: true })
      }
    }
  }
  return applyRemovals(visible)
}
