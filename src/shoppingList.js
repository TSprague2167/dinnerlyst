import { formatIngredient, normalizeStructuredIngredients } from './ingredients.js'

const clean = (value) => value.trim().replace(/\s+/g, ' ')
const unitAliases = {
  pound: 'lb', pounds: 'lb', lbs: 'lb', lb: 'lb',
  ounce: 'oz', ounces: 'oz', oz: 'oz', cup: 'cup', cups: 'cup',
  tablespoon: 'tbsp', tablespoons: 'tbsp', tbsp: 'tbsp',
  teaspoon: 'tsp', teaspoons: 'tsp', tsp: 'tsp',
  clove: 'clove', cloves: 'clove', cube: 'cube', cubes: 'cube', whole: 'whole',
}
const countNames = ['lemon', 'lime', 'onion', 'egg', 'potato', 'tomato', 'carrot', 'avocado']
const plurals = { potato: 'potatoes', tomato: 'tomatoes' }
export function parseAmount(value) {
  const text = clean(String(value))
  let result
  if (/^\d+(?:\.\d+)?$/.test(text)) result = Number(text)
  else {
    const match = text.match(/^(?:(\d+)\s+)?(\d+)\/(\d+)$/)
    if (!match || Number(match[3]) === 0) return null
    result = Number(match[1] || 0) + Number(match[2]) / Number(match[3])
  }
  return Number.isFinite(result) ? result : null
}
const quantityText = (amount) => String(Number(amount.toFixed(8)))
function normalizedName(name) {
  const value = clean(name).toLowerCase()
  return countNames.find((word) => value === word || value === (plurals[word] || `${word}s`)) || value
}
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
export function buildShoppingList(meals) {
  const groups = new Map()
  const oldCounts = new Map()
  const sources = []
  for (const { meal } of meals) {
    if (!meal) continue
    const rows = normalizeStructuredIngredients(meal.structured_ingredients)
    const entries = rows ? rows.map(row => ({ row, text: formatIngredient(row) })) :
      (Array.isArray(meal.ingredients) ? meal.ingredients : []).filter(text => typeof text === 'string').map(text => ({ text }))
    for (const entry of entries) {
      if (!entry.text.trim()) continue
      oldCounts.set(entry.text, (oldCounts.get(entry.text) || 0) + 1)
      sources.push(entry)
    }
  }
  for (const { row, text } of sources) {
    const amount = row ? parseAmount(row.amount) : null
    let name = row ? normalizedName(row.ingredient) : text
    const rawUnit = row ? clean(row.unit).toLowerCase() : ''
    const unit = unitAliases[rawUnit] || rawUnit
    if (unit === 'cube' && name.includes('bouillon')) name = name.replace(/ cubes?$/, '')
    // No quantity inference: unquantified or unparseable rows remain opaque.
    const structured = row && amount !== null
    const groupKey = JSON.stringify(structured ? ['structured', name, unit] : ['opaque', text])
    if (!groups.has(groupKey)) groups.set(groupKey, { name, unit, amount: 0, structured, texts: new Set(), count: 0 })
    const group = groups.get(groupKey)
    group.amount += amount || 0
    group.count += 1
    group.texts.add(text)
  }
  const categories = { Produce: [], Meat: [], Dairy: [], Pantry: [], Other: [] }
  for (const group of groups.values()) {
    const { name, unit, amount, structured } = group
    let label = `${name} (${group.count})`
    if (structured) {
      const quantity = quantityText(amount)
      if (unit === 'whole' && countNames.includes(name)) {
        label = `${quantity} ${amount === 1 ? name : plurals[name] || `${name}s`}`
      } else if (unit === 'cube' || unit === 'clove') {
        label = `${name} — ${quantity} ${unit}${amount === 1 ? '' : 's'}`
      } else label = [quantity, unit, name].filter(Boolean).join(' ')
    }
    const key = structured ? `shopping:v1:${JSON.stringify([name, unit, quantityText(amount)])}` : label
    const legacyGroups = [...group.texts].map(text => [text, `${text} (${oldCounts.get(text)})`])
    categories[shoppingCategory(name)].push({ key, label, legacyGroups, generated: true })
  }
  return categories
}

export function refreshWeeklyMeals(meals, recipes) {
  const byId = new Map(recipes.map(recipe => [String(recipe.id), recipe]))
  return meals.map(item => {
    const current = item.meal && byId.get(String(item.meal.id))
    return current && current !== item.meal ? { ...item, meal: current } : item
  })
}

export function rebuildShoppingList(previous, oldMeals, refreshedMeals) {
  const oldGenerated = Object.values(buildShoppingList(oldMeals)).flat()
  const oldLabels = new Set(oldGenerated.map(item => item.label))
  const result = buildShoppingList(refreshedMeals)
  // Retain exact old opaque labels as checkbox aliases only when a single new
  // structured item matches the whole ingredient name (never parse legacy text).
  const newItems = Object.values(result).flat()
  for (const old of oldGenerated) {
    if (old.key.startsWith('shopping:v1:')) continue
    const rawNames = old.legacyGroups.map(group => group[0])
    const matches = newItems.filter(item => item.key.startsWith('shopping:v1:') &&
      rawNames.every(name => normalizedName(name) === JSON.parse(item.key.slice('shopping:v1:'.length))[0]))
    if (matches.length === 1) {
      for (const group of matches[0].legacyGroups) group.push(...shoppingCheckIdentities(old))
    }
  }
  for (const [category, entries] of Object.entries(previous || {})) {
    if (!Array.isArray(entries)) continue
    for (const value of entries) {
      const item = asShoppingItem(value)
      // Old lists have no provenance. Only remove exact reconstructed generated
      // labels; retain all unknown items to avoid losing manually added groceries.
      if (item.extra || (!item.generated && !oldLabels.has(item.label))) {
        if (!result[category]) result[category] = []
        if (!result[category].some(entry => entry.key === item.key)) result[category].push(item)
      }
    }
  }
  // Carry compatibility aliases across later refreshes of the same quantity.
  const priorItems = Object.values(previous || {}).flat().map(asShoppingItem)
  for (const item of newItems) {
    const prior = priorItems.find(entry => entry.key === item.key)
    if (prior?.legacyGroups) {
      item.legacyGroups = item.legacyGroups.map((group, index) =>
        [...new Set([...group, ...(prior.legacyGroups[index] || [])])])
    }
  }
  return result
}
