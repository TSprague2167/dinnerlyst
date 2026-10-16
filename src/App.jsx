import { useCallback, useEffect, useRef, useState } from "react"
import { supabase } from './supabase'
import './App.css'
import { discardLegacyCaches, loadPlannerCache, persistPlannerCache, nextAccountOwner, isCurrentAccount } from './accountState'
import { getPantryRecipeMatch } from './pantry'
import { refreshWeeklyMeals, rebuildShoppingList, asShoppingItem, isShoppingItemChecked, shoppingCheckIdentities } from './shoppingList'
import { emptyIngredientRow, getIngredientRows, formatIngredient, rowsFromIngredientStrings, validateIngredientRows } from './ingredients'


const allergySafeTags = [
  "Gluten-Free", "Dairy-Free", "Peanut-Free", "Tree Nut-Free",
  "Shellfish-Free", "Egg-Free", "Soy-Free",
]

function getAllergyValues(allergies) {
  // Keep legacy strings intact: never split, trim, or discard saved values.
  return Array.isArray(allergies) ? allergies : allergies == null ? [] : [allergies]
}

function getRequiredAllergyTags(allergies = []) {
  return getAllergyValues(allergies).filter((tag) => allergySafeTags.includes(tag))
}

function plannerStorage() {
  try { return window.localStorage } catch { return null }
}

const defaultOnboardingAnswers = () => ({
  householdSize: 2,
  dietPreferences: [],
  allergies: [],
  dislikedFoods: "",
  cookingStyle: ""
})

function App() {
  const [session, setSession] = useState(null)
  const accountRef = useRef({ userId: null, generation: 0 })
  const [plannerOwner, setPlannerOwner] = useState(null)
  const userId = session?.user?.id || null
  const accountGeneration = plannerOwner?.generation ?? null
  const ownsAccount = useCallback(owner => isCurrentAccount(owner, accountRef.current), [])
  const [authReady, setAuthReady] = useState(false)
  const [authLoadError, setAuthLoadError] = useState(null)
  const [preferenceLoad, setPreferenceLoad] = useState(null)
  const [preferenceRetry, setPreferenceRetry] = useState(0)
  const [authEmail, setAuthEmail] = useState("")
  const [authPassword, setAuthPassword] = useState("")
  const [recipes, setRecipes] = useState([])
  const [recipeName, setRecipeName] = useState("")
  const [ingredientRows, setIngredientRows] = useState(() => [emptyIngredientRow()])
  const [instructions, setInstructions] = useState("")
  const [dietTags, setDietTags] = useState([])
  const [viewingRecipe, setViewingRecipe] = useState(null)
  const [expandedRecipeId, setExpandedRecipeId] = useState(null)
  const [pantryAddFeedback, setPantryAddFeedback] = useState({})
  const [bestMatchFeedback, setBestMatchFeedback] = useState(null)
  const [swapOptions, setSwapOptions] = useState(null)
  const [touchStartX, setTouchStartX] = useState(null)
  const [touchEndX, setTouchEndX] = useState(null)
  const [swipingDay, setSwipingDay] = useState(null)
  const [swipeOffsetX, setSwipeOffsetX] = useState(0)
  const [imageUrl, setImageUrl] = useState("")
  const [pantryItems, setPantryItems] = useState([])
  const [pantryLoadedSession, setPantryLoadedSession] = useState(null)
  const pantrySnapshotRef = useRef({ userId: null, items: [] })
  const [weeklyMeals, setWeeklyMeals] = useState([])
  const weeklyMealsRef = useRef(weeklyMeals)
  const [lockedDays, setLockedDays] = useState([])
  const [recipeUrl, setRecipeUrl] = useState("");
  const [searchTerm, setSearchTerm] = useState("")
  const [pantrySearch, setPantrySearch] = useState("")
  const [activeTab, setActiveTab] = useState("planner")
  const [category, setCategory] = useState("Dinner")
  const [shoppingList, setShoppingList] = useState({})
 const [checkedShoppingItems, setCheckedShoppingItems] = useState([])
const [onboardingStep, setOnboardingStep] = useState(1)
const [onboardingAnswers, setOnboardingAnswers] = useState(defaultOnboardingAnswers)

  const [selectedCategory, setSelectedCategory] = useState("All")
  const [imageFile, setImageFile] = useState(null)
  const recipeBuilderRef = useRef(null)
  const pendingEditScroll = useRef(false)
  const recipeDraftGeneration = useRef(0)
  const recipeSaveOperation = useRef(null)
  const [recipeSaving, setRecipeSaving] = useState(false)
  const [recipeFormGeneration, setRecipeFormGeneration] = useState(0)
  const [selectedCategories, setSelectedCategories] = useState([])

  const currentShoppingItems = Object.values(shoppingList).flat().filter((item) => !asShoppingItem(item).pantryHidden)
  const checkedShoppingCount = currentShoppingItems.filter((item) =>
    isShoppingItemChecked(item, checkedShoppingItems)
  ).length

  const daysOfWeek = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]
const [editingRecipeId, setEditingRecipeId] = useState(null)
  useEffect(() => {
    let active = true
    let authEventReceived = false
    function transitionAccount(nextSession) {
      const nextId = nextSession?.user?.id || null
      const previous = accountRef.current
      const owner = nextAccountOwner(previous, nextId)
      if (owner !== previous) {
        accountRef.current = owner
        setPlannerOwner(null)
        setRecipes([])
        recipeSaveOperation.current = null
        setRecipeSaving(false)
        resetRecipeDraft()
        setViewingRecipe(null)
        setExpandedRecipeId(null)
        setPantryAddFeedback({})
        setBestMatchFeedback(null)
        setSwapOptions(null)
        setPantryItems([])
        setPantryLoadedSession(null)
        pantrySnapshotRef.current = { userId: null, items: [] }
        setCheckedShoppingItems([])
        setOnboardingAnswers(defaultOnboardingAnswers())
        setOnboardingStep(1)
        setPreferenceLoad(null)
        setPreferenceRetry(0)
        setSearchTerm("")
        setPantrySearch("")
        setSelectedCategory("All")
        setCategory("Dinner")
        setActiveTab("planner")
        setTouchStartX(null)
        setTouchEndX(null)
        setSwipingDay(null)
        setSwipeOffsetX(0)
        setAuthEmail("")
        setAuthPassword("")
        const planner = loadPlannerCache(plannerStorage(), nextId)
        weeklyMealsRef.current = planner.weeklyMeals
        setWeeklyMeals(planner.weeklyMeals)
        setShoppingList(planner.shoppingList)
        setLockedDays(planner.lockedDays)
        if (nextId) setPlannerOwner(owner)
      }
      setSession(nextSession)
    }
    discardLegacyCaches(plannerStorage())
    supabase.auth.getSession().then(({ data, error }) => {
      if (!active || authEventReceived) return
      setAuthLoadError(error?.message || null)
      transitionAccount(data?.session || null)
      setAuthReady(true)
    }).catch((error) => {
      if (!active || authEventReceived) return
      setAuthLoadError(error.message)
      setAuthReady(true)
    })

    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => {
      authEventReceived = true
      setAuthLoadError(null)
      transitionAccount(session)
      setAuthReady(true)
    })

    return () => {
      active = false
      listener.subscription.unsubscribe()
    }
  }, [])
  useEffect(() => {
    let active = true
    async function loadPantryItems() {
      const owner = accountRef.current
      if (owner.userId !== userId || (userId && owner.generation !== accountGeneration)) return
      pantrySnapshotRef.current = { userId, items: [] }
      setPantryItems([])
      setPantryLoadedSession(null)
      if (!userId) return
      try {
        const { data, error } = await supabase
          .from("pantry_items")
          .select("item_name")
          .eq("user_id", owner.userId)
        if (!active || !ownsAccount(owner)) return
        if (error) throw error
        const items = (data || []).map((item) => item.item_name)
        pantrySnapshotRef.current = { userId, items }
        setPantryItems(items)
        setPantryLoadedSession(userId)
      } catch (error) {
        if (active && ownsAccount(owner)) console.error("Error loading pantry items:", error)
      }
    }
    loadPantryItems()
    return () => { active = false }
  }, [userId, accountGeneration, ownsAccount])
  useEffect(() => {
    async function rebuildForPantry() {
      if (!plannerOwner || !ownsAccount(plannerOwner) || !userId || pantryLoadedSession !== userId) return
      pantrySnapshotRef.current = { userId, items: pantryItems }
      const owner = accountRef.current
      setShoppingList((previous) => ownsAccount(owner) ? rebuildShoppingList(previous, weeklyMeals, weeklyMeals, pantryItems) : previous)
    }
    rebuildForPantry()
  }, [userId, plannerOwner, pantryLoadedSession, pantryItems, weeklyMeals, ownsAccount])
useEffect(() => {
  let active = true
  async function loadCheckedShoppingItems() {
    const owner = accountRef.current
    if (owner.userId !== userId || (userId && owner.generation !== accountGeneration)) return
    if (!userId) {
      setCheckedShoppingItems([])
      return
    }

    const { data, error } = await supabase
      .from("checked_shopping_items")
      .select("item_name")
      .eq("user_id", owner.userId)

    if (!active || !ownsAccount(owner)) return
    if (error) {
      console.error("Error loading checked shopping items:", error)
      return
    }

    setCheckedShoppingItems(
      (data || []).map((item) => item.item_name)
    )
  }

  loadCheckedShoppingItems()
  return () => { active = false }
}, [userId, accountGeneration, ownsAccount])

  useEffect(() => {
    if (!plannerOwner || !ownsAccount(plannerOwner)) return
    weeklyMealsRef.current = weeklyMeals
    persistPlannerCache(plannerStorage(), plannerOwner, accountRef.current, { weeklyMeals, shoppingList, lockedDays })
  }, [weeklyMeals, shoppingList, lockedDays, plannerOwner, ownsAccount])

  useEffect(() => {
    let active = true
    async function loadPreferences() {
      const owner = accountRef.current
      if (owner.userId !== userId || (userId && owner.generation !== accountGeneration)) return
      if (!userId) {
        setOnboardingAnswers(defaultOnboardingAnswers())
        setOnboardingStep(1)
        setPreferenceLoad(null)
        return
      }
      setOnboardingAnswers(defaultOnboardingAnswers())
      setOnboardingStep(1)
      setPreferenceLoad({ userId, status: "loading" })
      try {
        const { data, error } = await supabase
          .from("user_preferences")
          .select("*")
          .eq("user_id", owner.userId)
          .maybeSingle()
        if (!active || !ownsAccount(owner)) return
        if (error) throw error
        if (data) {
          setOnboardingAnswers({
            householdSize: data.household_size,
            dietPreferences: data.diet_preferences || [],
            allergies: data.allergies,
            dislikedFoods: data.disliked_foods || "",
            cookingStyle: data.cooking_style || ""
          })
        }
        setOnboardingStep(data ? 0 : 1)
        setPreferenceLoad({ userId, status: "ready" })
      } catch (error) {
        if (!active || !ownsAccount(owner)) return
        console.error("Error loading preferences:", error)
        setPreferenceLoad({ userId, status: "error", message: error.message })
      }
    }
    loadPreferences()
    return () => { active = false }
  }, [userId, accountGeneration, preferenceRetry, ownsAccount])

  async function signUp() {
    const owner = accountRef.current
    const { error } = await supabase.auth.signUp({
      email: authEmail,
      password: authPassword
    })
    if (!ownsAccount(owner)) return

    if (error) {
      alert(error.message)
      console.log(error)
      return
    }

    alert("Check your email to confirm your account.")
  }

  async function login() {
    const owner = accountRef.current
    const { error } = await supabase.auth.signInWithPassword({
      email: authEmail,
      password: authPassword
    })
    if (!ownsAccount(owner)) return

    if (error) {
      alert(error.message)
      return
    }

    setAuthEmail("")
    setAuthPassword("")
  }

  async function logout() {
    if (!plannerOwner || !ownsAccount(plannerOwner)) return
    await supabase.auth.signOut()
  }

  const getRecipes = useCallback(async (owner = accountRef.current) => {
    if (!owner.userId || !ownsAccount(owner)) return
    const { data, error } = await supabase.from('recipes').select('*')
 .or(`user_id.eq.${owner.userId},user_id.is.null`)
    if (!ownsAccount(owner)) return
    if (error) {
      console.log(error)
      return
    }

    const savedRecipes = data.map((recipe) => {
      const rows = getIngredientRows(recipe)
      return {
        id: recipe.id,
        user_id: recipe.user_id,
        name: recipe.name,
        categories: recipe.categories || [],
        diet_tags: recipe.diet_tags || [],
        image_url: recipe.image_url || "",
        instructions: recipe.instructions || "",
        structured_ingredients: rows,
        ingredients: rows.map(formatIngredient),
      }
    })

    setRecipes(savedRecipes)
    const previousMeals = weeklyMealsRef.current
    if (previousMeals.length) {
      const refreshed = refreshWeeklyMeals(previousMeals, savedRecipes)
      setWeeklyMeals(refreshed)
      setShoppingList((previous) => ownsAccount(owner) ? rebuildShoppingList(previous, previousMeals, refreshed, pantrySnapshotRef.current.userId === owner.userId ? pantrySnapshotRef.current.items : []) : previous)
    }
  }, [ownsAccount])
  useEffect(() => {
    const owner = accountRef.current
    if (userId && owner.userId === userId && owner.generation === accountGeneration) getRecipes(owner)
  }, [userId, accountGeneration, getRecipes])

useEffect(() => {
  if (!pendingEditScroll.current || !editingRecipeId || activeTab !== "recipes" || !recipeBuilderRef.current) return
  pendingEditScroll.current = false
  recipeBuilderRef.current.scrollIntoView({ behavior: "smooth", block: "start" })
}, [editingRecipeId, recipeFormGeneration, activeTab])

function resetRecipeDraft() {
  pendingEditScroll.current = false
  recipeDraftGeneration.current += 1
  setRecipeFormGeneration(value => value + 1)
  setEditingRecipeId(null)
  setRecipeName("")
  setIngredientRows([emptyIngredientRow()])
  setInstructions("")
  setSelectedCategories([])
  setDietTags([])
  setImageUrl("")
  setImageFile(null)
  setRecipeUrl("")
  setCategory("Dinner")
}
function beginRecipeEdit(recipe) {
  if (recipeSaveOperation.current || recipe.user_id !== plannerOwner?.userId || !ownsAccount(plannerOwner)) return
  resetRecipeDraft()
  setRecipeName(recipe.name)
  const rows = getIngredientRows(recipe)
  setIngredientRows(rows.length ? rows.map(row => ({ ...row })) : [emptyIngredientRow()])
  setSelectedCategories([...(recipe.categories || [])])
  setImageUrl(recipe.image_url || "")
  setInstructions(recipe.instructions || "")
  setDietTags([...(recipe.diet_tags || [])])
  setEditingRecipeId(recipe.id)
  pendingEditScroll.current = true
}
function cancelRecipeEdit() {
  if (recipeSaveOperation.current) return
  resetRecipeDraft()
}
async function uploadRecipeImage(file, owner) {
  if (!ownsAccount(owner) || !file) return ""
  const fileName = `${owner.userId}/${Date.now()}-${file.name}`
  const { error } = await supabase.storage.from("recipe-images").upload(fileName, file)
  if (!ownsAccount(owner)) return ""
  if (error) throw new Error(`Image upload failed. Your recipe was not saved. ${error.message}`)
  const { data } = supabase.storage.from("recipe-images").getPublicUrl(fileName)
  return data.publicUrl
}
async function importRecipeFromUrl() {
  const owner = plannerOwner
  if (!owner?.userId || !ownsAccount(owner) || recipeSaveOperation.current) return
  if (!recipeUrl.trim()) {
    alert("Paste a recipe URL first.")
    return
  }
  const generation = ++recipeDraftGeneration.current
  try {
    const { data, error } = await supabase.functions.invoke("import-recipe", {
      body: { url: recipeUrl }
    })
    if (!ownsAccount(owner) || recipeDraftGeneration.current !== generation) return
    if (error || !data || typeof data !== "object") throw new Error("Could not import that recipe.")
    const importedRows = rowsFromIngredientStrings(data.ingredients)
    // Only a successful import replaces the draft; imports always create new recipes.
    resetRecipeDraft()
    setRecipeName(data.name || "")
    setIngredientRows(importedRows.length ? importedRows : [emptyIngredientRow()])
    setInstructions(Array.isArray(data.instructions) ? data.instructions.join("\n\n") : "")
    setImageUrl(data.image || "")
  } catch (error) {
    if (!ownsAccount(owner) || recipeDraftGeneration.current !== generation) return
    console.error(error)
    alert("Could not import that recipe.")
  }
}
async function addRecipe() {
  const owner = plannerOwner
  if (!owner?.userId || !ownsAccount(owner) || recipeSaveOperation.current) return
  if (editingRecipeId && !recipes.some(recipe => recipe.id === editingRecipeId && recipe.user_id === owner.userId)) {
    alert("You can only edit your own recipes.")
    return
  }
  const { rows, error: ingredientError } = validateIngredientRows(ingredientRows)
  if (!recipeName.trim() || ingredientError) {
    alert(ingredientError || "Please enter a recipe name.")
    return
  }
  const operation = {}
  recipeSaveOperation.current = operation
  setRecipeSaving(true)
  recipeDraftGeneration.current += 1 // Any pending import belongs to the pre-save draft.
  try {
    let uploadedImageUrl = imageUrl
    if (imageFile) uploadedImageUrl = await uploadRecipeImage(imageFile, owner)
    if (!ownsAccount(owner)) return
    const payload = {
      name: recipeName,
      ingredients: rows.map(formatIngredient).join(", "),
      structured_ingredients: rows,
      instructions,
      categories: selectedCategories,
      image_url: uploadedImageUrl,
      diet_tags: dietTags,
    }
    const { data, error } = editingRecipeId
      ? await supabase.from('recipes').update(payload).eq('id', editingRecipeId).eq('user_id', owner.userId).select("*")
      : await supabase.from('recipes').insert([{ ...payload, user_id: owner.userId }]).select("*")
    if (!ownsAccount(owner)) return
    if (error) throw error
    if (!data?.length) throw new Error("Your recipe was not saved. It may no longer be available to edit.")
    await getRecipes(owner)
    if (!ownsAccount(owner)) return
    resetRecipeDraft()
    window.location.reload()
  } catch (error) {
    if (!ownsAccount(owner)) return
    console.error(error)
    alert(error.message || "Could not save that recipe. Your draft has been preserved.")
  } finally {
    if (recipeSaveOperation.current === operation) {
      recipeSaveOperation.current = null
      setRecipeSaving(false)
    }
  }
}
async function deleteRecipe(id) {
  const owner = plannerOwner
  if (!owner?.userId || !ownsAccount(owner) || recipeSaveOperation.current) return
  const recipe = recipes.find(item => item.id === id && item.user_id === owner.userId)
  if (!recipe) return
  if (!window.confirm(`Delete "${recipe.name}"? This cannot be undone.`)) return
  const generation = recipeDraftGeneration.current
  try {
    const { data, error } = await supabase.from('recipes').delete().eq('id', id).eq('user_id', owner.userId).select("id")
    if (!ownsAccount(owner)) return
    if (error) throw error
    if (!data?.some(item => item.id === id)) throw new Error("Recipe was not deleted. It may no longer be available to delete.")
    setRecipes(current => current.filter(item => item.id !== id))
    if (editingRecipeId === id && recipeDraftGeneration.current === generation) resetRecipeDraft()
  } catch (error) {
    if (!ownsAccount(owner)) return
    console.error(error)
    alert(error.message || "Could not delete that recipe.")
  }
}
function toggleDayLock(day) {
  if (lockedDays.includes(day)) {
    setLockedDays(lockedDays.filter((lockedDay) => lockedDay !== day))
  } else {
    setLockedDays([...lockedDays, day])
  }
}
  function generateWeeklyMeals() {
    const randomMeals = []
    const usedRecipeIds = new Set(
      weeklyMeals
        .filter((item) => lockedDays.includes(item.day) && item.meal)
        .map((item) => item.meal.id)
    )
    if (recipes.length === 0) return
    const preferredDietTags = onboardingAnswers.dietPreferences || []
    const requiredAllergyTags = getRequiredAllergyTags(onboardingAnswers.allergies)

    const meals = daysOfWeek.map((day) => {

  const existingMeal = weeklyMeals.find(
    (meal) => meal.day === day
  )

  if (lockedDays.includes(day) && existingMeal) {
  return existingMeal
}

  const availableRecipes = recipes.filter(
  (recipe) => !usedRecipeIds.has(recipe.id)
)
const allergySafeRecipes = availableRecipes.filter((recipe) =>
  requiredAllergyTags.every((tag) =>
    (recipe.diet_tags || []).includes(tag)
  )
)

const matchingRecipes = allergySafeRecipes.filter((recipe) =>
  preferredDietTags.every((tag) =>
    (recipe.diet_tags || []).includes(tag)
  )
)


const recipePool = matchingRecipes
if (recipePool.length === 0) return { day, meal: null }

const randomIndex = Math.floor(
  Math.random() * recipePool.length
)

const selectedRecipe = recipePool[randomIndex]

usedRecipeIds.add(selectedRecipe.id)

return {
  day,
  meal: selectedRecipe
}
})

    setWeeklyMeals(meals)
    createShoppingList(meals)
  }
function handleTouchStart(e, day) {
  setSwipingDay(day)
  setTouchEndX(null)
  setTouchStartX(e.targetTouches[0].clientX)
}
function handleTouchMove(e) {
  const currentX = e.targetTouches[0].clientX
  setTouchEndX(currentX)

  if (touchStartX !== null) {
    setSwipeOffsetX(currentX - touchStartX)
  }
}
function handleTouchEnd(e, day) {
  if (touchStartX === null) return

  const endX = e.changedTouches[0].clientX
  const distance = touchStartX - endX

  if (distance > 100) {
    regenerateMeal(day)
  }

  setSwipeOffsetX(0)
  setSwipingDay(null)
}
 function regenerateMeal(dayToChange) {
  console.log("dayToChange:", dayToChange)
 console.log("lockedDays:", lockedDays) 
  if (recipes.length === 0) return
  

  if (lockedDays.includes(dayToChange)) {
    return
  }
  const currentMeal = weeklyMeals.find(
  (item) => item.day === dayToChange
)?.meal
const usedRecipeIds = new Set(
  weeklyMeals
    .filter((item) => item.day !== dayToChange)
    .map((item) => item.meal?.id)
    .filter(Boolean)
)
const options = recipes
  .filter(
  (recipe) =>
    recipe.id !== currentMeal?.id &&
    !usedRecipeIds.has(recipe.id)
)
  .sort(() => Math.random() - 0.5)
  .slice(0, 3)

//setSwapOptions({
//  day: dayToChange,
//  recipes: options
// })

// return

  const updatedMeals = weeklyMeals.map((item) => {
  if (item.day === dayToChange) {
    const availableRecipes = recipes.filter(
      (recipe) =>
        recipe.id !== currentMeal?.id &&
        !usedRecipeIds.has(recipe.id)
    )

    if (availableRecipes.length === 0) return item
const preferredDietTags = onboardingAnswers.dietPreferences || []

const requiredAllergyTags = getRequiredAllergyTags(onboardingAnswers.allergies)

const allergySafeRecipes = availableRecipes.filter((recipe) =>
  requiredAllergyTags.every((tag) =>
    (recipe.diet_tags || []).includes(tag)
  )
)

const matchingRecipes = allergySafeRecipes.filter((recipe) =>
  preferredDietTags.every((tag) =>
    (recipe.diet_tags || []).includes(tag)
  )
)

const recipePool = matchingRecipes
if (recipePool.length === 0) return item

    const randomIndex = Math.floor(
      Math.random() * recipePool.length
    )

    return {
      day: item.day,
      meal: recipePool[randomIndex]
    }
  }

  return item
})

  setWeeklyMeals(updatedMeals)
  createShoppingList(updatedMeals)
}
function meetsPlanningPreferences(recipe) {
  const tags = recipe.diet_tags || []
  return getRequiredAllergyTags(onboardingAnswers.allergies).every(tag => tags.includes(tag)) &&
    (onboardingAnswers.dietPreferences || []).every(tag => tags.includes(tag))
}
function cookTonight(recipe) {
  if (!recipe) return

  const today = new Date().toLocaleDateString("en-US", {
    weekday: "long"
  })

  const todayExists = weeklyMeals.some((item) => item.day === today)

  if (!todayExists) {
    alert("Generate your weekly plan first.")
    return
  }

  if (lockedDays.includes(today)) {
    alert("Tonight's meal is locked. Unlock it before changing it.")
    return
  }
  // Recheck the current library and preferences instead of trusting a displayed snapshot.
  const currentRecipe = recipes.find(item => item.id === recipe.id)
  if (!currentRecipe || !meetsPlanningPreferences(currentRecipe)) {
    alert("This recipe no longer matches your meal preferences or restrictions.")
    return
  }
  if (weeklyMeals.some(item => item.day !== today && item.meal?.id === currentRecipe.id)) {
    alert("This recipe is already planned for another day.")
    return
  }
  if (weeklyMeals.some(item => item.day === today && item.meal?.id === currentRecipe.id)) {
    alert("This recipe is already planned for tonight.")
    return
  }

  const updatedMeals = weeklyMeals.map((item) =>
    item.day === today
      ? {
          ...item,
          meal: currentRecipe
        }
      : item
  )

  setWeeklyMeals(updatedMeals)
  createShoppingList(updatedMeals)
}
function createShoppingList(meals) {
  setShoppingList((previous) => rebuildShoppingList(previous, weeklyMeals, meals, pantryItems))
}
const today = new Date().toLocaleDateString("en-US", { weekday: "long" })
const plannedOnOtherDays = new Set(weeklyMeals.filter(item => item.day !== today).map(item => item.meal?.id))
const pantryMatches = recipes
  .filter(recipe => meetsPlanningPreferences(recipe) && !plannedOnOtherDays.has(recipe.id))
  .map(recipe => getPantryRecipeMatch(recipe, pantryItems))
  .filter(recipe => recipe.totalCount > 0 && recipe.matchedCount > 0)
  .sort((a, b) => b.matchPercentage - a.matchPercentage)
  const pantryViewMatches = recipes
    .map(recipe => getPantryRecipeMatch(recipe, pantryItems))
    .filter(recipe => recipe.totalCount > 0 && recipe.matchedCount / recipe.totalCount >= 0.5)
    .sort((a, b) => b.matchedCount - a.matchedCount)
  const addMissingToShoppingList = (missingIngredients) => {
  setShoppingList((currentList) => {
    const updatedList = { ...currentList }

    if (!updatedList.Other) {
      updatedList.Other = []
    }

    missingIngredients.forEach((ingredient) => {
      if (!updatedList.Other.some((item) => asShoppingItem(item).label === ingredient)) {
        updatedList.Other = [...updatedList.Other, { ...asShoppingItem(ingredient), extra: true }]
      }
    })

    return updatedList
  })
}
  if (!authReady || (session && (plannerOwner?.userId !== userId)) || (session && (preferenceLoad?.userId !== userId || preferenceLoad.status === "loading"))) {
    return <div className="app" role="status">Loading Dinnerlyst…</div>
  }
  if (authLoadError) {
    return <div className="app" role="alert">
      <p>Could not load your sign-in session. Please try again.</p>
      <button className="primary-button" onClick={() => window.location.reload()}>Retry</button>
    </div>
  }
  if (session && preferenceLoad?.status === "error") {
    return <div className="app" role="alert">
      <p>Could not load your preferences. Please try again.</p>
      <button className="primary-button" onClick={() => {
        setPreferenceLoad(null)
        setPreferenceRetry((current) => current + 1)
      }}>Retry</button>
    </div>
  }
  if (!session) {
    return (
      <div className="app">
        <header className="hero">
          <h1>Dinnerlyst</h1>
          <p>Log in or create an account to save your recipes.</p>
        </header>
       
        

        <section className="card auth-card">
          <h2>Account</h2>

          <div className="form">
            <input
              type="email"
              placeholder="Email"
              value={authEmail}
              onChange={(e) => setAuthEmail(e.target.value)}
            />

            <input
              type="password"
              placeholder="Password"
              value={authPassword}
              onChange={(e) => setAuthPassword(e.target.value)}
            />

            <button className="primary-button" onClick={login}>
              Log In
            </button>

            <button className="secondary-button" onClick={signUp}>
              Sign Up
            </button>
          </div>
        </section>
      </div>
    )
  }
  const savePreferences = async (owner = plannerOwner) => {
    if (!owner?.userId || !ownsAccount(owner)) return false
    const { error } = await supabase
      .from("user_preferences")
      .upsert({
        user_id: owner.userId,
        household_size: onboardingAnswers.householdSize,
        diet_preferences: onboardingAnswers.dietPreferences,
        allergies: onboardingAnswers.allergies,
        disliked_foods: onboardingAnswers.dislikedFoods,
        cooking_style: onboardingAnswers.cookingStyle
      }, { onConflict: "user_id" })

    if (!ownsAccount(owner)) return false
    if (error) {
      console.error("Error saving preferences:", error)
      return false
    }
    return true
  }

  const updatePreferences = async () => {
    const saved = await savePreferences()
    if (saved) console.log("Preferences updated!")
  }
 function renderRestrictionFields() {
    const values = getAllergyValues(onboardingAnswers.allergies)
    const unsupported = values.map((value, index) => ({ value, index }))
      .filter(({ value }) => !allergySafeTags.includes(value))
    return (
      <div className="onboarding-field">
        <h3>Food allergies &amp; restrictions</h3>
        <p>Select any that Dinnerlyst should avoid when planning your meals.</p>
        <div className="diet-options" role="group" aria-label="Food allergies & restrictions">
          {allergySafeTags.map(tag => (
            <button key={tag} type="button"
              className={values.includes(tag) ? "diet-option selected" : "diet-option"}
              aria-pressed={values.includes(tag)}
              onClick={() => setOnboardingAnswers(previous => {
                const saved = getAllergyValues(previous.allergies)
                return { ...previous, allergies: saved.includes(tag)
                  ? saved.filter(value => value !== tag) : [...saved, tag] }
              })}>
              {tag}
            </button>
          ))}
        </div>
        {unsupported.map(({ value, index }) => (
          <div key={index}>
            <p>Not currently supported: {value === "" ? "(empty saved value)" : String(value)}</p>
            <p>Dinnerlyst can't reliably filter this restriction yet.</p>
            <button type="button" aria-label={`Remove unsupported restriction: ${String(value)}`}
              onClick={() => setOnboardingAnswers(previous => ({
                ...previous,
                allergies: getAllergyValues(previous.allergies).filter((_, at) => at !== index)
              }))}>
              Remove
            </button>
          </div>
        ))}
      </div>
    )
  }
 if (onboardingStep === 1) {
  return (
    <div>
      <h1>Welcome to Dinnerlyst 🌿</h1>
      <p>Let's make meal planning fit your household.</p>

      <div className="onboarding-card">
        <h2>Who are we cooking for?</h2>
        <p>How many people are you feeding?</p>

        <div className="household-counter">
          <button
           onClick={() =>
  setOnboardingAnswers({
    ...onboardingAnswers,
    householdSize: Math.max(1, onboardingAnswers.householdSize - 1)
  })
}
          >
            −
          </button>

         <span>{onboardingAnswers.householdSize}</span>

          <button
           onClick={() =>
  setOnboardingAnswers({
    ...onboardingAnswers,
    householdSize: onboardingAnswers.householdSize + 1
  })
}
          >
            +
          </button>
               </div>

        <button
          className="onboarding-continue"
          onClick={() => setOnboardingStep(2)}
        >
          Continue →
        </button>
      </div>
    </div>
  )
}
if (onboardingStep === 2) {
  return (
    <div>
      <h1>Welcome to Dinnerlyst 🌿</h1>
      <p>Let's make meal planning fit your household.</p>

      <div className="onboarding-card">
        <h2>How does your household eat?</h2>
        <p>Choose any that fit. You can change these later.</p>
        <div className="diet-options">
  <button
    className={
      onboardingAnswers.dietPreferences.includes("High Protein")
        ? "diet-option selected"
        : "diet-option"
    }
    onClick={() => {
      const current = onboardingAnswers.dietPreferences

      setOnboardingAnswers({
        ...onboardingAnswers,
        dietPreferences: current.includes("High Protein")
          ? current.filter((item) => item !== "High Protein")
          : [...current, "High Protein"]
      })
    }}
  >
    High Protein
  </button>
  <button
  className={
    onboardingAnswers.dietPreferences.includes("Anti-Inflammatory")
      ? "diet-option selected"
      : "diet-option"
  }
  onClick={() => {
    const current = onboardingAnswers.dietPreferences

    setOnboardingAnswers({
      ...onboardingAnswers,
      dietPreferences: current.includes("Anti-Inflammatory")
        ? current.filter((item) => item !== "Anti-Inflammatory")
        : [...current, "Anti-Inflammatory"]
    })
  }}
>
  Anti-Inflammatory
</button>
<button
  className={
    onboardingAnswers.dietPreferences.includes("Vegetarian")
      ? "diet-option selected"
      : "diet-option"
  }
  onClick={() => {
    const current = onboardingAnswers.dietPreferences

    setOnboardingAnswers({
      ...onboardingAnswers,
      dietPreferences: current.includes("Vegetarian")
        ? current.filter((item) => item !== "Vegetarian")
        : [...current, "Vegetarian"]
    })
  }}
>
  Vegetarian
</button>
<button
  className={
    onboardingAnswers.dietPreferences.includes("Vegan")
      ? "diet-option selected"
      : "diet-option"
  }
  onClick={() => {
    const current = onboardingAnswers.dietPreferences

    setOnboardingAnswers({
      ...onboardingAnswers,
      dietPreferences: current.includes("Vegan")
        ? current.filter((item) => item !== "Vegan")
        : [...current, "Vegan"]
    })
  }}
>
  Vegan
</button>
<button
  className={
    onboardingAnswers.dietPreferences.includes("Gluten-Free")
      ? "diet-option selected"
      : "diet-option"
  }
  onClick={() => {
    const current = onboardingAnswers.dietPreferences

    setOnboardingAnswers({
      ...onboardingAnswers,
      dietPreferences: current.includes("Gluten-Free")
        ? current.filter((item) => item !== "Gluten-Free")
        : [...current, "Gluten-Free"]
    })
  }}
>
  Gluten-Free
</button>
<button
  className={
    onboardingAnswers.dietPreferences.length === 0
      ? "diet-option selected"
      : "diet-option"
  }
  onClick={() => {
    setOnboardingAnswers({
      ...onboardingAnswers,
      dietPreferences: []
    })
  }}
>
  No Preference
</button>
</div>
<button
  className="onboarding-continue"
  onClick={() => setOnboardingStep(3)}
>
  Continue →
</button>
      </div>
    </div>
  )
}
if (onboardingStep === 3) {
  return (
    <div>
      <h1>Welcome to Dinnerlyst 🌿</h1>
      <p>Let's make meal planning fit your household.</p>

      <div className="onboarding-card">
        <h2>Anything we should avoid?</h2>
        <p>
          Choose your food restrictions and save any food dislikes below.
        </p>
        {renderRestrictionFields()}
<div className="onboarding-field">
  <label>Foods we don't like</label>
  <p>Saved for your reference. Dinnerlyst does not currently use these foods to filter meal suggestions.</p>
  <input
    type="text"
    placeholder="e.g. mushrooms, olives, seafood"
    value={onboardingAnswers.dislikedFoods}
    onChange={(e) =>
      setOnboardingAnswers({
        ...onboardingAnswers,
        dislikedFoods: e.target.value
      })
    }
  />
</div>
<button
  className="onboarding-continue"
  onClick={() => setOnboardingStep(4)}
>
  Continue →
</button>
      </div>
    </div>
  )
}
if (onboardingStep === 4) {
  return (
    <div>
      <h1>Welcome to Dinnerlyst 🌿</h1>
      <p>Let's make meal planning fit your household.</p>

      <div className="onboarding-card">
        <h2>What kind of cook are you?</h2>
        <p>We'll use this to choose recipes that fit your style.</p>
        <div className="diet-options">
  <button
    className={
      onboardingAnswers.cookingStyle === "Quick & Easy"
        ? "diet-option selected"
        : "diet-option"
    }
    onClick={() =>
      setOnboardingAnswers({
        ...onboardingAnswers,
        cookingStyle: "Quick & Easy"
      })
    }
  >
    ⚡ Quick & Easy
  </button>
</div>
<button
  className={
    onboardingAnswers.cookingStyle === "Balanced"
      ? "diet-option selected"
      : "diet-option"
  }
  onClick={() =>
    setOnboardingAnswers({
      ...onboardingAnswers,
      cookingStyle: "Balanced"
    })
  }
>
  🍳 Balanced
</button>
<button
  className={
    onboardingAnswers.cookingStyle === "I Like to Cook"
      ? "diet-option selected"
      : "diet-option"
  }
  onClick={() =>
    setOnboardingAnswers({
      ...onboardingAnswers,
      cookingStyle: "I Like to Cook"
    })
  }
>
  👩‍🍳 I Like to Cook
</button>
      </div>
      <button
  className="onboarding-continue"
  onClick={() => setOnboardingStep(5)}
>
  Continue →
</button>
    </div>
  )
}
if (onboardingStep === 5) {
  return (
    <div>
      <h1>You're all set! 🌿</h1>
      <p>Dinnerlyst is ready to make meal planning a whole lot easier.</p>

      <div className="onboarding-card">
        <h2>Let's plan some dinners.</h2>
        <p>
          We'll use your preferences to help personalize your meal planning.
        </p>
        <button
  className="onboarding-continue"
 onClick={async () => {
const owner = plannerOwner
const saved = await savePreferences(owner)

if (!saved || !ownsAccount(owner)) return

    setOnboardingStep(0)
  }}
>
  Start Planning →
</button>
      </div>
    </div>
  )
}
  return (
    <div className="app">
      <header className="hero app-header">
        <div className="app-brand">
          <h1>Dinnerlyst</h1>
          <p>Weekly meal planning made simple.</p>
        </div>

        <div className="hero-stats">
          <p>{recipes.length} Recipes Saved </p>
          <p>Plan your week in seconds</p>
        </div>

        <div className="header-controls">
          <button className="small-button" aria-current={activeTab === "preferences" ? "page" : undefined} onClick={() => setActiveTab("preferences")}>
            ⚙️ Settings / Preferences
          </button>
          <button className="logout-button" onClick={logout}>
            Log Out
          </button>
        </div>
      <nav className="tab-nav" aria-label="Main navigation">
        <button aria-current={activeTab === "planner" ? "page" : undefined} onClick={() => setActiveTab("planner")}>
          🍽 Plan
        </button>
        <button aria-current={activeTab === "recipes" ? "page" : undefined} onClick={() => setActiveTab("recipes")}>
          📖 Recipes
        </button>
        <button aria-current={activeTab === "shopping" ? "page" : undefined} onClick={() => setActiveTab("shopping")}>
          🛒 Shop
        </button>
        <button aria-current={activeTab === "pantry" ? "page" : undefined} onClick={() => setActiveTab("pantry")}>
          🥫 Pantry
        </button>
      </nav>
      </header>


      <section ref={recipeBuilderRef} className="card recipe-builder-section" hidden={activeTab !== "recipes"}>
        <h2>Add a Recipe</h2>

  <fieldset className="form recipe-form-modern" disabled={recipeSaving} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>

  <div className="recipe-import-modern">
    <div>
      <h3>Import from a recipe link</h3>
      <p>Paste a URL and Dinnerlyst will pull in the recipe details.</p>
    </div>

    <div className="recipe-import-row">
      <input
        type="url"
        placeholder="Paste recipe URL"
        value={recipeUrl}
        onChange={(e) => setRecipeUrl(e.target.value)}
      />

      <button
        type="button"
        className="secondary-button"
        onClick={importRecipeFromUrl}
      >
        Import Recipe
      </button>
    </div>
  </div>

  <div className="recipe-form-row">
    <div className="recipe-field">
      <label>Recipe name</label>
      <input
        type="text"
        placeholder="Recipe name"
        value={recipeName}
        onChange={(e) => setRecipeName(e.target.value)}
      />
    </div>

    <div className="recipe-field">
      <label>Recipe photo</label>
      <input
        type="file"
        key={`${userId}:${accountGeneration}:${recipeFormGeneration}`}
        accept="image/*"
        onChange={(e) => setImageFile(e.target.files[0])}
      />
    </div>
  </div>

  <div className="category-section">
    <label className="field-label">Categories</label>

    <div className="category-chips">
      {[
        "Chicken",
        "Beef",
        "Pork",
        "Seafood",
        "Pasta",
        "Crockpot",
        "Breakfast",
        "Vegetarian",
        "Soup",
        "Dessert",
      ].map((cat) => (
        <label
          key={cat}
          className={
            selectedCategories.includes(cat)
              ? "category-chip selected"
              : "category-chip"
          }
        >
          <input
            type="checkbox"
            checked={selectedCategories.includes(cat)}
            onChange={(e) => {
              if (e.target.checked) {
                setSelectedCategories([...selectedCategories, cat])
              } else {
                setSelectedCategories(
                  selectedCategories.filter((item) => item !== cat)
                )
              }
            }}
          />

          {cat}
        </label>
      ))}
    </div>
  </div>
   

         <div className="recipe-details-fields">
  <div className="recipe-field ingredient-builder">
    <label>Ingredients</label>
    {ingredientRows.map((row, index) => (
      <div className="ingredient-row" key={index}>
        {["amount", "unit", "ingredient"].map((field) => (
          <label key={field}>
            {field === "ingredient" ? "Ingredient" : field === "amount" ? "Amount" : "Unit"}
            <input
              type="text"
              value={row[field]}
              placeholder={field === "amount" ? "e.g. 1/2" : field === "unit" ? "e.g. cup" : "Ingredient name"}
              onChange={(e) => setIngredientRows((current) => current.map((item, rowIndex) =>
                rowIndex === index ? { ...item, [field]: e.target.value } : item
              ))}
            />
          </label>
        ))}
        <button
          type="button"
          className="small-button"
          aria-label={`Remove ingredient ${index + 1}`}
          onClick={() => setIngredientRows((current) => {
            const remaining = current.filter((_, rowIndex) => rowIndex !== index)
            return remaining.length ? remaining : [emptyIngredientRow()]
          })}
        >Remove</button>
      </div>
    ))}
    <button type="button" className="small-button" onClick={() => setIngredientRows((current) => [...current, emptyIngredientRow()])}>
      + Add Ingredient
    </button>
  </div>

  <div className="recipe-field">
    <label>Instructions</label>
    <textarea
      placeholder="Recipe instructions"
      value={instructions}
      onChange={(e) => setInstructions(e.target.value)}
      rows="6"
    />
  </div>
  <div className="recipe-field recipe-dietary-tags">
  <label>Dietary tags</label>
  <button
  type="button"
  className={dietTags.includes("High Protein") ? "diet-option selected" : "diet-option"}
  onClick={() =>
    setDietTags(
      dietTags.includes("High Protein")
        ? dietTags.filter((tag) => tag !== "High Protein")
        : [...dietTags, "High Protein"]
    )
  }
>
  💪 High Protein
</button>
<button
  type="button"
  className={dietTags.includes("Anti-Inflammatory") ? "diet-option selected" : "diet-option"}
  onClick={() =>
    setDietTags(
      dietTags.includes("Anti-Inflammatory")
        ? dietTags.filter((tag) => tag !== "Anti-Inflammatory")
        : [...dietTags, "Anti-Inflammatory"]
    )
  }
>
  🌿 Anti-Inflammatory
</button>
<button
  type="button"
  className={dietTags.includes("Vegetarian") ? "diet-option selected" : "diet-option"}
  onClick={() =>
    setDietTags(
      dietTags.includes("Vegetarian")
        ? dietTags.filter((tag) => tag !== "Vegetarian")
        : [...dietTags, "Vegetarian"]
    )
  }
>
  🥕 Vegetarian
</button>
<button
  type="button"
  className={dietTags.includes("Vegan") ? "diet-option selected" : "diet-option"}
  onClick={() =>
    setDietTags(
      dietTags.includes("Vegan")
        ? dietTags.filter((tag) => tag !== "Vegan")
        : [...dietTags, "Vegan"]
    )
  }
>
  🌱 Vegan
</button>
<button
  type="button"
  className={dietTags.includes("Gluten-Free") ? "diet-option selected" : "diet-option"}
  onClick={() =>
    setDietTags(
      dietTags.includes("Gluten-Free")
        ? dietTags.filter((tag) => tag !== "Gluten-Free")
        : [...dietTags, "Gluten-Free"]
    )
  }
>
  🌾 Gluten-Free
</button>

<button
  type="button"
  className={dietTags.includes("Dairy-Free") ? "diet-option selected" : "diet-option"}
  onClick={() =>
    setDietTags(
      dietTags.includes("Dairy-Free")
        ? dietTags.filter((tag) => tag !== "Dairy-Free")
        : [...dietTags, "Dairy-Free"]
    )
  }
>
  🥛 Dairy-Free
</button>

<button
  type="button"
  className={dietTags.includes("Low Carb") ? "diet-option selected" : "diet-option"}
  onClick={() =>
    setDietTags(
      dietTags.includes("Low Carb")
        ? dietTags.filter((tag) => tag !== "Low Carb")
        : [...dietTags, "Low Carb"]
    )
  }
>
  🥩 Low Carb
</button>

<button
  type="button"
  className={dietTags.includes("Keto") ? "diet-option selected" : "diet-option"}
  onClick={() =>
    setDietTags(
      dietTags.includes("Keto")
        ? dietTags.filter((tag) => tag !== "Keto")
        : [...dietTags, "Keto"]
    )
  }
>
  🥑 Keto
</button>

<button
  type="button"
  className={dietTags.includes("Mediterranean") ? "diet-option selected" : "diet-option"}
  onClick={() =>
    setDietTags(
      dietTags.includes("Mediterranean")
        ? dietTags.filter((tag) => tag !== "Mediterranean")
        : [...dietTags, "Mediterranean"]
    )
  }
>
  🫒 Mediterranean
</button>
<button
  type="button"
  className={dietTags.includes("Peanut-Free") ? "diet-option selected" : "diet-option"}
  onClick={() =>
    setDietTags(
      dietTags.includes("Peanut-Free")
        ? dietTags.filter((tag) => tag !== "Peanut-Free")
        : [...dietTags, "Peanut-Free"]
    )
  }
>
  🥜 Peanut-Free
</button>

<button
  type="button"
  className={dietTags.includes("Tree Nut-Free") ? "diet-option selected" : "diet-option"}
  onClick={() =>
    setDietTags(
      dietTags.includes("Tree Nut-Free")
        ? dietTags.filter((tag) => tag !== "Tree Nut-Free")
        : [...dietTags, "Tree Nut-Free"]
    )
  }
>
  🌰 Tree Nut-Free
</button>

<button
  type="button"
  className={dietTags.includes("Shellfish-Free") ? "diet-option selected" : "diet-option"}
  onClick={() =>
    setDietTags(
      dietTags.includes("Shellfish-Free")
        ? dietTags.filter((tag) => tag !== "Shellfish-Free")
        : [...dietTags, "Shellfish-Free"]
    )
  }
>
  🦐 Shellfish-Free
</button>

<button
  type="button"
  className={dietTags.includes("Egg-Free") ? "diet-option selected" : "diet-option"}
  onClick={() =>
    setDietTags(
      dietTags.includes("Egg-Free")
        ? dietTags.filter((tag) => tag !== "Egg-Free")
        : [...dietTags, "Egg-Free"]
    )
  }
>
  🥚 Egg-Free
</button>

<button
  type="button"
  className={dietTags.includes("Soy-Free") ? "diet-option selected" : "diet-option"}
  onClick={() =>
    setDietTags(
      dietTags.includes("Soy-Free")
        ? dietTags.filter((tag) => tag !== "Soy-Free")
        : [...dietTags, "Soy-Free"]
    )
  }
>
  🌱 Soy-Free
</button>
</div>
</div>

<button
  className="primary-button recipe-save-button"
  onClick={addRecipe}
>
  {recipeSaving ? "Saving…" : editingRecipeId ? "Save Changes" : "Add Recipe"}
</button>
{editingRecipeId && (
  <button type="button" className="small-button" onClick={cancelRecipeEdit}>Cancel Edit</button>
)}
{recipeSaving && <p role="status">Saving your recipe…</p>}
        </fieldset>
      </section>

      {activeTab === "planner" && (
      <section className="action-section">
        <button className="generate-button" onClick={generateWeeklyMeals}>
          🍽️ Generate Weekly Meals + Shopping List
        </button>
      </section>
      )}

     <main className="grid recipes-grid">
      {activeTab === "recipes" && (
        <section className="card">
          <h2>📖 Your Recipes ({recipes.length})</h2>
          <input
  type="text"
  placeholder="Search recipes..."
  value={searchTerm}
  onChange={(e) => setSearchTerm(e.target.value)}
/>
<select
  value={selectedCategory}
  onChange={(e) => setSelectedCategory(e.target.value)}
>
<option value="All">All Categories</option>
<option value="Chicken">Chicken</option>
<option value="Beef">Beef</option>
<option value="Pork">Pork</option>
<option value="Seafood">Seafood</option>
<option value="Pasta">Pasta</option>
<option value="Crockpot">Crockpot</option>
<option value="Breakfast">Breakfast</option>
<option value="Vegetarian">Vegetarian</option>
<option value="Soup">Soup</option>
<option value="Dessert">Dessert</option>
</select>
          {recipes.length === 0 && <p className="empty">No recipes yet.</p>}
           
         {recipes
  .filter((recipe) =>
    recipe.name.toLowerCase().includes(searchTerm.toLowerCase())
  )
  .filter((recipe) =>
    selectedCategory === "All" ||
    (recipe.categories || []).includes(selectedCategory)
  )
  .length === 0 ? (
    <p className="empty">
      No recipes found. Try another search or category.
    </p>
  ) : (
    <div className="recipe-gallery">
  {recipes
      .filter((recipe) =>
        recipe.name.toLowerCase().includes(searchTerm.toLowerCase())
      )
      .filter((recipe) =>
        selectedCategory === "All" ||
        (recipe.categories || []).includes(selectedCategory)
      )
      .map((recipe) => (
        <div className="recipe-card" key={recipe.id}>
         {recipe.image_url ? (
  <img
    src={recipe.image_url}
    alt={recipe.name}
    className="recipe-image"
  />
) : (
  <div className="recipe-image-placeholder">
    <span>🍽️</span>
  </div>
)}
          <div>
            <strong>{recipe.name}</strong>
            <div>
  {(recipe.categories || []).map((cat) => (
    <span className="category-pill" key={cat}>
      {cat}
    </span>
  ))}
</div>
            <ul className="recipe-ingredients">
  {(expandedRecipeId === recipe.id
    ? recipe.ingredients
    : recipe.ingredients.slice(0, 3)
  ).map((ingredient, index) => (
    <li key={index}>{ingredient}</li>
  ))}
</ul>

{expandedRecipeId !== recipe.id && recipe.ingredients.length > 3 && (
  <p className="more-ingredients">
    + {recipe.ingredients.length - 3} more ingredients
  </p>
)}
{expandedRecipeId === recipe.id && (
  <div className="recipe-details">
    <div className="recipe-details-header">
      <h3>Instructions</h3>
    </div>

   <div className="recipe-instructions">
  {recipe.instructions
    ? recipe.instructions
        .split(/\n\s*\n/)
        .filter((step) => step.trim())
        .map((step, index) => (
          <div className="instruction-step" key={index}>
            <span className="step-number">{index + 1}</span>
            <p>{step.trim()}</p>
          </div>
        ))
    : "No instructions saved."}
</div>
  </div>
)}
          </div>

          <div className="recipe-actions">
            {recipe.user_id === userId && (
              <button className="small-button" disabled={recipeSaving} onClick={() => beginRecipeEdit(recipe)}>
                ✏️ Edit
              </button>
            )}
            <button
  className="small-button"
  type="button"
  onClick={() =>
    setExpandedRecipeId(
      expandedRecipeId === recipe.id ? null : recipe.id
    )
  }
>
  {expandedRecipeId === recipe.id ? "Hide Recipe" : "View Recipe"}
</button>

            {recipe.user_id === userId && (
              <button className="delete-button" disabled={recipeSaving} onClick={() => deleteRecipe(recipe.id)}>
                Delete
              </button>
            )}
          </div>
        </div>
      ))
        }
</div>
  )}
        </section>
        )}
        

        {activeTab === "planner" && (
<section className="card">
<div className="planner-welcome">
  <p className="planner-eyebrow">Good Evening 👋</p>
  <h2>What’s for dinner tonight?</h2>
  <p>Let Dinnerlyst help you make the easiest choice.</p>
</div>
<div className="best-match-card">
  <p className="best-match-label">⭐ Tonight's Best Match</p>

  <h3>
  {pantryMatches[0]?.name || "No suitable recommendation right now"}
</h3>

  <div className="progress-bar">
    <div
  className="progress-fill"
  style={{
    width: `${pantryMatches[0] ? (pantryMatches[0].missingIngredients.length === 0 ? 100 : Math.min(pantryMatches[0].matchPercentage, 99)) : 0}%`
  }}
></div>
  </div>

  <p className="progress-text">
  {pantryMatches[0]
    ? pantryMatches[0].missingIngredients.length === 0
      ? "🎉 100% Ready — You can make this!"
      : `${Math.min(pantryMatches[0].matchPercentage, 99)}% Ready`
    : "No match yet"}
</p>

  {pantryMatches[0]?.missingIngredients?.length > 0 && (
  <p className="missing-title">Only missing:</p>
)}

  {pantryMatches[0]?.missingIngredients?.length > 0 ? (
  <div>
    {pantryMatches[0].missingIngredients.map((ingredient) => (
      <p key={ingredient}>• {ingredient}</p>
    ))}
  </div>
) : (
  pantryMatches[0] ? (
  <p>✅ You have everything you need!</p>
) : (
  <p>No recipe currently matches your preferences, restrictions, weekly plan, and pantry ingredients.</p>
)
)}
  {pantryMatches[0]?.missingIngredients?.length > 0 && (
  <button
    className="cook-button"
    onClick={() => {
      const match = pantryMatches[0]
      const alreadyPresent = match.missingIngredients.every(ingredient =>
        (shoppingList.Other || []).some(item => asShoppingItem(item).label === ingredient)
      )
      addMissingToShoppingList(match.missingIngredients)
      setBestMatchFeedback({
        recipeId: match.id,
        ingredients: JSON.stringify(match.missingIngredients),
        message: alreadyPresent ? "✓ Already on Shopping List" : "✓ Added to Shopping List"
      })
    }}
  >
    🛒 Add Missing to Shopping List
  </button>
)}

{pantryMatches[0]?.missingIngredients?.length > 0 &&
  bestMatchFeedback?.recipeId === pantryMatches[0].id &&
  bestMatchFeedback.ingredients === JSON.stringify(pantryMatches[0].missingIngredients) && (
    <p role="status">{bestMatchFeedback.message}</p>
)}

{pantryMatches[0]?.missingIngredients?.length === 0 && (
  <button
    className="cook-button"
    onClick={() => cookTonight(pantryMatches[0])}
  >
    Cook Tonight
  </button>
)}
</div>
  <div className="section-header">
  <h2>This Week</h2>
  <p>Your planned meals at a glance.</p>
</div>

          {weeklyMeals.length === 0 && <p className="empty">Generate meals to see your week.</p>}
          <div className="meal-grid">

          {weeklyMeals.map((item, index) => item.meal ? (
            <div
  className={`meal-card ${lockedDays.includes(item.day) ? "meal-card-locked" : ""}`}
  key={index}
  style={{
  transform:
    swipingDay === item.day
      ? `translateX(${Math.min(swipeOffsetX, 0)}px)`
      : "translateX(0px)",
      transition:
  swipingDay === item.day
    ? "none"
    : "transform 0.2s ease",
}}
  onTouchStart={(e) => handleTouchStart(e, item.day)}
  onTouchMove={handleTouchMove}
  onTouchEnd={(e) => handleTouchEnd(e, item.day)}
>
  <div className="meal-info">
    <span className="meal-day">{item.day}</span>
   {item.meal.image_url ? (
  <img
    src={item.meal.image_url}
    alt={item.meal.name}
    className="meal-image"
  />
) : (
  <div className="meal-image-placeholder">
    <span>🍽️</span>
  </div>
)}
   <button
  className="meal-title-button"
  type="button"
  onClick={() => setViewingRecipe(item.meal)}
>
  {item.meal.name}
</button>
{item.meal.diet_tags?.length > 0 && (
  <div className="meal-diet-tags">
    {item.meal.diet_tags.map((tag) => (
      <span key={tag} className="meal-diet-tag">
        {tag}
      </span>
    ))}
  </div>
)}
  </div>

  <div className="meal-actions">
    <button className="small-button" onClick={() => regenerateMeal(item.day)}>
      🔄 Regenerate
    </button>

    <button
      className="small-button"
      onClick={() => toggleDayLock(item.day)}
    >
      {lockedDays.includes(item.day) ? "Unlock" : "Lock"}
    </button>
  </div>
</div>
          ) : (
  <div className="meal-card" key={index}>
    <div className="meal-info">
      <span className="meal-day">{item.day}</span>
      <p>No matching meal found</p>
    </div>
  </div>
))}
          </div>
{swapOptions && (
  <div className="recipe-modal-overlay">
    <div className="recipe-modal">
      <button
        className="recipe-modal-close"
        type="button"
        onClick={() => setSwapOptions(null)}
      >
        ✕
      </button>

      <h2>Choose a new meal</h2>

     <div className="swap-options">
  {swapOptions.recipes.map((recipe) => (
    <button
      key={recipe.id}
      className="swap-option"
      type="button"
      onClick={() => {
        const updatedMeals = weeklyMeals.map((item) =>
          item.day === swapOptions.day
            ? { ...item, meal: recipe }
            : item
        )

        setWeeklyMeals(updatedMeals)
        createShoppingList(updatedMeals)
        setSwapOptions(null)
      }}
    >
      {recipe.image_url && (
        <img
          src={recipe.image_url}
          alt={recipe.name}
          className="swap-option-image"
        />
      )}

      <span>{recipe.name}</span>
    </button>
  ))}
</div>
    </div>
  </div>
)}
        </section>
        )}
        {activeTab === "planner" && (
  <section className="card shopping-progress-card">
    <h2>🛒 Shopping Progress</h2>

    <p>
      {checkedShoppingCount} of{" "}
      {currentShoppingItems.length} items checked
    </p>

    <div className="progress-track">
      <div
        className="progress-fill"
        style={{
          width: `${
            currentShoppingItems.length > 0
              ? (checkedShoppingCount /
                  currentShoppingItems.length) *
                100
              : 0
          }%`,
        }}
      />
    </div>

    <button
      className="small-button"
      onClick={() => setActiveTab("shopping")}
    >
      View Shopping List
    </button>
  </section>
)}
        
        {activeTab === "shopping" && (
        <section className="card">
          <h2>🛒Shopping List</h2>
          <p>Checked items: {checkedShoppingCount}</p>

          {currentShoppingItems.length === 0 && <p className="empty">Your grocery list will appear here.</p>}

          {Object.entries(shoppingList).map(([category, entries]) => {
  const items = entries.filter((item) => !asShoppingItem(item).pantryHidden)
  return (
  items.length > 0 && (
    <div key={category}>
      <h3>{category}</h3>

      {items.map((ingredient, index) => (
        <div className="shopping-item" key={index}>
         <>
  <input
  type="checkbox"
  checked={isShoppingItemChecked(ingredient, checkedShoppingItems)}
  onChange={async (e) => {
    const owner = plannerOwner
    if (!owner?.userId || !ownsAccount(owner)) return
    if (e.target.checked) {
      const { error } = await supabase
  .from("checked_shopping_items")
  .insert({
    user_id: owner.userId,
    item_name: asShoppingItem(ingredient).key,
  })

if (!ownsAccount(owner)) return
if (error) {
  console.error("Error saving checked item:", error)
  return
}
      setCheckedShoppingItems((current) => ownsAccount(owner) ? [...new Set([...current, asShoppingItem(ingredient).key])] : current)
    } else {
      const identities = shoppingCheckIdentities(ingredient)
      // Exact equality avoids PostgREST IN quoting of JSON-based canonical keys.
      for (const identity of identities) {
        if (!ownsAccount(owner)) return
        const { error } = await supabase
          .from("checked_shopping_items")
          .delete()
          .eq("user_id", owner.userId)
          .eq("item_name", identity)

        if (!ownsAccount(owner)) return
        if (error) {
          console.error("Error removing checked item:", error)
          return
        }
      }
      setCheckedShoppingItems((current) => ownsAccount(owner) ? current.filter((item) => !identities.includes(item)) : current)
    }
  }}
/>
  {asShoppingItem(ingredient).label}
</> 
        </div>
      ))}
    </div>
  )
)})}
        </section>
        )}
        {activeTab === "pantry" && (
  <section className="card pantry-view">
    <div className="pantry-intro">
      <h2>What do you already have?</h2>
      <p>Save ingredients you have on hand. Dinnerlyst won’t add them to your generated shopping list.</p>
    </div>
    <form className="pantry-add" onSubmit={async (e) => {
  const owner = plannerOwner
  if (!owner?.userId || !ownsAccount(owner)) return
  e.preventDefault()
  if (pantrySearch.trim()) {
    const newItem = pantrySearch.trim()

if (!pantryItems.includes(newItem) && session?.user?.id) {
  const { error } = await supabase
    .from("pantry_items")
    .insert({
      user_id: owner.userId,
      item_name: newItem
    })

  if (!ownsAccount(owner)) return
  if (!error) {
    setPantryItems([...pantryItems, newItem])
  } else {
    console.error("Error saving pantry item:", error)
  }
}

    setPantrySearch("")
  }
}}>
      <label htmlFor="pantry-ingredient">Add ingredient</label>
      <div className="pantry-add-row">
    <input
  type="text"
  placeholder="Search ingredients..."
  value={pantrySearch}
  onChange={(e) => setPantrySearch(e.target.value)}
  id="pantry-ingredient"
/>
        <button type="submit" className="pantry-add-button">Add</button>
      </div>
    </form>
    <div className="pantry-section">
      <h3>Your Pantry</h3>
      <div className="pantry-chip-group">
{pantryItems.length === 0 ? (
  <p className="pantry-empty">Your pantry is empty. Add an ingredient above or choose a pantry staple below.</p>
) : (
  pantryItems.map((item) => (
  <span key={item} className="pantry-chip">
    <span>{item}</span>
    <button
      type="button"
      className="pantry-remove"
      aria-label={`Remove ${item}`}
      onClick={async () =>
       {
  const owner = plannerOwner
  if (!owner?.userId || !ownsAccount(owner)) return
  const { error } = await supabase
    .from("pantry_items")
    .delete()
    .eq("user_id", owner.userId)
    .eq("item_name", item)

  if (!ownsAccount(owner)) return
  if (!error) {
    setPantryItems(
      pantryItems.filter((pantryItem) => pantryItem !== item)
    )
  } else {
    console.error("Error deleting pantry item:", error)
  }
}
      }
    >
      ✕
    </button>
  </span>
))
)}
      </div>
    </div>
    <div className="pantry-section">
      <h3>Pantry Staples</h3>
      <div className="pantry-chip-group">
{[
  "Chicken",
  "Rice",
  "Eggs",
  "Cheese",
  "Milk",
  "Butter",
  "Pasta",
  "Tortillas",
  "Onion",
  "Tomato",
].filter((item) =>
  item.toLowerCase().includes(pantrySearch.toLowerCase())
).map((item) => (
  <button
    key={item}
    type="button"
    className="pantry-staple"
    disabled={pantryItems.includes(item)}
    onClick={async () => {
     const owner = plannerOwner
     if (!owner?.userId || !ownsAccount(owner)) return
     if (!pantryItems.includes(item) && session?.user?.id) {
  const { error } = await supabase
    .from("pantry_items")
    .insert({
      user_id: owner.userId,
      item_name: item
    })

  if (!ownsAccount(owner)) return
  if (!error) {
    setPantryItems([...pantryItems, item])
  } else {
    console.error("Error saving pantry item:", error)
  }
}
      setPantrySearch("")
    }}
  >
    {item}{pantryItems.includes(item) && <span className="pantry-added">✓ Added</span>}
  </button>
))}
      </div>
    </div>
    <div className="pantry-section pantry-meals">
      <h3>Meals You're Close to Making</h3>
      {pantryViewMatches.length === 0 && (
        <p className="pantry-empty">Add more pantry ingredients and we'll show meals you're close to making.</p>
      )}
{pantryViewMatches
  .map((recipe) => (
    <div
  key={recipe.id}
  className="pantry-match-card"
  onClick={() => setViewingRecipe(recipe)}
>
      <strong>{recipe.name}</strong>
      <p>
  ✅ {recipe.matchedCount} of {recipe.totalCount} ingredients available
</p>

{recipe.missingIngredients.length > 0 && (
  <>
    <small><strong>Missing:</strong></small>

    <ul>
      {recipe.missingIngredients.map((ingredient) => (
        <li key={ingredient}>{ingredient}</li>
      ))}
    </ul>
  </>
)}
{recipe.missingIngredients.length > 0 && (
  <button
    className="cook-button"
    onClick={(event) => {
      event.stopPropagation()
      const alreadyPresent = recipe.missingIngredients.every(ingredient =>
        (shoppingList.Other || []).some(item => asShoppingItem(item).label === ingredient)
      )
      addMissingToShoppingList(recipe.missingIngredients)
      setPantryAddFeedback(previous => ({
        ...previous,
        [recipe.id]: {
          ingredients: JSON.stringify(recipe.missingIngredients),
          message: alreadyPresent ? "✓ Already on Shopping List" : "✓ Added to Shopping List"
        }
      }))
    }}
  >
    🛒 Add Missing to Shopping List
  </button>
)}
{recipe.missingIngredients.length > 0 &&
  pantryAddFeedback[recipe.id]?.ingredients === JSON.stringify(recipe.missingIngredients) && (
    <p role="status">{pantryAddFeedback[recipe.id].message}</p>
)}
    </div>
  ))}

    </div>
  </section>
)}
{activeTab === "preferences" && (
  <section className="card">
    <h2>⚙️ Preferences</h2>
 <div>
  <p>Household size</p>

  <div className="household-counter">
    <button
      onClick={() =>
        setOnboardingAnswers({
          ...onboardingAnswers,
          householdSize: Math.max(1, onboardingAnswers.householdSize - 1)
        })
      }
    >
      −
    </button>

    <span>{onboardingAnswers.householdSize}</span>

    <button
      onClick={() =>
        setOnboardingAnswers({
          ...onboardingAnswers,
          householdSize: onboardingAnswers.householdSize + 1
        })
      }
    >
      +
    </button>
  </div>
</div>
<div>
  <p>Diet preferences</p>
  <button
  className={
    onboardingAnswers.dietPreferences.includes("High Protein")
      ? "diet-option selected"
      : "diet-option"
  }
  onClick={() => {
  const current = onboardingAnswers.dietPreferences

  setOnboardingAnswers({
    ...onboardingAnswers,
    dietPreferences: current.includes("High Protein")
      ? current.filter((item) => item !== "High Protein")
      : [...current, "High Protein"]
  })
}}
>
  High Protein
</button>
<button
  className={
    onboardingAnswers.dietPreferences.includes("Anti-Inflammatory")
      ? "diet-option selected"
      : "diet-option"
  }
  onClick={() => {
  const current = onboardingAnswers.dietPreferences

  setOnboardingAnswers({
    ...onboardingAnswers,
    dietPreferences: current.includes("Anti-Inflammatory")
      ? current.filter((item) => item !== "Anti-Inflammatory")
      : [...current, "Anti-Inflammatory"]
  })
}}
>
  Anti-Inflammatory
</button>
<button
  className={
    onboardingAnswers.dietPreferences.includes("Vegetarian")
      ? "diet-option selected"
      : "diet-option"
  }
  onClick={() => {
  const current = onboardingAnswers.dietPreferences

  setOnboardingAnswers({
    ...onboardingAnswers,
    dietPreferences: current.includes("Vegetarian")
      ? current.filter((item) => item !== "Vegetarian")
      : [...current, "Vegetarian"]
  })
}}
>
  Vegetarian
</button>
<button
  className={
    onboardingAnswers.dietPreferences.includes("Vegan")
      ? "diet-option selected"
      : "diet-option"
  }
  onClick={() => {
  const current = onboardingAnswers.dietPreferences

  setOnboardingAnswers({
    ...onboardingAnswers,
    dietPreferences: current.includes("Vegan")
      ? current.filter((item) => item !== "Vegan")
      : [...current, "Vegan"]
  })
}}
>
  Vegan
</button>
<button
  className={
    onboardingAnswers.dietPreferences.includes("Gluten-Free")
      ? "diet-option selected"
      : "diet-option"
  }
  onClick={() => {
  const current = onboardingAnswers.dietPreferences

  setOnboardingAnswers({
    ...onboardingAnswers,
    dietPreferences: current.includes("Gluten-Free")
      ? current.filter((item) => item !== "Gluten-Free")
      : [...current, "Gluten-Free"]
  })
}}
>
  Gluten-Free
</button>
<button
  className={
    onboardingAnswers.dietPreferences.length === 0
      ? "diet-option selected"
      : "diet-option"
  }
  onClick={() => {
  setOnboardingAnswers({
    ...onboardingAnswers,
    dietPreferences: []
  })
}}
>
  No Preference
</button>
</div>
{renderRestrictionFields()}
<div className="onboarding-field">
  <label>Foods we don't like</label>
  <p>Saved for your reference. Dinnerlyst does not currently use these foods to filter meal suggestions.</p>
  <input
    type="text"
    placeholder="e.g. mushrooms, olives, seafood"
    value={onboardingAnswers.dislikedFoods}
    onChange={(e) => {
  setOnboardingAnswers({
    ...onboardingAnswers,
    dislikedFoods: e.target.value
  })
}}
  />
</div>
<div>
  <p>Cooking style</p>
  <button
  className={
    onboardingAnswers.cookingStyle === "Quick & Easy"
      ? "diet-option selected"
      : "diet-option"
  }
  onClick={() =>
  setOnboardingAnswers({
    ...onboardingAnswers,
    cookingStyle: "Quick & Easy"
  })
}
>
  ⚡ Quick & Easy
</button>
<button
  className={
    onboardingAnswers.cookingStyle === "Balanced"
      ? "diet-option selected"
      : "diet-option"
  }
  onClick={() =>
  setOnboardingAnswers({
    ...onboardingAnswers,
    cookingStyle: "Balanced"
  })
}
>
  ⚖️ Balanced
</button>
<button
  className={
    onboardingAnswers.cookingStyle === "I Like to Cook"
      ? "diet-option selected"
      : "diet-option"
  }
  onClick={() =>
  setOnboardingAnswers({
    ...onboardingAnswers,
    cookingStyle: "I Like to Cook"
  })
}
>
  👩‍🍳 I Like to Cook
</button>
</div>
<button
  className="onboarding-continue"
  onClick={updatePreferences}

>
  Save Preferences
</button>
  </section>
)}
      </main>
          {viewingRecipe && (
  <div className="recipe-modal-overlay">
    <div className="recipe-modal">
  <button
    className="recipe-modal-close"
    type="button"
    onClick={() => setViewingRecipe(null)}
  >
    ✕
  </button>

  {viewingRecipe.image_url && (
    <img
      src={viewingRecipe.image_url}
      alt={viewingRecipe.name}
      className="recipe-modal-image"
    />
  )}

  <h2>{viewingRecipe.name}</h2>

  <h3>Ingredients</h3>

  <ul className="recipe-ingredients">
    {viewingRecipe.ingredients.map((ingredient, index) => (
      <li key={index}>{ingredient}</li>
    ))}
  </ul>

  <h3>Instructions</h3>

  <div className="recipe-instructions">
    {viewingRecipe.instructions
      ? viewingRecipe.instructions
          .split(/\n\s*\n/)
          .filter((step) => step.trim())
          .map((step, index) => (
            <div className="instruction-step" key={index}>
              <span className="step-number">{index + 1}</span>
              <p>{step.trim()}</p>
            </div>
          ))
      : "No instructions saved."}
  </div>
</div>
  </div>
)}
    </div>
  )
}

export default App
