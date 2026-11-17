// Frozen pre-normalization renderer, used only to recognize historical cached labels.
// Never generate a new shopping list with this compatibility helper.
import { formatIngredient, normalizeStructuredIngredients } from './ingredients.js'
import { parseAmount } from './ingredientIdentity.js'
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
const quantityText = (amount) => String(Number(amount.toFixed(8)))
function normalizedName(name) {
  const value = clean(name).toLowerCase()
  return countNames.find((word) => value === word || value === (plurals[word] || `${word}s`)) || value
}
export function buildPreviousShoppingList(meals) {
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
    categories.Other.push({ key, label, legacyGroups, generated: true })
  }
  return categories
}
