const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
}

function findRecipe(value: any): any | null {
  if (!value) return null

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findRecipe(item)
      if (found) return found
    }
    return null
  }

  if (typeof value !== "object") return null

  const type = value["@type"]

  if (
    type === "Recipe" ||
    (Array.isArray(type) && type.includes("Recipe"))
  ) {
    return value
  }

  if (value["@graph"]) {
    const found = findRecipe(value["@graph"])
    if (found) return found
  }

  return null
}

function getInstructions(instructions: any): string[] {
  if (!instructions) return []

  if (typeof instructions === "string") {
    return [instructions]
  }

  if (!Array.isArray(instructions)) {
    return []
  }

  const steps: string[] = []

  for (const item of instructions) {
    if (typeof item === "string") {
      steps.push(item)
      continue
    }

    if (item?.text) {
      steps.push(item.text)
      continue
    }

    if (Array.isArray(item?.itemListElement)) {
      for (const step of item.itemListElement) {
        if (typeof step === "string") {
          steps.push(step)
        } else if (step?.text) {
          steps.push(step.text)
        }
      }
    }
  }

  return steps
}

function getImage(image: any): string {
  if (!image) return ""

  if (typeof image === "string") {
    return image
  }

  if (Array.isArray(image)) {
    const first = image[0]

    if (typeof first === "string") return first
    if (first?.url) return first.url
  }

  if (image?.url) {
    return image.url
  }

  return ""
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", {
      headers: corsHeaders,
    })
  }

  try {
    const { url } = await req.json()

    if (!url) {
      return new Response(
        JSON.stringify({
          error: "Recipe URL is required.",
        }),
        {
          status: 400,
          headers: {
            ...corsHeaders,
            "Content-Type": "application/json",
          },
        }
      )
    }

    const parsedUrl = new URL(url)

    if (
      parsedUrl.protocol !== "http:" &&
      parsedUrl.protocol !== "https:"
    ) {
      throw new Error("Only http and https URLs are allowed.")
    }

    const scrapingBeeApiKey = Deno.env.get("SCRAPINGBEE_API_KEY")

if (!scrapingBeeApiKey) {
  throw new Error("ScrapingBee API key is not configured.")
}

const scrapingBeeUrl = new URL(
  "https://app.scrapingbee.com/api/v1/"
)

scrapingBeeUrl.searchParams.set(
  "api_key",
  scrapingBeeApiKey
)

scrapingBeeUrl.searchParams.set(
  "url",
  parsedUrl.toString()
)

scrapingBeeUrl.searchParams.set(
  "render_js",
  "false"
)

const response = await fetch(scrapingBeeUrl.toString())

    if (!response.ok) {
      throw new Error(
        `Recipe website returned ${response.status}`
      )
    }

    const html = await response.text()

    const jsonLdBlocks = [
      ...html.matchAll(
        /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
      ),
    ]

    let recipe: any = null

    for (const match of jsonLdBlocks) {
      try {
        const data = JSON.parse(match[1].trim())
        recipe = findRecipe(data)

        if (recipe) break
      } catch {
        // Some sites contain malformed JSON-LD.
        // Skip those blocks and keep looking.
      }
    }

    if (!recipe) {
      return new Response(
        JSON.stringify({
          error:
            "I couldn't find structured recipe data on this page.",
        }),
        {
          status: 422,
          headers: {
            ...corsHeaders,
            "Content-Type": "application/json",
          },
        }
      )
    }

    const result = {
      name: recipe.name ?? "",
      ingredients: Array.isArray(recipe.recipeIngredient)
        ? recipe.recipeIngredient
        : [],
      instructions: getInstructions(
        recipe.recipeInstructions
      ),
      image: getImage(recipe.image),
      category:
        typeof recipe.recipeCategory === "string"
          ? recipe.recipeCategory
          : Array.isArray(recipe.recipeCategory)
          ? recipe.recipeCategory[0] ?? ""
          : "",
      sourceUrl: parsedUrl.toString(),
    }

    return new Response(JSON.stringify(result), {
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json",
      },
    })
  } catch (error) {
    console.error(error)

    return new Response(
      JSON.stringify({
        error:
          error instanceof Error
            ? error.message
            : "Recipe import failed.",
      }),
      {
        status: 500,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json",
        },
      }
    )
  }
})