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
  const [weeklyMeals, setWeeklyMeals] = useState([])
  const [shoppingList, setShoppingList] = useState([])

  const daysOfWeek = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]

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
      ingredients: recipe.ingredients.split(",").map((item) => item.trim())
    }))

    setRecipes(savedRecipes)
  }

  async function addRecipe() {
    if (recipeName.trim() === "" || ingredients.trim() === "") return

    const { data, error } = await supabase
      .from('recipes')
     .insert([
  {
    name: recipeName,
    ingredients,
    user_id: session.user.id
  }
])
.select() 

    if (error) {
      console.log(error)
      return
    }

    const savedRecipe = {
      id: data[0].id,
      name: data[0].name,
      ingredients: data[0].ingredients.split(",").map((item) => item.trim())
    }

    setRecipes([...recipes, savedRecipe])
    setRecipeName("")
    setIngredients("")
  }

  async function deleteRecipe(id) {
    const { error } = await supabase.from('recipes').delete().eq('id', id)

    if (error) {
      console.log(error)
      return
    }

    setRecipes(recipes.filter((recipe) => recipe.id !== id))
  }

  function generateWeeklyMeals() {
    if (recipes.length === 0) return

    const meals = daysOfWeek.map((day) => {
      const randomIndex = Math.floor(Math.random() * recipes.length)
      return { day, meal: recipes[randomIndex] }
    })

    setWeeklyMeals(meals)
    createShoppingList(meals)
  }

  function regenerateMeal(dayToChange) {
    if (recipes.length === 0) return

    const updatedMeals = weeklyMeals.map((item) => {
      if (item.day === dayToChange) {
        const randomIndex = Math.floor(Math.random() * recipes.length)
        return { day: item.day, meal: recipes[randomIndex] }
      }

      return item
    })

    setWeeklyMeals(updatedMeals)
    createShoppingList(updatedMeals)
  }

  function createShoppingList(meals) {
    const allIngredients = meals.flatMap((item) => item.meal.ingredients)
    const uniqueIngredients = [...new Set(allIngredients)]
    setShoppingList(uniqueIngredients)
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
            type="text"
            placeholder="Ingredients separated by commas"
            value={ingredients}
            onChange={(e) => setIngredients(e.target.value)}
          />

          <button className="primary-button" onClick={addRecipe}>
            Add Recipe
          </button>
        </div>
      </section>

      <section className="action-section">
        <button className="generate-button" onClick={generateWeeklyMeals}>
          Generate Weekly Meals + Shopping List
        </button>
      </section>

      <main className="grid">
        <section className="card">
          <h2>Your Recipes</h2>

          {recipes.length === 0 && <p className="empty">No recipes yet.</p>}

          {recipes.map((recipe) => (
            <div className="recipe-card" key={recipe.id}>
              <div>
                <strong>{recipe.name}</strong>
                <p>{recipe.ingredients.join(", ")}</p>
              </div>

              <button className="delete-button" onClick={() => deleteRecipe(recipe.id)}>
                Delete
              </button>
            </div>
          ))}
        </section>

        <section className="card">
          <h2>Weekly Meal Plan</h2>

          {weeklyMeals.length === 0 && <p className="empty">Generate meals to see your week.</p>}

          {weeklyMeals.map((item, index) => (
            <div className="meal-card" key={index}>
              <div>
                <strong>{item.day}</strong>
                <p>{item.meal.name}</p>
              </div>

              <button className="small-button" onClick={() => regenerateMeal(item.day)}>
                Regenerate
              </button>
            </div>
          ))}
        </section>

        <section className="card">
          <h2>Shopping List</h2>

          {shoppingList.length === 0 && <p className="empty">Your grocery list will appear here.</p>}

          {shoppingList.map((ingredient, index) => (
            <div className="shopping-item" key={index}>
              {ingredient}
            </div>
          ))}
        </section>
      </main>
    </div>
  )
}

export default App
