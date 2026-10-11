import { getIngredientRows, formatIngredient } from './ingredients.js'

// Deliberately exact name matching: no quantity parsing or substring guessing.
const singularAliases = {
  eggs: 'egg', tomatoes: 'tomato', potatoes: 'potato', onions: 'onion',
  lemons: 'lemon', limes: 'lime', carrots: 'carrot', avocados: 'avocado',
  'garlic cloves': 'garlic clove',
}
export function normalizePantryName(value) {
  if (typeof value !== 'string') return ''
  const name = value.trim().replace(/\s+/g, ' ').toLowerCase()
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
