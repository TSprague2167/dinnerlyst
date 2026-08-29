import { useEffect, useState } from "react"
import { supabase } from './supabase'
import './App.css'


function App() {
  const [session, setSession] = useState(null)
  const [authEmail, setAuthEmail] = useState("")
  const [authPassword, setAuthPassword] = useState("")
  const [recipes, setRecipes] = useState([])
  const [recipeName, setRecipeName] = useState("")
  const [ingredients, setIngredients] = useState("")
  const [instructions, setInstructions] = useState("")
  const [viewingRecipe, setViewingRecipe] = useState(null)
  const [imageUrl, setImageUrl] = useState("")
  const [pantryItems, setPantryItems] = useState([])
  const [weeklyMeals, setWeeklyMeals] = useState(() => {
  const savedMeals = localStorage.getItem("weeklyMeals")
  return savedMeals ? JSON.parse(savedMeals) : []
})
  const [lockedDays, setLockedDays] = useState([])
  const [recipeUrl, setRecipeUrl] = useState("");
  const [searchTerm, setSearchTerm] = useState("")
  const [pantrySearch, setPantrySearch] = useState("")
  const [activeTab, setActiveTab] = useState("planner")
  const [category, setCategory] = useState("Dinner")
  const [shoppingList, setShoppingList] = useState(() => {
  const saved = localStorage.getItem("shoppingList")
  return saved ? JSON.parse(saved) : []
})
  const [checkedShoppingItems, setCheckedShoppingItems] = useState(() => {
  const saved = localStorage.getItem("checkedShoppingItems")
  return saved ? JSON.parse(saved) : []
})
useEffect(() => {
  localStorage.setItem(
    "checkedShoppingItems",
    JSON.stringify(checkedShoppingItems)
  )
}, [checkedShoppingItems])
useEffect(() => {
  localStorage.setItem(
    "shoppingList",
    JSON.stringify(shoppingList)
  )
}, [shoppingList])
  const [selectedCategory, setSelectedCategory] = useState("All")
  const [imageFile, setImageFile] = useState(null)
  const [selectedCategories, setSelectedCategories] = useState([])

  const daysOfWeek = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]
const [editingRecipeId, setEditingRecipeId] = useState(null)
  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session)
    })

    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session)
    })

    return () => {
      listener.subscription.unsubscribe()
    }
  }, [])

  useEffect(() => {
  localStorage.setItem(
    "weeklyMeals",
    JSON.stringify(weeklyMeals)
  )
}, [weeklyMeals])

  useEffect(() => {
    if (session) {
      getRecipes()
    }
  }, [session])

  async function signUp() {
    const { error } = await supabase.auth.signUp({
      email: authEmail,
      password: authPassword
    })

    if (error) {
      alert(error.message)
      console.log(error)
      return
    }

    alert("Check your email to confirm your account.")
  }

  async function login() {
    const { error } = await supabase.auth.signInWithPassword({
      email: authEmail,
      password: authPassword
    })

    if (error) {
      alert(error.message)
      return
    }

    setAuthEmail("")
    setAuthPassword("")
  }

  async function logout() {
    await supabase.auth.signOut()
    setRecipes([])
    setWeeklyMeals([])
    setShoppingList([])
  }

  async function getRecipes() {
    const { data, error } = await supabase.from('recipes').select('*')
.eq('user_id', session.user.id)
    if (error) {
      console.log(error)
      return
    }

    const savedRecipes = data.map((recipe) => ({
  id: recipe.id,
  name: recipe.name,
  categories: recipe.categories || [],
  image_url: recipe.image_url || "",
  instructions: recipe.instructions || "",
  ingredients: recipe.ingredients.split(",").map((item) => item.trim())
}))

    setRecipes(savedRecipes)
  }
async function uploadRecipeImage(file) {
  if (!file) return ""

  const fileName = `${Date.now()}-${file.name}`

  const { error } = await supabase.storage
    .from("recipe-images")
    .upload(fileName, file)

  if (error) {
    alert(error.message)
    console.log(error)
    return ""
  }

  const { data } = supabase.storage
    .from("recipe-images")
    .getPublicUrl(fileName)

  return data.publicUrl
}
async function importRecipeFromUrl() {
  if (!recipeUrl.trim()) {
    alert("Paste a recipe URL first.")
    return
  }

  const { data, error } = await supabase.functions.invoke("import-recipe", {
    body: { url: recipeUrl }
  })

  if (error) {
    console.error(error)
    alert("Could not import that recipe.")
    return
  }

  setRecipeName(data.name || "")
  setIngredients(
  Array.isArray(data.ingredients)
    ? data.ingredients
        .map((ingredient) =>
          ingredient
            .replace(/\s*\(\s*,\s*/g, ", ")
            .replace(/\s*\)\s*$/g, "")
        )
        .join(", ")
    : ""
)
  setInstructions(
  Array.isArray(data.instructions)
    ? data.instructions.join("\n\n")
    : ""
)

  if (data.image) {
    setImageUrl(data.image)
  }
}
  async function addRecipe() {
    

   if (recipeName.trim() === "" || ingredients.trim() === "") {
  alert("Please enter both a recipe name and ingredients.")
  return
}
 
    let uploadedImageUrl = imageUrl

if (imageFile) {
  uploadedImageUrl = await uploadRecipeImage(imageFile)
}

    let data, error

if (editingRecipeId) {
  const result = await supabase
    .from('recipes')
    .update({
      name: recipeName,
      ingredients,
      instructions,
      categories: selectedCategories,
      image_url: uploadedImageUrl,
    })
    .eq('id', (editingRecipeId))

    .select("*")
    

  data = result.data
  error = result.error

} else {

  const result = await supabase
    .from('recipes')
    .insert([
      {
        name: recipeName,
        ingredients,
        instructions,
        categories: selectedCategories,
        image_url: uploadedImageUrl,
        user_id: session.user.id
      }
    ])
    .select()

  data = result.data
  error = result.error
}

    if (error) {
      console.log(error)
      alert(error.message)
      return
    }

    await getRecipes()

setRecipeName("")
setSelectedCategories([])
setIngredients("")
setEditingRecipeId(null)
setCategory("Dinner")
setImageUrl("")
setImageFile(null)
window.location.reload()
  }

  async function deleteRecipe(id) {
    const { error } = await supabase.from('recipes').delete().eq('id', id)

    if (error) {
      console.log(error)
      return
    }

    setRecipes(recipes.filter((recipe) => recipe.id !== id))
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
    if (recipes.length === 0) return

    const meals = daysOfWeek.map((day) => {

  const existingMeal = weeklyMeals.find(
    (meal) => meal.day === day
  )

  if (lockedDays.includes(day) && existingMeal) {
    return existingMeal
  }

  const randomIndex = Math.floor(
    Math.random() * recipes.length
  )

  return {
    day,
    meal: recipes[randomIndex]
  }
})

    setWeeklyMeals(meals)
    createShoppingList(meals)
  }

 function regenerateMeal(dayToChange) {
  console.log("dayToChange:", dayToChange)
 console.log("lockedDays:", lockedDays) 
  if (recipes.length === 0) return
  

  if (lockedDays.includes(dayToChange)) {
    return
  }

  const updatedMeals = weeklyMeals.map((item) => {
    if (item.day === dayToChange) {
      const randomIndex = Math.floor(Math.random() * recipes.length)

      return {
        day: item.day,
        meal: recipes[randomIndex]
      }
    }

    return item
  })

  setWeeklyMeals(updatedMeals)
  createShoppingList(updatedMeals)
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

  const updatedMeals = weeklyMeals.map((item) =>
    item.day === today
      ? {
          ...item,
          meal: recipe
        }
      : item
  )

  setWeeklyMeals(updatedMeals)
  createShoppingList(updatedMeals)
}
function createShoppingList(meals) {
  const allIngredients = meals.flatMap((item) => item.meal.ingredients)

  const ingredientCounts = {}

  allIngredients.forEach((ingredient) => {
    ingredientCounts[ingredient] =
      (ingredientCounts[ingredient] || 0) + 1
  })

  const uniqueIngredients = [...new Set(allIngredients)]

  const categories = {
    Produce: [],
    Meat: [],
    Dairy: [],
    Pantry: [],
    Other: []
  }

  uniqueIngredients.forEach((ingredient) => {
    const item = ingredient.toLowerCase()

    const formattedIngredient =
      `${ingredient} (${ingredientCounts[ingredient]})`

    if (
      item.includes("lettuce") ||
      item.includes("tomato") ||
      item.includes("onion") ||
      item.includes("pepper") ||
      item.includes("potato") ||
      item.includes("carrot") ||
      item.includes("spinach") ||
      item.includes("avocado")
    ) {
      categories.Produce.push(formattedIngredient)

    } else if (
      item.includes("beef") ||
      item.includes("chicken") ||
      item.includes("pork") ||
      item.includes("turkey") ||
      item.includes("sausage") ||
      item.includes("bacon")
    ) {
      categories.Meat.push(formattedIngredient)

    } else if (
      item.includes("cheese") ||
      item.includes("milk") ||
      item.includes("cream") ||
      item.includes("yogurt") ||
      item.includes("butter")
    ) {
      categories.Dairy.push(formattedIngredient)

    } else if (
      item.includes("rice") ||
      item.includes("pasta") ||
      item.includes("noodle") ||
      item.includes("tortilla") ||
      item.includes("bread") ||
      item.includes("sauce") ||
      item.includes("beans")
    ) {
      categories.Pantry.push(formattedIngredient)

    } else {
      categories.Other.push(formattedIngredient)
    }
  })

  setShoppingList(categories)
}
const pantryMatches = recipes
  .map((recipe) => {
    const matchedIngredients = recipe.ingredients.filter((ingredient) =>
      pantryItems.some((item) =>
        ingredient.toLowerCase().includes(item.toLowerCase())
      )
    )

    return {
      ...recipe,
      matchedCount: matchedIngredients.length,
      totalCount: recipe.ingredients.length,
      matchPercentage: Math.round(
        (matchedIngredients.length / recipe.ingredients.length) * 100
      ),
      missingIngredients: recipe.ingredients.filter(
        (ingredient) =>
          !pantryItems.some((item) =>
            ingredient.toLowerCase().includes(item.toLowerCase())
          )
      )
    }
  })
  .filter((recipe) => recipe.matchedCount > 0)
  .sort((a, b) => b.matchPercentage - a.matchPercentage)
  const addMissingToShoppingList = (missingIngredients) => {
  setShoppingList((currentList) => {
    const updatedList = { ...currentList }

    if (!updatedList.Other) {
      updatedList.Other = []
    }

    missingIngredients.forEach((ingredient) => {
      if (!updatedList.Other.includes(ingredient)) {
        updatedList.Other.push(ingredient)
      }
    })

    return updatedList
  })
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

  return (
    <div className="app">
      <header className="hero">
        <h1>Dinnerlyst</h1>
        <p>Weekly meal planning made simple.</p>

        <div className="hero-stats">
          <p>{recipes.length} Recipes Saved </p>
          <p>Plan your week in seconds</p>
        </div>

        <button className="logout-button" onClick={logout}>
          Log Out
        </button>
      </header>
       <nav className="tab-nav">
  <button onClick={() => setActiveTab("planner")}>
    🍽️ Meal Planner
  </button>

  <button onClick={() => setActiveTab("recipes")}>
    📖 Recipes
  </button>

  <button onClick={() => setActiveTab("shopping")}>
    🛒 Shopping List
  </button>

  <button onClick={() => setActiveTab("pantry")}>
    🥫 Pantry
  </button>
</nav>


      <section className="card">
        <h2>Add a Recipe</h2>

        <div className="form">
        <div className="recipe-import">
  <input
    type="url"
    placeholder="Paste recipe URL"
    value={recipeUrl}
    onChange={(e) => setRecipeUrl(e.target.value)}
  />
 <button
  type="button"
  onClick={importRecipeFromUrl}
>
  Import Recipe
</button>
</div>
          <input
            type="text"
            placeholder="Recipe name"
            value={recipeName}
            onChange={(e) => setRecipeName(e.target.value)}
          />
          <input
  type="file"
  accept="image/*"
  onChange={(e) => setImageFile(e.target.files[0])}
/>
          
      <div>
  <strong>Categories</strong>

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
      style={{
        display: "inline-block",
        marginRight: "12px",
        marginTop: "8px",
      }}
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
      {" "}{cat}
    </label>
  ))}
</div> 
   

          <input
            type="text"
            placeholder="Ingredients separated by commas"
            value={ingredients}
            onChange={(e) => setIngredients(e.target.value)}
          />
          <textarea
  placeholder="Recipe instructions"
  value={instructions}
  onChange={(e) => setInstructions(e.target.value)}
  rows="6"
/>

          <button className="primary-button" onClick={addRecipe}>
            {editingRecipeId ? "Save Changes" : "Add Recipe"}
          </button>
        </div>
      </section>

      <section className="action-section">
        <button className="generate-button" onClick={generateWeeklyMeals}>
          🍽️ Generate Weekly Meals + Shopping List
        </button>
      </section>

      <main className="grid">
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
    recipes
      .filter((recipe) =>
        recipe.name.toLowerCase().includes(searchTerm.toLowerCase())
      )
      .filter((recipe) =>
        selectedCategory === "All" ||
        (recipe.categories || []).includes(selectedCategory)
      )
      .map((recipe) => (
        <div className="recipe-card" key={recipe.id}>
          {recipe.image_url && (
  <img
    src={recipe.image_url}
    alt={recipe.name}
    className="recipe-image"
  />
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
  {recipe.ingredients.map((ingredient, index) => (
    <li key={index}>{ingredient}</li>
  ))}
</ul>
{viewingRecipe?.id === recipe.id && (
  <div className="recipe-details">
    <h3>Instructions</h3>
    <p style={{ whiteSpace: "pre-line" }}>
      {recipe.instructions || "No instructions saved."}
    </p>
  </div>
)}
          </div>

          <div>
            <button
              className="small-button"
              onClick={() => {
                setRecipeName(recipe.name)
                setIngredients(recipe.ingredients.join(", "))
                setInstructions(recipe.instructions || "")
                setEditingRecipeId(recipe.id)
              }}
            >
              ✏️ Edit
            </button>
            <button
  className="small-button"
  type="button"
  onClick={() =>
    setViewingRecipe(
      viewingRecipe?.id === recipe.id ? null : recipe
    )
  }
>
  {viewingRecipe?.id === recipe.id ? "Hide Recipe" : "View Recipe"}
</button>

            <button
              className="delete-button"
              onClick={() => deleteRecipe(recipe.id)}
            >
              Delete
            </button>
          </div>
        </div>
      ))
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
  {pantryMatches[0]?.name || "Add pantry items to get a recommendation"}
</h3>

  <div className="progress-bar">
    <div
  className="progress-fill"
  style={{
    width: `${pantryMatches[0]?.matchPercentage || 0}%`
  }}
></div>
  </div>

  <p className="progress-text">
  {pantryMatches[0]
    ? pantryMatches[0].matchPercentage === 100
      ? "🎉 100% Ready — You can make this!"
      : `${pantryMatches[0].matchPercentage}% Ready`
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
  <p>✅ You have everything you need!</p>
)}
  {pantryMatches[0]?.missingIngredients?.length > 0 && (
  <button
    className="cook-button"
    onClick={() =>
      addMissingToShoppingList(pantryMatches[0].missingIngredients)
    }
  >
    🛒 Add Missing to Shopping List
  </button>
)}

<button
  className="cook-button"
  onClick={() => cookTonight(pantryMatches[0])}
>
  Cook Tonight
</button>
</div>
  <div className="section-header">
  <h2>This Week</h2>
  <p>Your planned meals at a glance.</p>
</div>

          {weeklyMeals.length === 0 && <p className="empty">Generate meals to see your week.</p>}
          <div className="meal-grid">

          {weeklyMeals.map((item, index) => (
            <div className="meal-card" key={index}>
  <div className="meal-info">
    <span className="meal-day">{item.day}</span>
    <h3>{item.meal.name}</h3>
  </div>

  <div className="meal-actions">
    <button className="small-button" onClick={() => regenerateMeal(item.day)}>
      🔄 Regenerate
    </button>

    <button
      className="small-button"
      onClick={() => toggleLock(item.day)}
    >
      {lockedDays.includes(item.day) ? "Unlock" : "Lock"}
    </button>
  </div>
</div>
          ))}
          </div>
        </section>
        )}
        {activeTab === "planner" && (
  <section className="card shopping-progress-card">
    <h2>🛒 Shopping Progress</h2>

    <p>
      {checkedShoppingItems.length} of{" "}
      {Object.values(shoppingList).flat().length} items checked
    </p>

    <div className="progress-track">
      <div
        className="progress-fill"
        style={{
          width: `${
            Object.values(shoppingList).flat().length > 0
              ? (checkedShoppingItems.length /
                  Object.values(shoppingList).flat().length) *
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
          <p>Checked items: {checkedShoppingItems.length}</p>

          {shoppingList.length === 0 && <p className="empty">Your grocery list will appear here.</p>}

          {Object.entries(shoppingList).map(([category, items]) => (
  items.length > 0 && (
    <div key={category}>
      <h3>{category}</h3>

      {items.map((ingredient, index) => (
        <div className="shopping-item" key={index}>
         <>
  <input
  type="checkbox"
  checked={checkedShoppingItems.includes(ingredient)}
  onChange={(e) => {
    if (e.target.checked) {
      setCheckedShoppingItems([
        ...checkedShoppingItems,
        ingredient
      ])
    } else {
      setCheckedShoppingItems(
        checkedShoppingItems.filter((item) => item !== ingredient)
      )
    }
  }}
/>
  {ingredient}
</> 
        </div>
      ))}
    </div>
  )
))}
        </section>
        )}
        {activeTab === "pantry" && (
  <section className="card">
    <h2>🥫 Pantry</h2>
 <input
  type="text"
  placeholder="Search ingredients..."
  value={pantrySearch}
  onChange={(e) => setPantrySearch(e.target.value)}
/>
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
    onClick={() => {
      if (!pantryItems.includes(item)) {
        setPantryItems([...pantryItems, item])
      }
      setPantrySearch("")
    }}
  >
    {item}
  </button>
))}
    <h3>Your Pantry</h3>
   <h3>Recipe Matches</h3>

{recipes
  .map((recipe) => {
    const matchedIngredients = recipe.ingredients.filter((ingredient) =>
      pantryItems.some((item) =>
        ingredient.toLowerCase().includes(item.toLowerCase())
      )
    )

   return {
  ...recipe,
  matchedCount: matchedIngredients.length,
  totalCount: recipe.ingredients.length,
  matchPercentage:
  Math.round(
    (matchedIngredients.length / recipe.ingredients.length) * 100
  ),
  missingIngredients: recipe.ingredients.filter(
    (ingredient) =>
      !pantryItems.some((item) =>
        ingredient.toLowerCase().includes(item.toLowerCase())
      )
  )
}
  })
  .filter((recipe) => recipe.matchedCount > 0)
  .sort((a, b) => b.matchedCount - a.matchedCount)
  .map((recipe) => (
    <div key={recipe.id} className="recipe-card">
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
    </div>
  ))}

{pantryItems.length === 0 ? (
  <p>No pantry items yet.</p>
) : (
  pantryItems.map((item) => (
  <span key={item} className="category-pill">
    {item}
    <button
      onClick={() =>
        setPantryItems(
          pantryItems.filter((pantryItem) => pantryItem !== item)
        )
      }
    >
      ✕
    </button>
  </span>
))
)}
  </section>
)}
      </main>
    </div>
  )
}

export default App
