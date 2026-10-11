export const plannerCacheKey = userId => `dinnerlyst:user:${userId}:planner:v1`
export const emptyPlanner = () => ({ weeklyMeals: [], shoppingList: {}, lockedDays: [] })
const days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const strings = value => Array.isArray(value) && value.every(item => typeof item === 'string')
const shoppingItem = item => typeof item === 'string' || (object(item) && typeof item.key === 'string' && typeof item.label === 'string' &&
  (item.legacyGroups == null || (Array.isArray(item.legacyGroups) && item.legacyGroups.every(strings))))
export function validPlannerCache(value, userId) {
  return Boolean(userId) && object(value) && value.version === 1 && value.userId === userId &&
    Array.isArray(value.weeklyMeals) && value.weeklyMeals.every(entry => object(entry) && days.includes(entry.day) &&
      (entry.meal === null || (object(entry.meal) && ['string', 'number'].includes(typeof entry.meal.id) &&
        typeof entry.meal.name === 'string' && strings(entry.meal.ingredients) &&
        (entry.meal.diet_tags == null || strings(entry.meal.diet_tags)) &&
        (entry.meal.categories == null || strings(entry.meal.categories)) &&
        (entry.meal.image_url == null || typeof entry.meal.image_url === 'string') &&
        (entry.meal.instructions == null || typeof entry.meal.instructions === 'string')))) &&
    new Set(value.weeklyMeals.map(entry => entry.day)).size === value.weeklyMeals.length &&
    object(value.shoppingList) && Object.values(value.shoppingList).every(items => Array.isArray(items) && items.every(shoppingItem)) &&
    strings(value.lockedDays) && value.lockedDays.every(day => days.includes(day))
}
export function discardLegacyCaches(storage) {
  for (const key of ['weeklyMeals', 'shoppingList', 'onboardingComplete', 'onboardingAnswers']) {
    try { storage.removeItem(key) } catch { /* Storage can be unavailable. */ }
  }
}
export function loadPlannerCache(storage, userId) {
  if (!userId) return emptyPlanner()
  try {
    const value = JSON.parse(storage.getItem(plannerCacheKey(userId)))
    if (validPlannerCache(value, userId)) return { weeklyMeals: value.weeklyMeals, shoppingList: value.shoppingList, lockedDays: value.lockedDays }
  } catch { /* Ignore invalid or inaccessible caches. */ }
  try { storage.removeItem(plannerCacheKey(userId)) } catch { /* Storage can be unavailable. */ }
  return emptyPlanner()
}
export function nextAccountOwner(current, userId) {
  return current.userId === userId ? current : { userId, generation: current.generation + 1 }
}
export function isCurrentAccount(owner, current) {
  return owner.userId === current.userId && owner.generation === current.generation
}
export function persistPlannerCache(storage, owner, current, planner) {
  if (!owner?.userId || !isCurrentAccount(owner, current)) return false
  const value = { version: 1, userId: owner.userId, ...planner }
  if (!validPlannerCache(value, owner.userId)) return false
  try { storage.setItem(plannerCacheKey(owner.userId), JSON.stringify(value)); return true } catch { return false }
}
