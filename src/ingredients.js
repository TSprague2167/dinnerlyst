export const emptyIngredientRow = () => ({ amount: "", unit: "", ingredient: "" })

export function validateIngredientRows(input) {
  const rows = input.map((row) => ({
    amount: row.amount.trim(),
    unit: row.unit.trim(),
    ingredient: row.ingredient.trim(),
  })).filter((row) => row.amount || row.unit || row.ingredient)
  if (rows.some((row) => !row.ingredient)) {
    return { rows, error: "Enter an Ingredient for every nonblank row." }
  }
  return { rows, error: rows.length ? null : "Please enter at least one ingredient." }
}

export function formatIngredient(row) {
  return [row.amount, row.unit, row.ingredient].filter(Boolean).join(" ")
}

export function rowsFromIngredientStrings(input) {
  return (Array.isArray(input) ? input : [])
    .filter((item) => typeof item === "string" && item.trim())
    .map((ingredient) => ({ ...emptyIngredientRow(), ingredient: ingredient.trim() }))
}

// Normalize existing JSON shapes at the read boundary; builder rows remain strings.
export function normalizeStructuredIngredients(input) {
  if (!Array.isArray(input) || !input.length) return null
  const rows = []
  for (const row of input) {
    if (!row || typeof row !== "object") return null
    // Accept starter JSON and builder JSON; keep one internal row shape.
    const amount = row.amount ?? row.quantity ?? ""
    const ingredient = row.ingredient ?? row.item
    if (!(typeof amount === "string" || (typeof amount === "number" && Number.isFinite(amount))) ||
        typeof ingredient !== "string" || !ingredient.trim() ||
        (row.unit != null && typeof row.unit !== "string")) return null
    rows.push({ amount: String(amount).trim(), unit: (row.unit ?? "").trim(), ingredient: ingredient.trim() })
  }
  return rows
}

export function getIngredientRows(recipe) {
  const structured = normalizeStructuredIngredients(recipe.structured_ingredients)
  if (structured) return structured

  // Preserve the existing legacy comma/modifier handling without guessing quantities.
  if (Array.isArray(recipe.ingredients)) return rowsFromIngredientStrings(recipe.ingredients)
  const parts = (typeof recipe.ingredients === "string" ? recipe.ingredients : "")
    .split(",").map((item) => item.trim()).filter(Boolean)
  const modifiers = ["diced", "chopped", "minced", "sliced", "cubed", "shredded",
    "divided", "to taste", "bone-in", "boneless", "peeled", "crushed"]
  const combined = []
  parts.forEach((part) => {
    if (modifiers.includes(part.toLowerCase()) && combined.length) {
      combined[combined.length - 1] += `, ${part}`
    } else {
      combined.push(part)
    }
  })
  return rowsFromIngredientStrings(combined)
}
