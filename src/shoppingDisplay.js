// Read-only Shop presentation. Original items always reach persistence/handlers.
import { asShoppingItem, isShoppingItemVisible } from './shoppingList.js'

export function shoppingDisplayLabel(value) {
  const item = asShoppingItem(value)
  const source = item.legacyGroups?.length === 1 ? item.legacyGroups[0]?.[0] : null
  return item.generated === true && !item.extra && typeof source === 'string' &&
    item.key === item.label && item.label.toLowerCase() === `${source} (1)`.toLowerCase() &&
    item.legacyGroups[0].some(alias => typeof alias === 'string' && alias.toLowerCase() === item.label.toLowerCase())
    ? item.label.slice(0, -4) : item.label
}

function classificationName(value) {
  const item = asShoppingItem(value)
  if (item.generated && item.key.startsWith('shopping:v1:')) {
    try {
      const parts = JSON.parse(item.key.slice('shopping:v1:'.length))
      if (Array.isArray(parts) && parts.length === 3 && parts.every(p => typeof p === 'string')) return parts[0]
    } catch { /* Unknown identities keep their original category. */ }
  }
  const source = item.generated && item.legacyGroups?.length === 1
    ? item.legacyGroups[0]?.[0] : item.label
  return typeof source === 'string' ? source : ''
}

export function shoppingDisplayCategory(item, originalCategory) {
  // This normalization selects a display section only; never use it for matching,
  // quantities, keys, labels, or storage. Ambiguous descriptions fall back.
  const name = classificationName(item).toLowerCase().trim().replace(/\s+/g, ' ')
    .replace(/^(?:\d+ \d+\/[1-9]\d*|\d+\/[1-9]\d*|\d+(?:\.\d+)?)\s+(?:(?:cups?|tablespoons?|tbsp|teaspoons?|tsp|ounces?|oz|pounds?|lbs?|whole|cloves?|fillets?)\s+)?/, '')
    .split(',')[0].trim().replace(/-/g, ' ').replace(/\s+/g, ' ')
  if (/^(?:(?:freshly )?ground |cracked )?black pepper$/.test(name) ||
      /^salt (?:and|&) (?:black )?pepper(?: to taste)?$/.test(name) ||
      /^(?:canned |concentrated |double concentrated )?tomato paste$/.test(name) ||
      /^(?:canned |dried |cooked )?butter beans$/.test(name) || name === 'garlic powder') return 'Pantry'
  if (/^(?:(?:fresh|whole|peeled|minced|chopped|crushed) )*garlic(?: cloves?)?$/.test(name) ||
      /^cloves? (?:of )?garlic$/.test(name)) return 'Produce'
  if (/^(?:fresh |frozen |wild |atlantic |sockeye )*salmon(?: fillets?)?$/.test(name)) return 'Meat'
  return originalCategory
}

export function shoppingDisplayGroups(list) {
  const groups = new Map(['Produce', 'Meat', 'Dairy', 'Pantry', 'Other'].map(name => [name, []]))
  for (const [originalCategory, entries] of Object.entries(list)) {
    for (const item of entries) {
      if (!isShoppingItemVisible(item)) continue
      const category = shoppingDisplayCategory(item, originalCategory)
      if (!groups.has(category)) groups.set(category, [])
      groups.get(category).push(item)
    }
  }
  return [...groups].filter(([, items]) => items.length > 0)
}
