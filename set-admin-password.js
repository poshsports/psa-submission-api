import { createClient } from '@supabase/supabase-js';

const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const USER_ID = '531e4364-9454-4472-a182-48053dae9ef1'; // poshsportsbreakers@gmail.com
const NEW_PASSWORD = 'Bigalsucks1785!!'; // change this

await sb.auth.admin.updateUserById(USER_ID, {
  password: NEW_PASSWORD,
});

console.log('Password set for poshsportsbreakers@gmail.com');
