import { getIngredientRows, formatIngredient } from './ingredients.js'

import { parseIngredientText } from './ingredientIdentity.js'

export function normalizePantryName(value) {
  return typeof value === 'string' ? parseIngredientText(value).name : ''
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
