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
  const [imageUrl, setImageUrl] = useState("")
  const [weeklyMeals, setWeeklyMeals] = useState(() => {
  const savedMeals = localStorage.getItem("weeklyMeals")
  return savedMeals ? JSON.parse(savedMeals) : []
})
  const [lockedDays, setLockedDays] = useState([])
  const [searchTerm, setSearchTerm] = useState("")
  const [category, setCategory] = useState("Dinner")
  const [shoppingList, setShoppingList] = useState([])
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

      <section className="card">
        <h2>Add a Recipe</h2>

        <div className="form">
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
            <p>{recipe.ingredients.join(", ")}</p>
          </div>

          <div>
            <button
              className="small-button"
              onClick={() => {
                setRecipeName(recipe.name)
                setIngredients(recipe.ingredients.join(", "))
                setEditingRecipeId(recipe.id)
              }}
            >
              ✏️ Edit
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

        <section className="card">
          <h2>🍽️Weekly Meal Plan</h2>

          {weeklyMeals.length === 0 && <p className="empty">Generate meals to see your week.</p>}

          {weeklyMeals.map((item, index) => (
            <div className="meal-card" key={index}>
              <div>
                <strong>{item.day}</strong>
                <p>{item.meal.name}</p>
              </div>

              <button className="small-button" onClick={() => regenerateMeal(item.day)}>
                🔄 Regenerate
              </button>
              <button className="small-button" onClick={() => toggleDayLock(item.day)}>
  {lockedDays.includes(item.day) ? "Unlock" : "Lock"}
</button>
            </div>
          ))}
        </section>

        <section className="card">
          <h2>🛒Shopping List</h2>

          {shoppingList.length === 0 && <p className="empty">Your grocery list will appear here.</p>}

          {Object.entries(shoppingList).map(([category, items]) => (
  items.length > 0 && (
    <div key={category}>
      <h3>{category}</h3>

      {items.map((ingredient, index) => (
        <div className="shopping-item" key={index}>
         <>
  <input type="checkbox" />
  {ingredient}
</> 
        </div>
      ))}
    </div>
  )
))}
        </section>
      </main>
    </div>
  )
}

export default App
