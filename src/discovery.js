// Favorites are deliberately separate from planner data and never contain recipe snapshots.
export const favoritesKey = userId => `dinnerlyst:user:${userId}:favorites:v1`
const validId = id => typeof id === 'string' || (typeof id === 'number' && Number.isFinite(id))
export function loadFavorites(storage, userId) {
  if (!userId) return { ids: [], error: false }
  try {
    const raw = storage.getItem(favoritesKey(userId))
    if (raw === null) return { ids: [], error: false }
    const value = JSON.parse(raw)
    if (value.version !== 1 || value.userId !== userId || !Array.isArray(value.ids) || !value.ids.every(validId)) throw new Error('Invalid favorites')
    return { ids: [...new Set(value.ids)], error: false }
  } catch { return { ids: [], error: true } }
}
export function saveFavorites(storage, owner, current, ids) {
  if (!owner?.userId || owner.userId !== current.userId || owner.generation !== current.generation || !ids.every(validId)) return false
  try {
    storage.setItem(favoritesKey(owner.userId), JSON.stringify({ version: 1, userId: owner.userId, ids: [...new Set(ids)] }))
    return true
  } catch { return false }
}
export function shuffledRecipeIds(recipes, random = Math.random) {
  const ids = [...new Set(recipes.map(recipe => recipe.id))]
  for (let i = ids.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    ;[ids[i], ids[j]] = [ids[j], ids[i]]
  }
  return ids
}
export function swipeAction(start, end) {
  if (!start || !end) return null
  const dx = end.clientX - start.x, dy = end.clientY - start.y
  return Math.abs(dx) >= 70 && Math.abs(dx) > Math.abs(dy) * 1.5 ? (dx < 0 ? 'pass' : 'love') : null
}
