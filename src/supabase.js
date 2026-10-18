import { createClient } from '@supabase/supabase-js'

const supabaseUrl = 'https://qjlrqgefocsputtstgdl.supabase.co'
const supabaseKey = 'sb_publishable_EYLK1iarZoRp2tMia2TB0A_gxtzp2CZ'

// Capture callback intent before the SDK consumes the URL. Never retain callback tokens.
export const initialAuthCallbackType = (() => {
  if (typeof window === 'undefined') return null
  const type = new URLSearchParams(window.location.hash.slice(1)).get('type') ||
    new URLSearchParams(window.location.search).get('type')
  return type === 'invite' || type === 'recovery' ? type : null
})()

export const supabase = createClient(supabaseUrl, supabaseKey)
