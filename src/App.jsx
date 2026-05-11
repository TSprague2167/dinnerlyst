import { useEffect, useState } from "react"
import { supabase } from './supabase'
import './App.css'

function App() {
  const [recipes, setRecipes] = useState([])
  const [recipeName, setRecipeName] = useState("")
  const [ingredients, setIngredients] = useState("")
  const [weeklyMeals, setWeeklyMeals] = useState([])
  const [shoppingList, setShoppingList] = useState([])

  const daysOfWeek = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]

  useEffect(() => {
    getRecipes()
  }, [])

  async function getRecipes() {
    const { data, error } = await supabase.from('recipes').select('*')

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
      .insert([{ name: recipeName, ingredients }])
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

  return (
    <div className="app">
      <header className="hero">
        <h1>Dinnerlyst</h1>
        <p>Weekly meal planning made simple.</p>
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
