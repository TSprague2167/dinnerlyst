import { getIngredientRows, formatIngredient } from './ingredients.js'

// Compare whole ingredient names after a bounded quantity/unit prefix removal.
// This is only for Pantry comparisons: never rewrite shopping labels or quantities.
const leadingQuantityAndUnit = /^(?:\d+ \d+\/[1-9]\d*|\d+\/[1-9]\d*|\d+(?:\.\d+)?) (?:cloves?|cups?|tablespoons?|tbsp|teaspoons?|tsp|ounces?|oz|pounds?|lbs?|cubes?|whole) (?=\S)/
const singularAliases = {
  eggs: 'egg', tomatoes: 'tomato', potatoes: 'potato', onions: 'onion',
  lemons: 'lemon', limes: 'lime', carrots: 'carrot', avocados: 'avocado',
  'garlic cloves': 'garlic', 'garlic clove': 'garlic',
}
export function normalizePantryName(value) {
  if (typeof value !== 'string') return ''
  const name = value.trim().replace(/\s+/g, ' ').toLowerCase().replace(leadingQuantityAndUnit, '')
  return singularAliases[name] || name
}
export function pantryHasIngredient(ingredient, pantryNames = []) {
  const name = normalizePantryName(ingredient)
  return Boolean(name) && pantryNames.some(item => normalizePantryName(item) === name)
}

// Pantry cards use ingredient names for matching and formatted rows for display.
export function getPantryRecipeMatch(recipe, pantryNames = []) {
  const rows = getIngredientRows(recipe)
  const missingRows = rows.filter(row => !pantryHasIngredient(row.ingredient, pantryNames))
  const totalCount = rows.length
  const matchedCount = totalCount - missingRows.length
  return {
    ...recipe,
    matchedCount,
    totalCount,
    matchPercentage: totalCount ? Math.round(matchedCount / totalCount * 100) : 0,
    missingIngredients: missingRows.map(formatIngredient),
  }
}
