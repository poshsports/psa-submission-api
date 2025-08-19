// api/_util/supabase.js
const { createClient } = require('@supabase/supabase-js');

let _client = null;
exports.sb = function sb() {
  if (_client) return _client;
  _client = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false } }
  );
  return _client;
};
