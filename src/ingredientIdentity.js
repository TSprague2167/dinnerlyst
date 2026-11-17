// Comparison identities only: stored recipe and Pantry text remains unchanged.
export const cleanIngredientText = value => typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : ''
export const unitAliases = {
  pound: 'lb', pounds: 'lb', lbs: 'lb', lb: 'lb', ounce: 'oz', ounces: 'oz', oz: 'oz',
  cup: 'cup', cups: 'cup', tablespoon: 'tbsp', tablespoons: 'tbsp', tbsp: 'tbsp',
  teaspoon: 'tsp', teaspoons: 'tsp', tsp: 'tsp', clove: 'clove', cloves: 'clove',
  cube: 'cube', cubes: 'cube', whole: 'whole', gram: 'g', grams: 'g', g: 'g',
  kilogram: 'kg', kilograms: 'kg', kg: 'kg', milliliter: 'ml', milliliters: 'ml', ml: 'ml',
  liter: 'l', liters: 'l', l: 'l',
}
export const countNames = ['lemon', 'lime', 'onion', 'egg', 'potato', 'tomato', 'carrot', 'avocado']
export const plurals = { potato: 'potatoes', tomato: 'tomatoes' }
export function parseAmount(value) {
  const text = cleanIngredientText(String(value))
  let result
  if (/^\d+(?:\.\d+)?$/.test(text)) result = Number(text)
  else {
    const match = text.match(/^(?:(\d+)\s+)?(\d+)\/(\d+)$/)
    if (!match || Number(match[3]) === 0) return null
    result = Number(match[1] || 0) + Number(match[2]) / Number(match[3])
  }
  return Number.isFinite(result) ? result : null
}
function isWholeCount(name) {
  return countNames.includes(name) || /^(?:yellow|red|white|green) onion$/.test(name)
}
export function canonicalIngredient(value) {
  let name = cleanIngredientText(value).toLowerCase()
  // Only known whole produce/garlic preparation descriptors are interchangeable.
  const prep = name.match(/^(.*),\s*(?:diced|chopped|minced|sliced|peeled|crushed)$/)
  if (prep && (isWholeCount(canonicalIngredient(prep[1])) || canonicalIngredient(prep[1]) === 'garlic')) name = prep[1]
  const aliases = {
    'garlic cloves': 'garlic', 'garlic clove': 'garlic', 'fresh garlic': 'garlic',
    'fresh garlic cloves': 'garlic', 'fresh garlic clove': 'garlic',
    // Targeted default for the reported duplicate; explicit fresh oregano stays distinct.
    oregano: 'dried oregano',
  }
  if (Object.hasOwn(aliases, name)) return aliases[name]
  const singular = countNames.find(word => name === (plurals[word] || word + 's'))
  if (singular) name = singular
  name = name.replace(/^((?:yellow|red|white|green) onion)s$/, '$1')
  if (name.startsWith('whole ')) {
    const rest = canonicalIngredient(name.slice(6))
    if (isWholeCount(rest)) return rest
  }
  return name
}
export function parseIngredientText(value) {
  const text = cleanIngredientText(value)
  const match = text.toLowerCase().match(/^((?:\d+\s+)?\d+\/\d+|\d+(?:\.\d+)?)\s+(.+)$/)
  if (match && parseAmount(match[1]) !== null) {
    const words = match[2].split(' ')
    const unit = Object.hasOwn(unitAliases, words[0]) ? unitAliases[words[0]] : null
    if (unit && words.length > 1) {
      return { name: canonicalIngredient(words.slice(1).join(' ')), amount: parseAmount(match[1]), unit }
    }
    const name = canonicalIngredient(match[2])
    if (isWholeCount(name)) return { name, amount: parseAmount(match[1]), unit: 'whole' }
  }
  // Do not invent quantities or strip unknown units, ranges or meaningful parentheses.
  return { name: canonicalIngredient(text), amount: null, unit: '' }
}
// No density assumptions, count-to-weight, or US/metric volume conversion.
const measures = {
  tsp: ['us-volume', 1, 'tsp'], tbsp: ['us-volume', 3, 'tsp'], cup: ['us-volume', 48, 'tsp'],
  oz: ['us-mass', 1, 'oz'], lb: ['us-mass', 16, 'oz'],
  g: ['metric-mass', 1, 'g'], kg: ['metric-mass', 1000, 'g'],
  ml: ['metric-volume', 1, 'ml'], l: ['metric-volume', 1000, 'ml'],
}
export function ingredientMeasure(name, rawUnit) {
  const raw = cleanIngredientText(rawUnit).toLowerCase()
  const unit = (Object.hasOwn(unitAliases, raw) ? unitAliases[raw] : raw) || (isWholeCount(name) ? 'whole' : '')
  const [family, factor, base] = Object.hasOwn(measures, unit) ? measures[unit] : ['unit:' + unit, 1, unit]
  return { unit, family, factor, base }
}
