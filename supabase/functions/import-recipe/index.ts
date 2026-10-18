import { createClient } from "npm:@supabase/supabase-js@2.105.4"

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
}

const IMPORT_TIMEOUT_MS = 30_000
const SCRAPER_TIMEOUT_MS = 25_000
const MAX_URL_LENGTH = 4096
const MAX_REQUEST_BYTES = 16 * 1024
const MAX_HTML_BYTES = 2 * 1024 * 1024

class ImportFailure extends Error {
  constructor(readonly status: number, readonly category: string, message: string) {
    super(message)
  }
}

function jsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "no-store" },
  })
}

function failureResponse(status: number, category: string, message: string) {
  // Never log exceptions, tokens, request URLs, or provider URLs containing credentials.
  console.error("recipe_import_failed", { category, status })
  return jsonResponse({ error: message }, status)
}

function isLocalTarget(hostname: string) {
  const host = hostname.toLowerCase().replace(/\.$/, "")
  // Conservatively reject literal IPv6, including IPv4-mapped local addresses.
  if (host.startsWith("[") || !host.includes(".")) return true
  if (["localhost", "local", "internal", "lan", "home"].some(suffix => host === suffix || host.endsWith(`.${suffix}`))) return true
  // URL parsing canonicalizes shorthand, octal, and integer IPv4 representations.
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    const [a, b] = host.split(".").map(Number)
    return a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) ||
      (a === 198 && (b === 18 || b === 19))
  }
  return false
}

async function readLimitedText(message: Request | Response, maxBytes: number, signal: AbortSignal) {
  if (Number(message.headers.get("content-length")) > maxBytes) {
    void message.body?.cancel().catch(() => {})
    throw new ImportFailure(413, "size_limit", "The import content is too large.")
  }
  const reader = message.body?.getReader()
  if (!reader) return ""
  const cancel = () => { void reader.cancel().catch(() => {}) }
  signal.addEventListener("abort", cancel, { once: true })
  const decoder = new TextDecoder()
  let bytes = 0
  let text = ""
  try {
    signal.throwIfAborted()
    while (true) {
      const { done, value } = await reader.read()
      signal.throwIfAborted()
      if (done) break
      bytes += value.byteLength
      if (bytes > maxBytes) {
        cancel()
        throw new ImportFailure(413, "size_limit", "The import content is too large.")
      }
      text += decoder.decode(value, { stream: true })
    }
    return text + decoder.decode()
  } finally {
    signal.removeEventListener("abort", cancel)
    reader.releaseLock()
  }
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

async function importRecipe(req: Request, signal: AbortSignal) {
  const authorization = req.headers.get("authorization") || ""
  const token = /^Bearer ([^\s]+)$/i.exec(authorization)?.[1]
  if (!token || token.length > 16_384 || !/^[^.]+\.[^.]+\.[^.]+$/.test(token)) {
    throw new ImportFailure(401, "unauthorized", "Sign in to import a recipe.")
  }
  const supabaseUrl = Deno.env.get("SUPABASE_URL")
  const supabaseKey = Deno.env.get("SUPABASE_ANON_KEY")
  if (!supabaseUrl || !supabaseKey) throw new ImportFailure(500, "configuration", "Recipe import is unavailable.")
  const supabase = createClient(supabaseUrl, supabaseKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: (input, init) => fetch(input, { ...init, signal }) },
  })
  // This asks Supabase Auth to validate the token; decoding claims alone is not authentication.
  const { data, error } = await supabase.auth.getUser(token)
  signal.throwIfAborted()
  if (error || !data.user?.id || data.user.role !== "authenticated" || data.user.is_anonymous) {
    throw new ImportFailure(401, "unauthorized", "Sign in to import a recipe.")
  }

  let body: unknown
  try {
    body = JSON.parse(await readLimitedText(req, MAX_REQUEST_BYTES, signal))
  } catch (error) {
    if (error instanceof ImportFailure || signal.aborted) throw error
    throw new ImportFailure(400, "invalid_request", "Enter a valid recipe URL.")
  }
  const url = body && typeof body === "object" && "url" in body ? body.url : null
  if (typeof url !== "string" || !url.trim() || url.length > MAX_URL_LENGTH) {
    throw new ImportFailure(400, "invalid_request", "Enter a valid recipe URL.")
  }
  let parsedUrl: URL
  try { parsedUrl = new URL(url) } catch {
    throw new ImportFailure(400, "invalid_request", "Enter a valid recipe URL.")
  }
  if (!["http:", "https:"].includes(parsedUrl.protocol) || parsedUrl.username || parsedUrl.password || isLocalTarget(parsedUrl.hostname)) {
    throw new ImportFailure(400, "invalid_request", "Use a public http or https recipe URL without embedded credentials.")
  }

  const scrapingBeeApiKey = Deno.env.get("SCRAPINGBEE_API_KEY")
  if (!scrapingBeeApiKey) throw new ImportFailure(500, "configuration", "Recipe import is unavailable.")
  const scrapingBeeUrl = new URL("https://app.scrapingbee.com/api/v1/")
  scrapingBeeUrl.searchParams.set("api_key", scrapingBeeApiKey)
  scrapingBeeUrl.searchParams.set("url", parsedUrl.toString())
  scrapingBeeUrl.searchParams.set("render_js", "false")
  scrapingBeeUrl.searchParams.set("timeout", String(SCRAPER_TIMEOUT_MS))

  let html: string
  try {
    const response = await fetch(scrapingBeeUrl.toString(), { signal })
    if (!response.ok) {
      void response.body?.cancel().catch(() => {})
      throw new ImportFailure(502, "provider_failure", "Could not retrieve that recipe page. Please try again.")
    }
    html = await readLimitedText(response, MAX_HTML_BYTES, signal)
  } catch (error) {
    if (error instanceof ImportFailure || signal.aborted) throw error
    throw new ImportFailure(502, "provider_failure", "Could not retrieve that recipe page. Please try again.")
  }

  const jsonLdBlocks = [...html.matchAll(
    /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
  )]
  let recipe: any = null
  for (const match of jsonLdBlocks) {
    try {
      recipe = findRecipe(JSON.parse(match[1].trim()))
      if (recipe) break
    } catch {
      // Skip malformed JSON-LD and keep looking, as before.
    }
  }
  if (!recipe) throw new ImportFailure(422, "no_recipe", "I couldn't find structured recipe data on this page.")
  signal.throwIfAborted()
  return jsonResponse({
    name: recipe.name ?? "",
    ingredients: Array.isArray(recipe.recipeIngredient) ? recipe.recipeIngredient : [],
    instructions: getInstructions(recipe.recipeInstructions),
    image: getImage(recipe.image),
    category: typeof recipe.recipeCategory === "string" ? recipe.recipeCategory :
      Array.isArray(recipe.recipeCategory) ? recipe.recipeCategory[0] ?? "" : "",
    sourceUrl: parsedUrl.toString(),
  })
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders })
  if (req.method !== "POST") return new Response(JSON.stringify({ error: "Use POST to import a recipe." }), {
    status: 405,
    headers: { ...corsHeaders, "Content-Type": "application/json", Allow: "POST, OPTIONS" },
  })

  const controller = new AbortController()
  let timeout: ReturnType<typeof setTimeout> | undefined
  // Race the entire operation so even a stalled auth call or request/body stream is bounded.
  const deadline = new Promise<Response>(resolve => {
    timeout = setTimeout(() => {
      controller.abort()
      resolve(failureResponse(504, "timeout", "Recipe import timed out. Please try again."))
    }, IMPORT_TIMEOUT_MS)
  })
  try {
    return await Promise.race([importRecipe(req, controller.signal), deadline])
  } catch (error) {
    if (controller.signal.aborted) return failureResponse(504, "timeout", "Recipe import timed out. Please try again.")
    if (error instanceof ImportFailure) return failureResponse(error.status, error.category, error.message)
    return failureResponse(500, "unexpected", "Recipe import failed. Please try again.")
  } finally {
    clearTimeout(timeout)
  }
})
