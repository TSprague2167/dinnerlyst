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
