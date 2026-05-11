import { createClient } from '@supabase/supabase-js'

const supabaseUrl = 'https://qjlrqgefocsputtstgdl.supabase.co'
const supabaseKey = 'sb_publishable_EYLK1iarZoRp2tMia2TB0A_gxtzp2CZ'

export const supabase = createClient(supabaseUrl, supabaseKey)